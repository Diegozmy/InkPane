#include "inkpane_net.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "esp_check.h"
#include "esp_http_client.h"
#include "esp_log.h"

static const char *TAG = "http";

typedef struct {
    char *body;
    size_t capacity;
    size_t length;
    bool overflow;
    char etag[INKPANE_ETAG_LEN];
    char date[40];
} http_context_t;

static void copy_header(char *dst, size_t size, const char *value)
{
    if (value == NULL) {
        return;
    }
    size_t length = strlen(value);
    if (length >= size) {
        length = size - 1;
    }
    memcpy(dst, value, length);
    dst[length] = '\0';
}

static esp_err_t http_event(esp_http_client_event_t *event)
{
    http_context_t *context = (http_context_t *)event->user_data;
    if (context == NULL) {
        return ESP_OK;
    }
    switch (event->event_id) {
    case HTTP_EVENT_ON_HEADER:
        if (event->header_key == NULL || event->header_value == NULL) {
            break;
        }
        if (strcasecmp(event->header_key, "ETag") == 0) {
            copy_header(context->etag, sizeof(context->etag), event->header_value);
        } else if (strcasecmp(event->header_key, "Date") == 0) {
            copy_header(context->date, sizeof(context->date), event->header_value);
        }
        break;
    case HTTP_EVENT_ON_DATA:
        if (event->data_len <= 0) {
            break;
        }
        if (context->length + (size_t)event->data_len + 1 > context->capacity) {
            ESP_LOGE(TAG, "response body exceeds %u bytes", (unsigned)context->capacity);
            context->overflow = true;
            return ESP_FAIL;
        }
        memcpy(context->body + context->length, event->data, (size_t)event->data_len);
        context->length += (size_t)event->data_len;
        context->body[context->length] = '\0';
        break;
    default:
        break;
    }
    return ESP_OK;
}

static void build_url(char *out, size_t size, const char *base, const char *path)
{
    size_t length = strlen(base);
    while (length > 0 && base[length - 1] == '/') {
        length--;
    }
    if (length >= size) {
        length = size - 1;
    }
    snprintf(out, size, "%.*s%s", (int)length, base, path);
}

static void append_float(char *out, size_t size, size_t *used, float value)
{
    int tenths = (int)(value >= 0 ? value * 10.0f + 0.5f : value * 10.0f - 0.5f);
    int whole = tenths / 10;
    int fraction = abs(tenths % 10);
    if (tenths < 0 && whole == 0) {
        *used += (size_t)snprintf(out + *used, size - *used, "-0.%d", fraction);
        return;
    }
    *used += (size_t)snprintf(out + *used, size - *used, "%d.%d", whole, fraction);
}

inkpane_http_result_t inkpane_http_fetch_screen(const char *api_url, const char *token,
                                                const char *etag, char *body, size_t body_capacity,
                                                size_t *body_length, char *etag_out, size_t etag_out_size,
                                                char *date_out, size_t date_out_size)
{
    if (api_url == NULL || token == NULL || body == NULL || body_capacity == 0) {
        return INKPANE_HTTP_FAILED;
    }
    http_context_t context = {
        .body = body,
        .capacity = body_capacity,
        .length = 0,
    };
    body[0] = '\0';

    char url[192];
    build_url(url, sizeof(url), api_url, "/api/device/screen");

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 8000,
        .event_handler = http_event,
        .user_data = &context,
        .buffer_size = 4096,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        return INKPANE_HTTP_FAILED;
    }
    esp_http_client_set_header(client, "X-Device-Token", token);
    esp_http_client_set_header(client, "Accept", "application/json");
    if (etag != NULL && etag[0] != '\0') {
        esp_http_client_set_header(client, "If-None-Match", etag);
    }

    esp_err_t err = esp_http_client_perform(client);
    int status = err == ESP_OK ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);

    if (context.overflow) {
        return INKPANE_HTTP_FAILED;
    }
    if (etag_out != NULL) {
        copy_header(etag_out, etag_out_size, context.etag);
    }
    if (date_out != NULL) {
        copy_header(date_out, date_out_size, context.date);
    }
    if (body_length != NULL) {
        *body_length = context.length;
    }

    if (status == 200) {
        return context.overflow ? INKPANE_HTTP_FAILED : INKPANE_HTTP_OK;
    }
    if (status == 304) {
        return INKPANE_HTTP_NOT_MODIFIED;
    }
    if (status == 401) {
        ESP_LOGW(TAG, "device token rejected");
        return INKPANE_HTTP_UNAUTHORIZED;
    }
    ESP_LOGW(TAG, "screen request failed: %s status=%d", esp_err_to_name(err), status);
    return INKPANE_HTTP_FAILED;
}

inkpane_http_result_t inkpane_http_post_telemetry(const char *api_url, const char *token,
                                                  float temperature, float humidity,
                                                  int battery_percent, int battery_millivolt, int rssi,
                                                  const char *firmware, uint32_t uptime_seconds)
{
    if (api_url == NULL || token == NULL) {
        return INKPANE_HTTP_FAILED;
    }
    char payload[384];
    size_t used = 0;
    used += (size_t)snprintf(payload + used, sizeof(payload) - used, "{");
    bool first = true;

    if (temperature > -100.0f) {
        used += (size_t)snprintf(payload + used, sizeof(payload) - used, "\"temperature\":");
        append_float(payload, sizeof(payload), &used, temperature);
        first = false;
    }
    if (humidity >= 0.0f) {
        used += (size_t)snprintf(payload + used, sizeof(payload) - used, "%s\"humidity\":",
                                 first ? "" : ",");
        append_float(payload, sizeof(payload), &used, humidity);
        first = false;
    }
    if (battery_percent >= 0) {
        used += (size_t)snprintf(payload + used, sizeof(payload) - used,
                                 "%s\"batteryPercent\":%d", first ? "" : ",", battery_percent);
        first = false;
    }
    if (battery_millivolt >= 0) {
        used += (size_t)snprintf(payload + used, sizeof(payload) - used,
                                 "%s\"batteryVoltage\":%d.%03d", first ? "" : ",",
                                 battery_millivolt / 1000, battery_millivolt % 1000);
        first = false;
    }
    if (rssi < 0) {
        used += (size_t)snprintf(payload + used, sizeof(payload) - used, "%s\"rssi\":%d",
                                 first ? "" : ",", rssi);
        first = false;
    }
    if (firmware != NULL && firmware[0] != '\0') {
        used += (size_t)snprintf(payload + used, sizeof(payload) - used,
                                 "%s\"firmware\":\"%s\"", first ? "" : ",", firmware);
        first = false;
    }
    used += (size_t)snprintf(payload + used, sizeof(payload) - used,
                             "%s\"uptimeSeconds\":%lu", first ? "" : ",", (unsigned long)uptime_seconds);
    snprintf(payload + used, sizeof(payload) - used, "}");

    char url[192];
    build_url(url, sizeof(url), api_url, "/api/device/telemetry");
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 5000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        return INKPANE_HTTP_FAILED;
    }
    esp_http_client_set_header(client, "X-Device-Token", token);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, payload, (int)strlen(payload));
    esp_err_t err = esp_http_client_perform(client);
    int status = err == ESP_OK ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    if (status == 200) {
        return INKPANE_HTTP_OK;
    }
    ESP_LOGW(TAG, "telemetry failed: %s status=%d", esp_err_to_name(err), status);
    return INKPANE_HTTP_FAILED;
}
