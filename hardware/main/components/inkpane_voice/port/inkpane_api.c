#include "inkpane_api.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#ifdef INKPANE_HOST_TEST

/*
 * Host unit tests link mcp_mock.c, which provides inkpane_api_init/request.
 * Keep this translation unit valid but empty so a build that compiles every
 * port source file does not define duplicate symbols.
 */
typedef int inkpane_api_host_build_placeholder;

#else

#include "esp_err.h"
#include "esp_http_client.h"
#include "esp_log.h"

#define TAG "inkpane_api"

typedef struct {
    char *body;
    size_t capacity;
    size_t length;
    bool overflow;
} api_context_t;

static char s_base_url[192];
static char s_token[64];

static void copy_str(char *dst, size_t size, const char *src)
{
    if (size == 0) {
        return;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return;
    }
    size_t length = strlen(src);
    if (length >= size) {
        length = size - 1;
    }
    memcpy(dst, src, length);
    dst[length] = '\0';
}

static void build_url(char *out, size_t size, const char *path)
{
    size_t length = strlen(s_base_url);
    while (length > 0 && s_base_url[length - 1] == '/') {
        length--;
    }
    snprintf(out, size, "%.*s%s", (int)length, s_base_url, path);
}

static esp_err_t api_http_event(esp_http_client_event_t *event)
{
    api_context_t *context = (api_context_t *)event->user_data;
    if (context == NULL || event->event_id != HTTP_EVENT_ON_DATA || event->data_len <= 0) {
        return ESP_OK;
    }
    if (context->body == NULL || context->capacity == 0) {
        return ESP_OK;
    }
    if (context->length + (size_t)event->data_len + 1 > context->capacity) {
        ESP_LOGE(TAG, "response body exceeds %u bytes", (unsigned)context->capacity);
        context->overflow = true;
        return ESP_FAIL;
    }
    memcpy(context->body + context->length, event->data, (size_t)event->data_len);
    context->length += (size_t)event->data_len;
    context->body[context->length] = '\0';
    return ESP_OK;
}

static bool method_from_text(const char *method, esp_http_client_method_t *out)
{
    if (method == NULL) {
        return false;
    }
    if (strcmp(method, "GET") == 0) {
        *out = HTTP_METHOD_GET;
    } else if (strcmp(method, "POST") == 0) {
        *out = HTTP_METHOD_POST;
    } else if (strcmp(method, "PUT") == 0) {
        *out = HTTP_METHOD_PUT;
    } else if (strcmp(method, "PATCH") == 0) {
        *out = HTTP_METHOD_PATCH;
    } else if (strcmp(method, "DELETE") == 0) {
        *out = HTTP_METHOD_DELETE;
    } else if (strcmp(method, "HEAD") == 0) {
        *out = HTTP_METHOD_HEAD;
    } else {
        return false;
    }
    return true;
}

void inkpane_api_init(const char *base_url, const char *token)
{
    copy_str(s_base_url, sizeof(s_base_url), base_url);
    copy_str(s_token, sizeof(s_token), token);
    ESP_LOGI(TAG, "device API base=%s token=%s", s_base_url[0] != '\0' ? s_base_url : "(unset)",
             s_token[0] != '\0' ? "(set)" : "(unset)");
}

int inkpane_api_request(const char *method, const char *path, const char *body,
                        char *resp, size_t resp_cap, int *status_code)
{
    if (status_code != NULL) {
        *status_code = -1;
    }
    if (resp != NULL && resp_cap > 0) {
        resp[0] = '\0';
    }
    if (method == NULL || path == NULL || path[0] != '/' || s_base_url[0] == '\0') {
        ESP_LOGE(TAG, "invalid request (method=%s path=%s base=%s)", method != NULL ? method : "?",
                 path != NULL ? path : "?", s_base_url);
        return INKPANE_API_ERR_INVALID;
    }

    esp_http_client_method_t http_method;
    if (!method_from_text(method, &http_method)) {
        ESP_LOGE(TAG, "unsupported HTTP method: %s", method);
        return INKPANE_API_ERR_INVALID;
    }

    char url[256];
    build_url(url, sizeof(url), path);
    if (strncasecmp(url, "https://", 8) == 0) {
        ESP_LOGE(TAG, "https is not supported by the device API client; use http:// on the LAN");
        return INKPANE_API_ERR_INVALID;
    }

    api_context_t context = {
        .body = resp,
        .capacity = resp != NULL ? resp_cap : 0,
        .length = 0,
        .overflow = false,
    };

    esp_http_client_config_t config = {
        .url = url,
        .method = http_method,
        .timeout_ms = INKPANE_API_TIMEOUT_MS,
        .event_handler = api_http_event,
        .user_data = &context,
        .buffer_size = 2048,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        ESP_LOGE(TAG, "failed to create HTTP client for %s", url);
        return INKPANE_API_ERR_TRANSPORT;
    }

    esp_http_client_set_header(client, "X-Device-Token", s_token);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "Accept", "application/json");
    if (body != NULL) {
        esp_http_client_set_post_field(client, body, (int)strlen(body));
    }

    esp_err_t err = esp_http_client_perform(client);
    int status = err == ESP_OK ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);

    if (context.overflow) {
        ESP_LOGE(TAG, "%s %s: response body truncated", method, path);
        if (resp != NULL && resp_cap > 0) {
            resp[resp_cap - 1] = '\0';
        }
        if (status_code != NULL) {
            *status_code = status;
        }
        return INKPANE_API_ERR_TOO_LARGE;
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s %s failed: %s", method, url, esp_err_to_name(err));
        return INKPANE_API_ERR_TRANSPORT;
    }
    if (status_code != NULL) {
        *status_code = status;
    }
    if (status < 200 || status >= 300) {
        ESP_LOGW(TAG, "%s %s -> HTTP %d", method, path, status);
    }
    return INKPANE_API_OK;
}

#endif /* INKPANE_HOST_TEST */
