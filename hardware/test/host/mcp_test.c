/*
 * Host unit tests for the InkPane MCP server / tools port layer.
 *
 * Built by hardware/test/host/CMakeLists.txt together with:
 *   - port/mcp_server.c, port/mcp_tools.c
 *   - inkpane_model/src/json.c
 *   - mcp_mock.c (fake inkpane_api_request)
 * No ESP-IDF dependency, plain C11.
 */

#include <stdio.h>
#include <string.h>

#include "inkpane_json.h"
#include "mcp_server.h"
#include "mcp_tools.h"

/* Host-test double, see mcp_mock.c. */
void mcp_mock_reset(void);
void mcp_mock_set_response(int status, const char *body);
void mcp_mock_set_failure(int result);
int mcp_mock_call_count(void);
const char *mcp_mock_last_method(void);
const char *mcp_mock_last_path(void);
const char *mcp_mock_last_body(void);

static int g_failures;

#define CHECK(condition)                                                               \
    do {                                                                               \
        if (!(condition)) {                                                            \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);                \
            g_failures++;                                                              \
        }                                                                              \
    } while (0)

#define CHECK_STR(actual, expected)                                                    \
    do {                                                                               \
        const char *a_ = (actual);                                                     \
        const char *e_ = (expected);                                                   \
        if (a_ == NULL || strcmp(a_, e_) != 0) {                                       \
            printf("FAIL %s:%d: \"%s\" != \"%s\"\n", __FILE__, __LINE__,               \
                   a_ != NULL ? a_ : "(null)", e_);                                    \
            g_failures++;                                                              \
        }                                                                              \
    } while (0)

#define CHECK_CONTAINS(haystack, needle)                                               \
    do {                                                                               \
        const char *h_ = (haystack);                                                   \
        if (h_ == NULL || strstr(h_, (needle)) == NULL) {                              \
            printf("FAIL %s:%d: \"%s\" does not contain \"%s\"\n", __FILE__, __LINE__, \
                   h_ != NULL ? h_ : "(null)", (needle));                              \
            g_failures++;                                                              \
        }                                                                              \
    } while (0)

/* ------------------------------------------------------------------ */
/* Capture / parse helpers                                             */
/* ------------------------------------------------------------------ */

static char g_sent[16384];
static int g_send_count;
static int g_send_result;

typedef struct {
    json_doc_t doc;
    char arena[16384];
} parsed_json_t;

static parsed_json_t g_parse_a;
static parsed_json_t g_parse_b;

static const json_value_t *parse_json(parsed_json_t *parsed, const char *text)
{
    if (text == NULL) {
        return NULL;
    }
    if (!json_parse(&parsed->doc, text, strlen(text), parsed->arena, sizeof(parsed->arena))) {
        return NULL;
    }
    return parsed->doc.root;
}

static int capture_send(void *ctx, const char *json, size_t len)
{
    (void)ctx;
    ++g_send_count;
    if (len >= sizeof(g_sent)) {
        len = sizeof(g_sent) - 1;
    }
    memcpy(g_sent, json, len);
    g_sent[len] = '\0';
    return g_send_result;
}

static void handle(mcp_server_t *server, const char *json)
{
    g_sent[0] = '\0';
    g_send_count = 0;
    mcp_server_handle_json(server, json, strlen(json));
}

static void call_tool(mcp_server_t *server, const char *name, const char *arguments_json)
{
    char request[1024];
    snprintf(request, sizeof(request),
             "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"%s\","
             "\"arguments\":%s}}",
             name, arguments_json != NULL ? arguments_json : "{}");
    handle(server, request);
}

static const json_value_t *result_of(const json_value_t *root)
{
    return json_object_get(root, "result");
}

static const char *result_tool_text(const json_value_t *root)
{
    const json_value_t *content = json_object_get(result_of(root), "content");
    return json_string(json_object_get(json_array_at(content, 0), "text"));
}

static bool result_is_error(const json_value_t *root)
{
    return json_bool(json_object_get(result_of(root), "isError"), false);
}

static int error_code(const json_value_t *root)
{
    return (int)json_number(json_object_get(json_object_get(root, "error"), "code"), 0);
}

static const char *error_message(const json_value_t *root)
{
    return json_string(json_object_get(json_object_get(root, "error"), "message"));
}

static const json_value_t *find_tool_entry(const json_value_t *tools, const char *name)
{
    const int count = json_array_size(tools);
    for (int i = 0; i < count; ++i) {
        const json_value_t *tool = json_array_at(tools, i);
        const char *tool_name = json_string(json_object_get(tool, "name"));
        if (tool_name != NULL && strcmp(tool_name, name) == 0) {
            return tool;
        }
    }
    return NULL;
}

static const json_value_t *list_tools(mcp_server_t *server)
{
    handle(server, "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}");
    CHECK(g_send_count == 1);
    const json_value_t *root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root == NULL) {
        return NULL;
    }
    return json_object_get(result_of(root), "tools");
}

/* ------------------------------------------------------------------ */
/* Environment hooks                                                   */
/* ------------------------------------------------------------------ */

static bool fixed_local_time(void *ctx, int *year, int *month, int *day, int *hour, int *minute,
                             int *second, int *offset_minutes)
{
    (void)ctx;
    *year = 2026;
    *month = 10;
    *day = 25;
    *hour = 20;
    *minute = 18;
    *second = 0;
    *offset_minutes = 480;
    return true;
}

static int g_mutations;

static void mutation_hook(void *ctx)
{
    (void)ctx;
    ++g_mutations;
}

static mcp_tools_env_t make_env(bool allow_control)
{
    mcp_tools_env_t env;
    memset(&env, 0, sizeof(env));
    env.allow_control = allow_control;
    env.get_local_time = fixed_local_time;
    env.timezone = "Asia/Shanghai";
    env.on_mutation = mutation_hook;
    return env;
}

static char g_status_json[512];

static int status_hook(char *json, size_t capacity)
{
    const size_t length = strlen(g_status_json);
    if (length + 1 > capacity) {
        return -1;
    }
    memcpy(json, g_status_json, length + 1);
    return (int)length;
}

static int g_last_volume = -1;

static int volume_hook(int volume)
{
    g_last_volume = volume;
    return 0;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

static void test_initialize(void)
{
    printf("== initialize ==\n");
    mcp_tools_env_t env = make_env(true);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    handle(server,
           "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\","
           "\"params\":{\"capabilities\":{}}}");
    CHECK(g_send_count == 1);
    const json_value_t *root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK_STR(json_string(json_object_get(root, "jsonrpc")), "2.0");
        CHECK((int)json_number(json_object_get(root, "id"), -1) == 1);
        const json_value_t *result = result_of(root);
        CHECK_STR(json_string(json_object_get(result, "protocolVersion")), "2024-11-05");
        const json_value_t *server_info = json_object_get(result, "serverInfo");
        CHECK_STR(json_string(json_object_get(server_info, "name")), "InkPane");
        CHECK(json_string(json_object_get(server_info, "version")) != NULL);
        CHECK(json_object_get(json_object_get(result, "capabilities"), "tools") != NULL);
    }

    /* String ids must be echoed as strings. */
    handle(server,
           "{\"jsonrpc\":\"2.0\",\"id\":\"abc\",\"method\":\"initialize\",\"params\":{}}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK_STR(json_string(json_object_get(root, "id")), "abc");
    }

    mcp_server_destroy(server);
}

static void test_tools_list(void)
{
    printf("== tools/list ==\n");
    mcp_tools_env_t env = make_env(true);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    const json_value_t *tools = list_tools(server);
    CHECK(tools != NULL);
    CHECK(json_array_size(tools) == 9);

    static const char *const kExpected[] = {
        "self.inkpane.context.get",      "self.inkpane.device.status",
        "self.inkpane.event.create",     "self.inkpane.event.cancel",
        "self.inkpane.todo.create",      "self.inkpane.todo.complete",
        "self.inkpane.todo.delete",      "self.inkpane.screen.refresh",
        "self.inkpane.volume.set",
    };
    for (size_t i = 0; i < sizeof(kExpected) / sizeof(kExpected[0]); ++i) {
        const json_value_t *tool = find_tool_entry(tools, kExpected[i]);
        CHECK(tool != NULL);
        const json_value_t *schema = json_object_get(tool, "inputSchema");
        CHECK(schema != NULL);
        CHECK_STR(json_string(json_object_get(schema, "type")), "object");
        CHECK(json_object_get(tool, "description") != NULL);
    }

    const json_value_t *create = find_tool_entry(tools, "self.inkpane.event.create");
    const json_value_t *schema = json_object_get(create, "inputSchema");
    const json_value_t *required = json_object_get(schema, "required");
    CHECK(json_array_size(required) == 3);
    CHECK(find_tool_entry(tools, "self.inkpane.event.create") != NULL);

    mcp_server_destroy(server);
}

static void test_tools_list_readonly(void)
{
    printf("== tools/list (allow_control=false) ==\n");
    mcp_tools_env_t env = make_env(false);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    const json_value_t *tools = list_tools(server);
    CHECK(tools != NULL);
    CHECK(json_array_size(tools) == 2);
    CHECK(find_tool_entry(tools, "self.inkpane.context.get") != NULL);
    CHECK(find_tool_entry(tools, "self.inkpane.device.status") != NULL);
    CHECK(find_tool_entry(tools, "self.inkpane.event.create") == NULL);
    CHECK(find_tool_entry(tools, "self.inkpane.volume.set") == NULL);

    /* Control tools must be rejected, not executed. */
    mcp_mock_reset();
    call_tool(server, "self.inkpane.event.create",
              "{\"title\":\"x\",\"date\":\"2026-10-25\",\"startTime\":\"10:00\"}");
    const json_value_t *root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(error_code(root) == -32602);
        CHECK_CONTAINS(error_message(root), "未知工具");
    }
    CHECK(mcp_mock_call_count() == 0);

    mcp_server_destroy(server);
}

static void test_context_get(void)
{
    printf("== tools/call context.get ==\n");
    mcp_tools_env_t env = make_env(false);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    static const char kBody[] = "{\"data\":{\"now\":{\"date\":\"2026-10-25\"}}}";
    mcp_mock_reset();
    mcp_mock_set_response(200, kBody);
    call_tool(server, "self.inkpane.context.get", NULL);

    const json_value_t *root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(!result_is_error(root));
        CHECK_STR(result_tool_text(root), kBody);
    }
    CHECK_STR(mcp_mock_last_method(), "GET");
    CHECK_STR(mcp_mock_last_path(), "/api/device/context");
    CHECK_STR(mcp_mock_last_body(), "");
    CHECK(mcp_mock_call_count() == 1);

    /* HTTP error -> tool error with Chinese text. */
    mcp_mock_reset();
    mcp_mock_set_response(500, "{\"error\":\"boom\"}");
    call_tool(server, "self.inkpane.context.get", NULL);
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "暂时不可用");
    }

    /* Transport error -> tool error. */
    mcp_mock_reset();
    mcp_mock_set_failure(-1);
    call_tool(server, "self.inkpane.context.get", NULL);
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "无法连接");
    }

    mcp_server_destroy(server);
}

static void test_event_create(void)
{
    printf("== tools/call event.create ==\n");
    mcp_tools_env_t env = make_env(true);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    mcp_mock_reset();
    mcp_mock_set_response(201, "{\"data\":{\"id\":99}}");
    call_tool(server, "self.inkpane.event.create",
              "{\"title\":\"团队周会\",\"date\":\"2026-10-25\",\"startTime\":\"20:18\","
              "\"durationMinutes\":90,\"location\":\"会议室 A\"}");

    CHECK_STR(mcp_mock_last_method(), "POST");
    CHECK_STR(mcp_mock_last_path(), "/api/device/events");
    CHECK(mcp_mock_call_count() == 1);

    const json_value_t *response = parse_json(&g_parse_a, g_sent);
    CHECK(response != NULL);
    if (response != NULL) {
        CHECK(!result_is_error(response));
    }

    const json_value_t *body = parse_json(&g_parse_b, mcp_mock_last_body());
    CHECK(body != NULL);
    if (body != NULL) {
        CHECK_STR(json_string(json_object_get(body, "title")), "团队周会");
        CHECK_STR(json_string(json_object_get(body, "startAt")), "2026-10-25T20:18:00+08:00");
        CHECK_STR(json_string(json_object_get(body, "endAt")), "2026-10-25T21:48:00+08:00");
        CHECK(json_bool(json_object_get(body, "allDay"), true) == false);
        CHECK_STR(json_string(json_object_get(body, "location")), "会议室 A");
    }

    /* Duration crossing midnight and a year boundary. */
    mcp_mock_reset();
    mcp_mock_set_response(201, "{}");
    call_tool(server, "self.inkpane.event.create",
              "{\"title\":\"跨年\",\"date\":\"2026-12-31\",\"startTime\":\"23:30\","
              "\"durationMinutes\":90}");
    body = parse_json(&g_parse_b, mcp_mock_last_body());
    CHECK(body != NULL);
    if (body != NULL) {
        CHECK_STR(json_string(json_object_get(body, "startAt")), "2026-12-31T23:30:00+08:00");
        CHECK_STR(json_string(json_object_get(body, "endAt")), "2027-01-01T01:00:00+08:00");
    }

    /* all-day event: plain date strings, no time required. */
    mcp_mock_reset();
    mcp_mock_set_response(201, "{}");
    call_tool(server, "self.inkpane.event.create",
              "{\"title\":\"国庆假期\",\"date\":\"2026-10-01\",\"allDay\":true}");
    body = parse_json(&g_parse_b, mcp_mock_last_body());
    CHECK(body != NULL);
    if (body != NULL) {
        CHECK_STR(json_string(json_object_get(body, "startAt")), "2026-10-01");
        CHECK_STR(json_string(json_object_get(body, "endAt")), "2026-10-01");
        CHECK(json_bool(json_object_get(body, "allDay"), false) == true);
    }

    /* Quotes, backslashes and control characters must be JSON-escaped. */
    static const char kRawTitle[] = "含\"引号\"和\\反斜杠\n换行";
    mcp_mock_reset();
    mcp_mock_set_response(201, "{}");
    call_tool(server, "self.inkpane.event.create",
              "{\"title\":\"含\\\"引号\\\"和\\\\反斜杠\\n换行\",\"date\":\"2026-10-25\","
              "\"startTime\":\"09:00\"}");
    body = parse_json(&g_parse_b, mcp_mock_last_body());
    CHECK(body != NULL);
    if (body != NULL) {
        CHECK_STR(json_string(json_object_get(body, "title")), kRawTitle);
    }

    /* Validation failures never reach the network. */
    mcp_mock_reset();
    call_tool(server, "self.inkpane.event.create",
              "{\"date\":\"2026-10-25\",\"startTime\":\"10:00\"}");
    const json_value_t *error = parse_json(&g_parse_a, g_sent);
    CHECK(error != NULL);
    if (error != NULL) {
        CHECK(result_is_error(error));
        CHECK_CONTAINS(result_tool_text(error), "title");
    }
    CHECK(mcp_mock_call_count() == 0);

    call_tool(server, "self.inkpane.event.create",
              "{\"title\":\"x\",\"date\":\"2026-10-32\",\"startTime\":\"10:00\"}");
    error = parse_json(&g_parse_a, g_sent);
    CHECK(error != NULL);
    if (error != NULL) {
        CHECK(result_is_error(error));
        CHECK_CONTAINS(result_tool_text(error), "date");
    }

    call_tool(server, "self.inkpane.event.create",
              "{\"title\":\"x\",\"date\":\"2026-10-25\",\"startTime\":\"25:00\"}");
    error = parse_json(&g_parse_a, g_sent);
    CHECK(error != NULL);
    if (error != NULL) {
        CHECK(result_is_error(error));
        CHECK_CONTAINS(result_tool_text(error), "startTime");
    }

    call_tool(server, "self.inkpane.event.create",
              "{\"title\":\"x\",\"date\":\"2026-10-25\",\"startTime\":\"10:00\","
              "\"durationMinutes\":0}");
    error = parse_json(&g_parse_a, g_sent);
    CHECK(error != NULL);
    if (error != NULL) {
        CHECK(result_is_error(error));
        CHECK_CONTAINS(result_tool_text(error), "durationMinutes");
    }
    CHECK(mcp_mock_call_count() == 0);

    mcp_server_destroy(server);
}

static void test_event_cancel(void)
{
    printf("== tools/call event.cancel ==\n");
    mcp_tools_env_t env = make_env(true);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    mcp_mock_reset();
    mcp_mock_set_response(204, "");
    call_tool(server, "self.inkpane.event.cancel", "{\"eventId\":99}");
    CHECK_STR(mcp_mock_last_method(), "DELETE");
    CHECK_STR(mcp_mock_last_path(), "/api/device/events/99");
    const json_value_t *root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(!result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "#99");
    }

    /* Numeric-string ids are accepted. */
    mcp_mock_reset();
    mcp_mock_set_response(204, "");
    call_tool(server, "self.inkpane.event.cancel", "{\"eventId\":\"7\"}");
    CHECK_STR(mcp_mock_last_path(), "/api/device/events/7");

    mcp_mock_reset();
    call_tool(server, "self.inkpane.event.cancel", "{\"eventId\":0}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "eventId");
    }
    CHECK(mcp_mock_call_count() == 0);

    mcp_server_destroy(server);
}

static void test_todo_tools(void)
{
    printf("== tools/call todo.* ==\n");
    mcp_tools_env_t env = make_env(true);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    mcp_mock_reset();
    mcp_mock_set_response(201, "{\"data\":{\"id\":5}}");
    call_tool(server, "self.inkpane.todo.create",
              "{\"title\":\"买牛奶\",\"dueDate\":\"2026-11-01\",\"priority\":\"high\"}");
    CHECK_STR(mcp_mock_last_method(), "POST");
    CHECK_STR(mcp_mock_last_path(), "/api/device/todos");
    const json_value_t *root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(!result_is_error(root));
    }
    const json_value_t *body = parse_json(&g_parse_b, mcp_mock_last_body());
    CHECK(body != NULL);
    if (body != NULL) {
        CHECK_STR(json_string(json_object_get(body, "title")), "买牛奶");
        CHECK_STR(json_string(json_object_get(body, "dueDate")), "2026-11-01");
        CHECK_STR(json_string(json_object_get(body, "priority")), "high");
    }

    mcp_mock_reset();
    call_tool(server, "self.inkpane.todo.create",
              "{\"title\":\"x\",\"priority\":\"critical\"}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "priority");
    }
    CHECK(mcp_mock_call_count() == 0);

    mcp_mock_reset();
    mcp_mock_set_response(200, "");
    call_tool(server, "self.inkpane.todo.complete", "{\"todoId\":42}");
    CHECK_STR(mcp_mock_last_method(), "PATCH");
    CHECK_STR(mcp_mock_last_path(), "/api/device/todos/42");
    CHECK_STR(mcp_mock_last_body(), "{\"done\":true}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(!result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "#42");
    }

    mcp_mock_reset();
    mcp_mock_set_response(204, "");
    call_tool(server, "self.inkpane.todo.delete", "{\"todoId\":42}");
    CHECK_STR(mcp_mock_last_method(), "DELETE");
    CHECK_STR(mcp_mock_last_path(), "/api/device/todos/42");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(!result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "#42");
    }

    mcp_server_destroy(server);
}

static void test_screen_refresh(void)
{
    printf("== tools/call screen.refresh ==\n");
    mcp_tools_env_t env = make_env(true);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    g_mutations = 0;
    call_tool(server, "self.inkpane.screen.refresh", NULL);
    const json_value_t *root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(!result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "刷新");
    }
    CHECK(g_mutations == 1);

    mcp_server_destroy(server);
}

static void test_device_status(void)
{
    printf("== tools/call device.status ==\n");
    mcp_tools_env_t env = make_env(false);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    /* No hook installed: minimal static JSON is still valid JSON. */
    mcp_tools_set_device_hooks(NULL, NULL);
    call_tool(server, "self.inkpane.device.status", NULL);
    json_value_t *root = (json_value_t *)parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(!result_is_error((const json_value_t *)root));
        const char *text = result_tool_text((const json_value_t *)root);
        CHECK(text != NULL);
        CHECK_CONTAINS(text, "inkpane-s3-epaper-3.97");
    }

    /* Installed hook: text is passed through (and JSON-escaped) verbatim. */
    strcpy(g_status_json, "{\"batteryPercent\":88,\"note\":\"a\\\"b\\\\c\"}");
    mcp_tools_set_device_hooks(status_hook, NULL);
    call_tool(server, "self.inkpane.device.status", NULL);
    root = (json_value_t *)parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(!result_is_error((const json_value_t *)root));
        CHECK_STR(result_tool_text((const json_value_t *)root), g_status_json);
    }

    mcp_tools_set_device_hooks(NULL, NULL);
    mcp_server_destroy(server);
}

static void test_volume(void)
{
    printf("== tools/call volume.set ==\n");
    mcp_tools_env_t env = make_env(true);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    mcp_tools_set_device_hooks(NULL, volume_hook);
    g_last_volume = -1;
    call_tool(server, "self.inkpane.volume.set", "{\"volume\":55}");
    const json_value_t *root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(!result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "55");
    }
    CHECK(g_last_volume == 55);

    mcp_mock_reset();
    call_tool(server, "self.inkpane.volume.set", "{\"volume\":101}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "volume");
    }

    mcp_tools_set_device_hooks(NULL, NULL);
    call_tool(server, "self.inkpane.volume.set", "{\"volume\":10}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(result_is_error(root));
        CHECK_CONTAINS(result_tool_text(root), "不可用");
    }

    mcp_server_destroy(server);
}

static void test_protocol_errors(void)
{
    printf("== JSON-RPC errors and notifications ==\n");
    mcp_tools_env_t env = make_env(true);
    mcp_server_t *server = mcp_server_create(capture_send, NULL, &env);
    CHECK(server != NULL);
    if (server == NULL) {
        return;
    }

    /* Parse error. */
    handle(server, "{\"jsonrpc\":\"2.0\",");
    CHECK(g_send_count == 1);
    const json_value_t *root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(error_code(root) == -32700);
    }

    /* Valid JSON but not an object. */
    handle(server, "[1,2,3]");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(error_code(root) == -32600);
    }

    /* Unknown method. */
    handle(server, "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"bogus/method\"}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(error_code(root) == -32601);
        CHECK_CONTAINS(error_message(root), "未实现");
    }

    /* Unknown tool. */
    call_tool(server, "self.inkpane.nope", NULL);
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(error_code(root) == -32602);
        CHECK_CONTAINS(error_message(root), "未知工具");
    }

    /* tools/call without a tool name. */
    handle(server,
           "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"arguments\":{}}}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(error_code(root) == -32602);
    }

    /* params of the wrong type. */
    handle(server, "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/list\",\"params\":[]}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(error_code(root) == -32602);
    }

    /* Notifications produce no response. */
    handle(server, "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}");
    CHECK(g_send_count == 0);
    handle(server, "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\"}");
    CHECK(g_send_count == 0);

    /* Wrong JSON-RPC version. */
    handle(server, "{\"jsonrpc\":\"1.0\",\"id\":8,\"method\":\"initialize\"}");
    root = parse_json(&g_parse_a, g_sent);
    CHECK(root != NULL);
    if (root != NULL) {
        CHECK(error_code(root) == -32600);
    }

    mcp_server_destroy(server);
}

static void test_json_escape(void)
{
    printf("== JSON escaping helper ==\n");
    char out[64];
    CHECK(mcp_tools_escape_json("a\"b\\c\nd\te", out, sizeof(out)) == 13);
    CHECK_STR(out, "a\\\"b\\\\c\\nd\\te");

    char small[4];
    CHECK(mcp_tools_escape_json("abcdef", small, sizeof(small)) == -1);

    char empty[4];
    CHECK(mcp_tools_escape_json("", empty, sizeof(empty)) == 0);
    CHECK_STR(empty, "");
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    test_initialize();
    test_tools_list();
    test_tools_list_readonly();
    test_context_get();
    test_event_create();
    test_event_cancel();
    test_todo_tools();
    test_screen_refresh();
    test_device_status();
    test_volume();
    test_protocol_errors();
    test_json_escape();

    if (g_failures == 0) {
        printf("all MCP host tests passed\n");
        return 0;
    }
    printf("%d MCP host test(s) failed\n", g_failures);
    return 1;
}
