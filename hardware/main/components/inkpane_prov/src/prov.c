#include "inkpane_prov.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "sdkconfig.h"

static const char *TAG = "prov";

#define PROV_TIMEOUT_SECONDS 600

static bool s_dns_stop;
static TaskHandle_t s_dns_task;

static const char PROV_PAGE[] =
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>InkPane 配网</title><style>"
    "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:24px;"
    "background:#f5f5f2;color:#222}"
    "main{max-width:420px;margin:0 auto;background:#fff;border-radius:14px;padding:24px;"
    "box-shadow:0 2px 12px rgba(0,0,0,.08)}"
    "h1{font-size:20px;margin:0 0 4px}p.sub{color:#666;font-size:13px;margin:0 0 20px}"
    "label{display:block;font-size:13px;margin:14px 0 6px;color:#333}"
    "input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d5d5cf;"
    "border-radius:8px;font-size:15px;background:#fbfbf9}"
    "button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;"
    "background:#1f1f1f;color:#fff;font-size:15px}"
    "small{display:block;color:#888;font-size:12px;margin-top:16px;line-height:1.6}"
    "</style></head><body><main>"
    "<h1>InkPane 墨窗</h1><p class=\"sub\">填写后设备会重启并开始拉取屏幕数据</p>"
    "<form method=\"POST\" action=\"/save\">"
    "<label>Wi-Fi 名称</label><input name=\"ssid\" list=\"aps\" required autocomplete=\"off\">"
    "<datalist id=\"aps\"></datalist>"
    "<label>Wi-Fi 密码（开放网络留空）</label>"
    "<input name=\"pass\" type=\"password\" autocomplete=\"off\">"
    "<label>服务地址</label><input name=\"api_url\" value=\"" CONFIG_INKPANE_API_URL "\" required>"
    "<label>设备令牌（32 位十六进制）</label>"
    "<input name=\"token\" maxlength=\"32\" pattern=\"[0-9a-fA-F]{32}\" required autocomplete=\"off\">"
    "<button type=\"submit\">保存并重启</button></form>"
    "<small>令牌在控制台「屏幕与设备 → 添加设备」创建时只显示一次；"
    "服务地址形如 http://192.168.1.10:4000 。</small>"
    "<script>fetch('/scan').then(r=>r.json()).then(list=>{const d=document.getElementById('aps');"
    "list.forEach(a=>{const o=document.createElement('option');o.value=a.ssid;d.appendChild(o)})})"
    ".catch(()=>{});</script></main></body></html>";

static const char SAVED_PAGE[] =
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>已保存</title>"
    "<style>body{font-family:system-ui,sans-serif;background:#f5f5f2;display:flex;height:100vh;"
    "margin:0;align-items:center;justify-content:center}div{background:#fff;padding:32px 40px;"
    "border-radius:14px;box-shadow:0 2px 12px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 8px}"
    "p{color:#666;font-size:14px;margin:0}</style></head><body><div><h1>已保存</h1>"
    "<p>设备正在重启，请稍等…</p></div></body></html>";

void inkpane_prov_ap_ssid(char *out, size_t size)
{
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP) != ESP_OK) {
        memset(mac, 0, sizeof(mac));
    }
    snprintf(out, size, "%s-%02X%02X%02X", CONFIG_INKPANE_AP_PREFIX, mac[3], mac[4], mac[5]);
}

static void dns_task(void *argument)
{
    (void)argument;
    int socket_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (socket_fd < 0) {
        s_dns_task = NULL;
        vTaskDelete(NULL);
        return;
    }
    struct timeval timeout = {.tv_sec = 1, .tv_usec = 0};
    setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_port = htons(53),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(socket_fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        ESP_LOGW(TAG, "dns bind failed");
        close(socket_fd);
        s_dns_task = NULL;
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "captive DNS listening");

    uint8_t buffer[512];
    while (!s_dns_stop) {
        struct sockaddr_in from;
        socklen_t from_length = sizeof(from);
        int length = recvfrom(socket_fd, buffer, sizeof(buffer), 0, (struct sockaddr *)&from,
                              &from_length);
        if (length < 12) {
            continue;
        }
        /* Copy the question section verbatim, then append one A answer. */
        int offset = 12;
        while (offset < length && buffer[offset] != 0) {
            offset += 1 + buffer[offset];
        }
        offset += 1;
        if (offset + 4 > length) {
            continue;
        }
        int question_end = offset + 4;
        if (question_end + 16 > (int)sizeof(buffer)) {
            continue;
        }
        uint8_t *response = buffer;
        response[2] = 0x81; /* QR=1, opcode 0, RD=1 */
        response[3] = 0x80; /* RA=1, rcode 0 */
        response[6] = 0x00;
        response[7] = 0x01; /* answer count = 1 */
        response[8] = 0x00;
        response[9] = 0x00;
        response[10] = 0x00;
        response[11] = 0x00;
        uint8_t *answer = response + question_end;
        answer[0] = 0xC0;
        answer[1] = 0x0C; /* pointer to question name */
        answer[2] = 0x00;
        answer[3] = 0x01; /* type A */
        answer[4] = 0x00;
        answer[5] = 0x01; /* class IN */
        answer[6] = 0x00;
        answer[7] = 0x00;
        answer[8] = 0x00;
        answer[9] = 0x3C; /* TTL 60 */
        answer[10] = 0x00;
        answer[11] = 0x04;
        answer[12] = 192;
        answer[13] = 168;
        answer[14] = 4;
        answer[15] = 1;
        sendto(socket_fd, response, question_end + 16, 0, (struct sockaddr *)&from, from_length);
    }
    close(socket_fd);
    s_dns_task = NULL;
    vTaskDelete(NULL);
}

static int hex_value(int ch)
{
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

static void url_decode(char *text)
{
    char *write = text;
    for (char *read = text; *read != '\0'; ++read) {
        if (*read == '+') {
            *write++ = ' ';
        } else if (*read == '%' && read[1] != '\0' && read[2] != '\0') {
            int high = hex_value((unsigned char)read[1]);
            int low = hex_value((unsigned char)read[2]);
            if (high >= 0 && low >= 0) {
                *write++ = (char)((high << 4) | low);
                read += 2;
            } else {
                *write++ = *read;
            }
        } else {
            *write++ = *read;
        }
    }
    *write = '\0';
}

static bool form_value(const char *body, const char *key, char *out, size_t out_size)
{
    size_t key_length = strlen(key);
    const char *cursor = body;
    while (cursor != NULL && *cursor != '\0') {
        const char *end = strchr(cursor, '&');
        size_t length = end != NULL ? (size_t)(end - cursor) : strlen(cursor);
        if (length > key_length && strncmp(cursor, key, key_length) == 0 &&
            cursor[key_length] == '=') {
            size_t value_length = length - key_length - 1;
            if (value_length >= out_size) {
                value_length = out_size - 1;
            }
            memcpy(out, cursor + key_length + 1, value_length);
            out[value_length] = '\0';
            url_decode(out);
            return true;
        }
        cursor = end != NULL ? end + 1 : NULL;
    }
    return false;
}

static bool valid_token(const char *token)
{
    if (token == NULL || strlen(token) != 32) {
        return false;
    }
    for (int i = 0; i < 32; ++i) {
        if (hex_value((unsigned char)token[i]) < 0) {
            return false;
        }
    }
    return true;
}

static esp_err_t root_handler(httpd_req_t *request)
{
    httpd_resp_set_type(request, "text/html; charset=utf-8");
    return httpd_resp_send(request, PROV_PAGE, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t scan_handler(httpd_req_t *request)
{
    wifi_scan_config_t scan = {0};
    char response[1024];
    size_t used = 0;
    used += (size_t)snprintf(response + used, sizeof(response) - used, "[");
    if (esp_wifi_scan_start(&scan, true) == ESP_OK) {
        uint16_t count = 16;
        wifi_ap_record_t records[16];
        if (esp_wifi_scan_get_ap_records(&count, records) == ESP_OK) {
            bool first = true;
            for (int i = 0; i < count && used < sizeof(response) - 96; ++i) {
                const char *ssid = (const char *)records[i].ssid;
                if (ssid[0] == '\0') {
                    continue;
                }
                used += (size_t)snprintf(response + used, sizeof(response) - used,
                                         "%s{\"ssid\":\"%s\",\"rssi\":%d}", first ? "" : ",", ssid,
                                         records[i].rssi);
                first = false;
            }
        }
    }
    snprintf(response + used, sizeof(response) - used, "]");
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_send(request, response, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t save_handler(httpd_req_t *request)
{
    char body[512];
    int received = httpd_req_recv(request, body, sizeof(body) - 1);
    if (received <= 0) {
        return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "empty body");
    }
    body[received] = '\0';

    inkpane_config_t config;
    memset(&config, 0, sizeof(config));
    config.refresh_minutes = 30;
    config.utc_offset_minutes = 480;
    if (!form_value(body, "ssid", config.ssid, sizeof(config.ssid)) ||
        !form_value(body, "api_url", config.api_url, sizeof(config.api_url)) ||
        !form_value(body, "token", config.token, sizeof(config.token))) {
        return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "missing fields");
    }
    form_value(body, "pass", config.password, sizeof(config.password));

    if (config.ssid[0] == '\0' || config.api_url[0] == '\0' || !valid_token(config.token)) {
        return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "invalid fields");
    }
    for (int i = 0; config.token[i] != '\0'; ++i) {
        if (config.token[i] >= 'A' && config.token[i] <= 'F') {
            config.token[i] = (char)(config.token[i] - 'A' + 'a');
        }
    }
    if (strncmp(config.api_url, "http://", 7) != 0) {
        return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "api_url must start with http://");
    }

    ESP_LOGI(TAG, "provisioning: ssid=%s url=%s", config.ssid, config.api_url);
    inkpane_config_erase();
    esp_err_t err = inkpane_config_save(&config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "save failed: %s", esp_err_to_name(err));
        return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "nvs write failed");
    }
    httpd_resp_set_type(request, "text/html; charset=utf-8");
    httpd_resp_send(request, SAVED_PAGE, HTTPD_RESP_USE_STRLEN);
    vTaskDelay(pdMS_TO_TICKS(1200));
    esp_restart();
    return ESP_OK;
}

static esp_err_t redirect_handler(httpd_req_t *request)
{
    httpd_resp_set_status(request, "302 Found");
    httpd_resp_set_hdr(request, "Location", "http://192.168.4.1/");
    return httpd_resp_send(request, "", 0);
}

static esp_err_t start_ap(const char *ssid)
{
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif");
    esp_err_t err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        return err;
    }
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init), TAG, "wifi init");

    wifi_config_t config = {0};
    strncpy((char *)config.ap.ssid, ssid, sizeof(config.ap.ssid) - 1);
    config.ap.ssid_len = (uint8_t)strlen(ssid);
    config.ap.channel = 6;
    config.ap.max_connection = 2;
    config.ap.authmode = WIFI_AUTH_OPEN;

    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_APSTA), TAG, "mode");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_AP, &config), TAG, "config");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "start");
    ESP_LOGI(TAG, "AP %s started", ssid);
    return ESP_OK;
}

static void start_dns(void)
{
    s_dns_stop = false;
    xTaskCreate(dns_task, "prov_dns", 4096, NULL, 4, &s_dns_task);
}

static void start_http(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.max_uri_handlers = 8;
    config.stack_size = 8192;
    config.lru_purge_enable = true;

    httpd_handle_t server = NULL;
    ESP_ERROR_CHECK(httpd_start(&server, &config));

    const httpd_uri_t root = {.uri = "/", .method = HTTP_GET, .handler = root_handler};
    const httpd_uri_t scan = {.uri = "/scan", .method = HTTP_GET, .handler = scan_handler};
    const httpd_uri_t save = {.uri = "/save", .method = HTTP_POST, .handler = save_handler};
    const httpd_uri_t generate204 = {
        .uri = "/generate_204", .method = HTTP_GET, .handler = redirect_handler};
    const httpd_uri_t hotspot = {
        .uri = "/hotspot-detect.html", .method = HTTP_GET, .handler = redirect_handler};
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &root));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &scan));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &save));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &generate204));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &hotspot));
    ESP_LOGI(TAG, "http://192.168.4.1 ready");
}

void inkpane_prov_run(const char *ap_ssid)
{
    if (ap_ssid == NULL || ap_ssid[0] == '\0') {
        ap_ssid = "InkPane-Setup";
    }
    if (start_ap(ap_ssid) != ESP_OK) {
        ESP_LOGE(TAG, "cannot start AP, rebooting");
        vTaskDelay(pdMS_TO_TICKS(1000));
        esp_restart();
    }
    start_dns();
    start_http();

    for (int elapsed = 0; elapsed < PROV_TIMEOUT_SECONDS; ++elapsed) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    ESP_LOGW(TAG, "provisioning timed out");
    s_dns_stop = true;
    esp_restart();
}
