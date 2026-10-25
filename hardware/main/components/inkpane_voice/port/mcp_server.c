#include "mcp_server.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "inkpane_json.h"
#include "mcp_tools.h"

#ifdef INKPANE_HOST_TEST
#define MCP_LOGW(...) ((void)0)
#define MCP_LOGE(...) ((void)0)
#else
#include "esp_log.h"
static const char *TAG = "mcp";
#define MCP_LOGW(...) ESP_LOGW(TAG, __VA_ARGS__)
#define MCP_LOGE(...) ESP_LOGE(TAG, __VA_ARGS__)
#endif

#ifndef MCP_SERVER_INFO_NAME
#define MCP_SERVER_INFO_NAME "InkPane"
#endif
#ifndef MCP_SERVER_INFO_VERSION
#define MCP_SERVER_INFO_VERSION "1.0.0"
#endif

#define MCP_PROTOCOL_VERSION "2024-11-05"

#define MCP_REQUEST_MAX 2048
#define MCP_ARENA_MAX 4096
#define MCP_RESPONSE_MAX 8192
#define MCP_ID_MAX 96

/* JSON-RPC 2.0 error codes. */
#define MCP_ERR_PARSE (-32700)
#define MCP_ERR_INVALID_REQUEST (-32600)
#define MCP_ERR_METHOD_NOT_FOUND (-32601)
#define MCP_ERR_INVALID_PARAMS (-32602)
#define MCP_ERR_INTERNAL (-32603)

struct mcp_server {
    mcp_send_fn send;
    void *send_ctx;
    mcp_tools_env_t env;

    char request[MCP_REQUEST_MAX];
    char arena[MCP_ARENA_MAX];
    char response[MCP_RESPONSE_MAX];
    char tool_text[MCP_TOOLS_TEXT_MAX];
};

/* ------------------------------------------------------------------ */
/* Output buffer                                                       */
/* ------------------------------------------------------------------ */

typedef struct {
    char *data;
    size_t capacity;
    size_t length;
    bool overflow;
} sbuf_t;

static void sbuf_init(sbuf_t *buffer, char *data, size_t capacity)
{
    buffer->data = data;
    buffer->capacity = capacity;
    buffer->length = 0;
    buffer->overflow = capacity == 0;
    if (capacity > 0) {
        data[0] = '\0';
    }
}

static void sbuf_append(sbuf_t *buffer, const char *text)
{
    if (buffer->overflow || text == NULL) {
        return;
    }
    const size_t length = strlen(text);
    if (buffer->length + length + 1 > buffer->capacity) {
        buffer->overflow = true;
        return;
    }
    memcpy(buffer->data + buffer->length, text, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
}

static void sbuf_appendf(sbuf_t *buffer, const char *format, ...)
{
    if (buffer->overflow) {
        return;
    }
    char temporary[256];
    va_list args;
    va_start(args, format);
    const int written = vsnprintf(temporary, sizeof(temporary), format, args);
    va_end(args);
    if (written < 0 || (size_t)written >= sizeof(temporary)) {
        buffer->overflow = true;
        return;
    }
    sbuf_append(buffer, temporary);
}

/** Escape `text` as JSON string content directly into the output buffer. */
static bool sbuf_append_escaped(sbuf_t *buffer, const char *text)
{
    if (buffer->overflow) {
        return false;
    }
    const int written =
        mcp_tools_escape_json(text, buffer->data + buffer->length, buffer->capacity - buffer->length);
    if (written < 0) {
        buffer->overflow = true;
        return false;
    }
    buffer->length += (size_t)written;
    return true;
}

static void send_json(mcp_server_t *server, const char *json, size_t length)
{
    if (server->send == NULL) {
        return;
    }
    const int result = server->send(server->send_ctx, json, length);
    if (result != 0) {
        MCP_LOGW("MCP send callback failed (%d)", result);
    }
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

static void send_error_message(mcp_server_t *server, const char *id_json, int code,
                               const char *message)
{
    sbuf_t out;
    sbuf_init(&out, server->response, sizeof(server->response));
    sbuf_append(&out, "{\"jsonrpc\":\"2.0\",\"id\":");
    sbuf_append(&out, id_json != NULL ? id_json : "null");
    sbuf_appendf(&out, ",\"error\":{\"code\":%d,\"message\":\"", code);
    if (!sbuf_append_escaped(&out, message != NULL ? message : "")) {
        /* The message itself cannot fit: emit a fixed minimal error instead. */
        const char *fallback = "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,"
                               "\"message\":\"Internal error\"}}";
        send_json(server, fallback, strlen(fallback));
        return;
    }
    sbuf_append(&out, "\"}}");
    if (out.overflow) {
        const char *fallback = "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,"
                               "\"message\":\"Internal error\"}}";
        send_json(server, fallback, strlen(fallback));
        return;
    }
    send_json(server, out.data, out.length);
}

static void send_result(mcp_server_t *server, const char *id_json, const char *result_json)
{
    sbuf_t out;
    sbuf_init(&out, server->response, sizeof(server->response));
    sbuf_append(&out, "{\"jsonrpc\":\"2.0\",\"id\":");
    sbuf_append(&out, id_json);
    sbuf_append(&out, ",\"result\":");
    sbuf_append(&out, result_json);
    sbuf_append(&out, "}");
    if (out.overflow) {
        send_error_message(server, id_json, MCP_ERR_INTERNAL, "响应超出缓冲区");
        return;
    }
    send_json(server, out.data, out.length);
}

static void send_tool_result(mcp_server_t *server, const char *id_json, const char *text,
                             bool is_error)
{
    sbuf_t out;
    sbuf_init(&out, server->response, sizeof(server->response));
    sbuf_append(&out, "{\"jsonrpc\":\"2.0\",\"id\":");
    sbuf_append(&out, id_json);
    sbuf_append(&out, ",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"");
    sbuf_append_escaped(&out, text != NULL ? text : "");
    sbuf_appendf(&out, "\"}],\"isError\":%s}}", is_error ? "true" : "false");
    if (out.overflow) {
        send_error_message(server, id_json, MCP_ERR_INTERNAL, "工具结果超出缓冲区");
        return;
    }
    send_json(server, out.data, out.length);
}

/* ------------------------------------------------------------------ */
/* Request parsing helpers                                             */
/* ------------------------------------------------------------------ */

/** Render the JSON-RPC id as raw JSON into id_json; false when invalid. */
static bool format_id(const json_value_t *id, char *id_json, size_t id_json_size)
{
    if (id == NULL || id->type == JSON_NULL) {
        snprintf(id_json, id_json_size, "null");
        return true;
    }
    if (id->type == JSON_NUMBER) {
        const double number = id->number;
        if (number < -9007199254740992.0 || number > 9007199254740992.0) {
            return false;
        }
        const long long integer = (long long)number;
        if ((double)integer == number) {
            snprintf(id_json, id_json_size, "%lld", integer);
        } else {
            snprintf(id_json, id_json_size, "%.17g", number);
        }
        return true;
    }
    if (id->type == JSON_STRING) {
        const int written =
            mcp_tools_escape_json(id->string, id_json + 1, id_json_size - 3);
        if (written < 0) {
            return false;
        }
        id_json[0] = '"';
        id_json[written + 1] = '"';
        id_json[written + 2] = '\0';
        return true;
    }
    return false;
}

/** Is this a valid JSON-RPC 2.0 version string? */
static bool is_jsonrpc_2(const json_value_t *root)
{
    const char *version = json_string(json_object_get(root, "jsonrpc"));
    return version != NULL && strcmp(version, "2.0") == 0;
}

/* ------------------------------------------------------------------ */
/* Method handlers                                                     */
/* ------------------------------------------------------------------ */

static void handle_initialize(mcp_server_t *server, const char *id_json)
{
    static const char kResult[] = "{\"protocolVersion\":\"" MCP_PROTOCOL_VERSION
                                  "\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{"
                                  "\"name\":\"" MCP_SERVER_INFO_NAME "\",\"version\":\""
                                  MCP_SERVER_INFO_VERSION "\"}}";
    send_result(server, id_json, kResult);
}

static void handle_tools_list(mcp_server_t *server, const char *id_json)
{
    sbuf_t out;
    sbuf_init(&out, server->response, sizeof(server->response));
    sbuf_append(&out, "{\"jsonrpc\":\"2.0\",\"id\":");
    sbuf_append(&out, id_json);
    sbuf_append(&out, ",\"result\":");
    const int written = mcp_tools_list_json(
        server->env.allow_control, out.data + out.length, out.capacity - out.length);
    if (written < 0) {
        send_error_message(server, id_json, MCP_ERR_INTERNAL, "工具列表超出缓冲区");
        return;
    }
    out.length += (size_t)written;
    sbuf_append(&out, "}");
    if (out.overflow) {
        send_error_message(server, id_json, MCP_ERR_INTERNAL, "工具列表超出缓冲区");
        return;
    }
    send_json(server, out.data, out.length);
}

static void handle_tools_call(mcp_server_t *server, const char *id_json,
                              const json_value_t *params)
{
    if (params == NULL || params->type != JSON_OBJECT) {
        send_error_message(server, id_json, MCP_ERR_INVALID_PARAMS, "缺少 params 对象");
        return;
    }
    const char *name = json_string(json_object_get(params, "name"));
    if (name == NULL || name[0] == '\0') {
        send_error_message(server, id_json, MCP_ERR_INVALID_PARAMS, "缺少工具名称 name");
        return;
    }
    const json_value_t *arguments = json_object_get(params, "arguments");
    if (arguments != NULL && arguments->type != JSON_OBJECT && arguments->type != JSON_NULL) {
        send_error_message(server, id_json, MCP_ERR_INVALID_PARAMS,
                           "参数 arguments 必须是对象");
        return;
    }
    if (!mcp_tools_is_known(name, server->env.allow_control)) {
        char message[192];
        snprintf(message, sizeof(message), "未知工具：%s", name);
        send_error_message(server, id_json, MCP_ERR_INVALID_PARAMS, message);
        return;
    }

    server->tool_text[0] = '\0';
    const int result = mcp_tools_call(&server->env, name, arguments, server->tool_text,
                                      sizeof(server->tool_text));
    send_tool_result(server, id_json, server->tool_text, result != 0);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

mcp_server_t *mcp_server_create(mcp_send_fn send, void *send_ctx, const mcp_tools_env_t *env)
{
    mcp_server_t *server = (mcp_server_t *)calloc(1, sizeof(mcp_server_t));
    if (server == NULL) {
        return NULL;
    }
    server->send = send;
    server->send_ctx = send_ctx;
    if (env != NULL) {
        server->env = *env;
    } else {
        memset(&server->env, 0, sizeof(server->env));
    }
    return server;
}

void mcp_server_set_env(mcp_server_t *server, const mcp_tools_env_t *env)
{
    if (server == NULL) {
        return;
    }
    if (env != NULL) {
        server->env = *env;
    } else {
        memset(&server->env, 0, sizeof(server->env));
    }
}

void mcp_server_destroy(mcp_server_t *server)
{
    free(server);
}

void mcp_server_handle_json(mcp_server_t *server, const char *payload, size_t len)
{
    if (server == NULL) {
        return;
    }
    if (payload == NULL || len == 0) {
        send_error_message(server, "null", MCP_ERR_PARSE, "空请求");
        return;
    }
    if (len >= sizeof(server->request)) {
        send_error_message(server, "null", MCP_ERR_INVALID_REQUEST, "请求过大");
        return;
    }
    memcpy(server->request, payload, len);
    server->request[len] = '\0';

    json_doc_t document = {};
    if (!json_parse(&document, server->request, len, server->arena, sizeof(server->arena)) ||
        document.root == NULL) {
        send_error_message(server, "null", MCP_ERR_PARSE, "无法解析 JSON");
        return;
    }
    const json_value_t *root = document.root;
    if (root->type != JSON_OBJECT) {
        send_error_message(server, "null", MCP_ERR_INVALID_REQUEST, "请求必须是 JSON 对象");
        return;
    }

    const json_value_t *id_value = json_object_get(root, "id");
    if (!is_jsonrpc_2(root)) {
        send_error_message(server, "null", MCP_ERR_INVALID_REQUEST,
                           "不支持的 JSON-RPC 版本（需要 2.0）");
        return;
    }

    const char *method = json_string(json_object_get(root, "method"));
    if (method == NULL || method[0] == '\0') {
        send_error_message(server, "null", MCP_ERR_INVALID_REQUEST, "缺少 method");
        return;
    }

    /* Notifications (no id, or a "notifications/…" method) never get a response. */
    if (id_value == NULL || strncmp(method, "notifications/", 14) == 0) {
        return;
    }

    char id_json[MCP_ID_MAX];
    if (!format_id(id_value, id_json, sizeof(id_json))) {
        send_error_message(server, "null", MCP_ERR_INVALID_REQUEST,
                           "id 必须是数字或字符串");
        return;
    }

    const json_value_t *params = json_object_get(root, "params");
    if (params != NULL && params->type != JSON_OBJECT) {
        send_error_message(server, id_json, MCP_ERR_INVALID_PARAMS, "params 必须是对象");
        return;
    }

    if (strcmp(method, "initialize") == 0) {
        handle_initialize(server, id_json);
    } else if (strcmp(method, "tools/list") == 0) {
        handle_tools_list(server, id_json);
    } else if (strcmp(method, "tools/call") == 0) {
        handle_tools_call(server, id_json, params);
    } else {
        char message[192];
        snprintf(message, sizeof(message), "未实现的方法：%s", method);
        send_error_message(server, id_json, MCP_ERR_METHOD_NOT_FOUND, message);
    }
}
