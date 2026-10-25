#include "voice_ota.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <strings.h>

#include <esp_chip_info.h>
#include <esp_crt_bundle.h>
#include <esp_err.h>
#include <esp_heap_caps.h>
#include <esp_http_client.h>
#include <esp_log.h>
#include <esp_netif.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_wifi.h>
#include <sdkconfig.h>

#include "inkpane_json.h"

#define TAG "voice_ota"

namespace {

constexpr int kHttpTimeoutMs = 10000;
constexpr size_t kMaxResponseBytes = 8192;
constexpr size_t kParseArenaBytes = 8192;

struct HttpResponse {
    int status = -1;
    bool overflow = false;
    std::string body;
};

void AppendJsonString(std::string &out, const char *value)
{
    out.push_back('"');
    if (value != nullptr) {
        for (const unsigned char *cursor = reinterpret_cast<const unsigned char *>(value);
             *cursor != '\0'; ++cursor) {
            switch (*cursor) {
            case '"':
                out.append("\\\"");
                break;
            case '\\':
                out.append("\\\\");
                break;
            case '\b':
                out.append("\\b");
                break;
            case '\f':
                out.append("\\f");
                break;
            case '\n':
                out.append("\\n");
                break;
            case '\r':
                out.append("\\r");
                break;
            case '\t':
                out.append("\\t");
                break;
            default:
                if (*cursor < 0x20) {
                    char escape[8];
                    snprintf(escape, sizeof(escape), "\\u%04x", *cursor);
                    out.append(escape);
                } else {
                    out.push_back(static_cast<char>(*cursor));
                }
                break;
            }
        }
    }
    out.push_back('"');
}

void AppendKey(std::string &out, const char *key)
{
    out.push_back('"');
    out.append(key);
    out.append("\":");
}

void AppendStringField(std::string &out, const char *key, const std::string &value)
{
    AppendKey(out, key);
    AppendJsonString(out, value.c_str());
    out.push_back(',');
}

/** Flash size from sdkconfig ("16MB"/"8MB"/...); fall back to 0 when unknown. */
uint32_t FlashSizeBytes()
{
    const char *text = CONFIG_ESPTOOLPY_FLASHSIZE;
    if (text == nullptr) {
        return 0;
    }
    char *end = nullptr;
    const unsigned long value = strtoul(text, &end, 10);
    if (end == nullptr) {
        return 0;
    }
    unsigned long multiplier = 1;
    if (strcasecmp(end, "KB") == 0) {
        multiplier = 1024;
    } else if (strcasecmp(end, "MB") == 0) {
        multiplier = 1024 * 1024;
    } else if (strcasecmp(end, "GB") == 0) {
        multiplier = 1024 * 1024 * 1024;
    } else if (*end != '\0') {
        return 0;
    }
    return static_cast<uint32_t>(value * multiplier);
}

std::string ChipModelName()
{
    return CONFIG_IDF_TARGET;
}

std::string RunningPartitionLabel()
{
    const esp_partition_t *partition = esp_ota_get_running_partition();
    return partition != nullptr ? std::string(partition->label) : std::string("factory");
}

/** "SSID" / RSSI of the currently associated AP, empty/0 when not connected. */
void WifiStatus(std::string *ssid, int *rssi, std::string *ip)
{
    ssid->clear();
    *rssi = 0;
    ip->clear();

    wifi_ap_record_t ap = {};
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        ssid->assign(reinterpret_cast<const char *>(ap.ssid));
        *rssi = ap.rssi;
    }

    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif != nullptr) {
        esp_netif_ip_info_t info = {};
        if (esp_netif_get_ip_info(netif, &info) == ESP_OK && info.ip.addr != 0) {
            char text[16] = {};
            if (esp_ip4addr_ntoa(&info.ip, text, sizeof(text)) != nullptr) {
                *ip = text;
            }
        }
    }
}

/** xiaozhi "system info" JSON (see xiaozhi board.cc GetSystemInfoJson). */
std::string BuildSystemInfo(const std::string &mac, const std::string &uuid,
                            const std::string &app_version)
{
    std::string out;
    out.reserve(2048);
    out.push_back('{');

    out.append("\"version\":2,");
    AppendStringField(out, "language", "zh-CN");
    out.append("\"flash_size\":");
    out.append(std::to_string(FlashSizeBytes()));
    out.push_back(',');
    out.append("\"psram_size\":");
    out.append(std::to_string(heap_caps_get_total_size(MALLOC_CAP_SPIRAM)));
    out.push_back(',');
    AppendStringField(out, "mac_address", mac);
    AppendStringField(out, "uuid", uuid);
    AppendStringField(out, "chip_model_name", ChipModelName());

    esp_chip_info_t chip_info = {};
    esp_chip_info(&chip_info);
    out.append("\"chip_info\":{");
    out.append("\"model\":");
    out.append(std::to_string(static_cast<int>(chip_info.model)));
    out.append(",\"cores\":");
    out.append(std::to_string(chip_info.cores));
    out.append(",\"revision\":");
    out.append(std::to_string(chip_info.revision));
    out.append(",\"features\":");
    out.append(std::to_string(static_cast<unsigned>(chip_info.features)));
    out.append("},");

    out.append("\"application\":{");
    out.append("\"name\":");
    AppendJsonString(out, "inkpane");
    out.append(",\"version\":");
    AppendJsonString(out, app_version.c_str());
    out.append("},");

    out.append("\"partition_table\":[");
    bool first = true;
    for (esp_partition_iterator_t it =
             esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, nullptr);
         it != nullptr; it = esp_partition_next(it)) {
        const esp_partition_t *partition = esp_partition_get(it);
        if (partition == nullptr) {
            continue;
        }
        if (!first) {
            out.push_back(',');
        }
        first = false;
        out.append("{\"label\":");
        AppendJsonString(out, partition->label);
        out.append(",\"type\":");
        out.append(std::to_string(static_cast<int>(partition->type)));
        out.append(",\"subtype\":");
        out.append(std::to_string(static_cast<int>(partition->subtype)));
        out.append(",\"address\":");
        out.append(std::to_string(static_cast<unsigned long>(partition->address)));
        out.append(",\"size\":");
        out.append(std::to_string(static_cast<unsigned long>(partition->size)));
        out.append("}");
    }
    out.append("],");

    out.append("\"ota\":{\"label\":");
    AppendJsonString(out, RunningPartitionLabel().c_str());
    out.append("},");

    out.append("\"display\":{\"monochrome\":true,\"width\":800,\"height\":480},");

    std::string ssid;
    std::string ip;
    int rssi = 0;
    WifiStatus(&ssid, &rssi, &ip);
    out.append("\"board\":{");
    out.append("\"type\":");
    AppendJsonString(out, "inkpane-s3-epaper-3.97");
    out.append(",\"name\":");
    AppendJsonString(out, "InkPane 墨窗");
    out.append(",\"ssid\":");
    AppendJsonString(out, ssid.c_str());
    out.append(",\"rssi\":");
    out.append(std::to_string(rssi));
    out.append(",\"ip\":");
    AppendJsonString(out, ip.c_str());
    out.append(",\"mac\":");
    AppendJsonString(out, mac.c_str());
    out.append("}");

    out.push_back('}');
    return out;
}

esp_err_t HttpEvent(esp_http_client_event_t *event)
{
    auto *response = static_cast<HttpResponse *>(event->user_data);
    if (response == nullptr || event->event_id != HTTP_EVENT_ON_DATA || event->data_len <= 0) {
        return ESP_OK;
    }
    if (response->body.size() + static_cast<size_t>(event->data_len) > kMaxResponseBytes) {
        response->overflow = true;
        ESP_LOGE(TAG, "OTA response exceeds %u bytes", static_cast<unsigned>(kMaxResponseBytes));
        return ESP_FAIL;
    }
    response->body.append(static_cast<const char *>(event->data),
                          static_cast<size_t>(event->data_len));
    return ESP_OK;
}

bool PostJson(const std::string &url, const std::string &body, const std::string &mac,
              const std::string &uuid, const std::string &app_version, HttpResponse *response,
              std::string *error)
{
    if (url.empty()) {
        *error = "OTA 地址为空";
        return false;
    }

    esp_http_client_config_t config = {};
    config.url = url.c_str();
    config.method = HTTP_METHOD_POST;
    config.timeout_ms = kHttpTimeoutMs;
    config.event_handler = HttpEvent;
    config.user_data = response;
    config.buffer_size = 2048;
    config.keep_alive_enable = false;
    config.crt_bundle_attach = esp_crt_bundle_attach;

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == nullptr) {
        *error = "无法创建 HTTP 客户端";
        return false;
    }
    esp_http_client_set_header(client, "Device-Id", mac.c_str());
    esp_http_client_set_header(client, "Client-Id", uuid.c_str());
    const std::string user_agent = "InkPane/" + app_version;
    esp_http_client_set_header(client, "User-Agent", user_agent.c_str());
    esp_http_client_set_header(client, "Activation-Version", "1");
    esp_http_client_set_header(client, "Accept-Language", "zh-CN");
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body.data(), static_cast<int>(body.size()));

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        response->status = esp_http_client_get_status_code(client);
    }
    esp_http_client_cleanup(client);

    if (err != ESP_OK) {
        *error = std::string("HTTP 请求失败：") + esp_err_to_name(err);
        return false;
    }
    if (response->overflow) {
        *error = "OTA 响应超过 8 KB";
        return false;
    }
    return true;
}

const char *JsonStringAt(const json_value_t *object, const char *key)
{
    return json_string(json_object_get(object, key));
}

bool ParseOtaResponse(const std::string &body, VoiceOtaResult *result, std::string *error)
{
    std::unique_ptr<char[]> arena(new char[kParseArenaBytes]);
    json_doc_t doc = {};
    if (!json_parse(&doc, body.data(), body.size(), arena.get(), kParseArenaBytes) ||
        doc.root == nullptr || doc.root->type != JSON_OBJECT) {
        *error = "无法解析 OTA 响应 JSON";
        return false;
    }
    const json_value_t *root = doc.root;

    const json_value_t *websocket = json_object_get(root, "websocket");
    const json_value_t *activation = json_object_get(root, "activation");
    const json_value_t *mqtt = json_object_get(root, "mqtt");
    const json_value_t *server_time = json_object_get(root, "server_time");

    if (websocket != nullptr && websocket->type == JSON_OBJECT) {
        const char *url = JsonStringAt(websocket, "url");
        if (url != nullptr && url[0] != '\0') {
            result->status = VoiceOtaResult::OK;
            result->ws_url = url;
            const char *token = JsonStringAt(websocket, "token");
            if (token != nullptr) {
                result->ws_token = token;
            }
            const double version = json_number(json_object_get(websocket, "version"), 1.0);
            result->ws_version = version >= 1.0 ? static_cast<int>(version) : 1;
        }
    }

    if (activation != nullptr && activation->type == JSON_OBJECT) {
        const char *message = JsonStringAt(activation, "message");
        if (message != nullptr) {
            result->activation_message = message;
        }
        const char *code = JsonStringAt(activation, "code");
        if (code != nullptr && code[0] != '\0') {
            result->activation_code = code;
        }
    }

    if (server_time != nullptr && server_time->type == JSON_OBJECT) {
        const json_value_t *timestamp = json_object_get(server_time, "timestamp");
        if (timestamp != nullptr && timestamp->type == JSON_NUMBER) {
            result->has_server_time = true;
            result->server_time_ms = static_cast<int64_t>(timestamp->number);
            const json_value_t *offset = json_object_get(server_time, "timezone_offset");
            if (offset != nullptr && offset->type == JSON_NUMBER) {
                result->tz_offset_minutes = static_cast<int>(offset->number);
            }
        }
    }

    if (result->status == VoiceOtaResult::OK) {
        return true;
    }

    if (!result->activation_code.empty()) {
        result->status = VoiceOtaResult::ACTIVATION_REQUIRED;
        return true;
    }
    if (mqtt != nullptr && mqtt->type == JSON_OBJECT) {
        result->status = VoiceOtaResult::MQTT_ONLY;
        result->error = "服务器只返回了 MQTT 配置，InkPane 语音使用 WebSocket";
        return true;
    }
    if (!result->activation_message.empty()) {
        *error = result->activation_message;
        return false;
    }
    *error = "OTA 响应中缺少 websocket/activation 配置";
    return false;
}

std::string ActivationUrl(const std::string &ota_url)
{
    std::string url = ota_url;
    if (url.empty()) {
        return url;
    }
    if (url.back() != '/') {
        url.push_back('/');
    }
    url.append("activate");
    return url;
}

void LogResponseBody(const std::string &body)
{
    if (body.empty()) {
        return;
    }
    const size_t limit = 200;
    if (body.size() <= limit) {
        ESP_LOGW(TAG, "body: %s", body.c_str());
        return;
    }
    ESP_LOGW(TAG, "body: %.*s…", static_cast<int>(limit), body.c_str());
}

}  // namespace

VoiceOtaResult voice_ota_check(const std::string &ota_url, const std::string &mac,
                               const std::string &uuid, const std::string &app_version)
{
    VoiceOtaResult result;
    result.status = VoiceOtaResult::FAILED;

    const std::string payload = BuildSystemInfo(mac, uuid, app_version);
    ESP_LOGI(TAG, "checking OTA endpoint %s (%u bytes of system info)", ota_url.c_str(),
             static_cast<unsigned>(payload.size()));

    HttpResponse response;
    std::string transport_error;
    if (!PostJson(ota_url, payload, mac, uuid, app_version, &response, &transport_error)) {
        result.error = transport_error;
        ESP_LOGE(TAG, "OTA request failed: %s", transport_error.c_str());
        return result;
    }
    if (response.status != 200) {
        result.error = "OTA 接口返回 HTTP " + std::to_string(response.status);
        ESP_LOGE(TAG, "%s", result.error.c_str());
        LogResponseBody(response.body);
        return result;
    }

    std::string parse_error;
    if (!ParseOtaResponse(response.body, &result, &parse_error)) {
        result.error = parse_error;
        ESP_LOGE(TAG, "%s", parse_error.c_str());
        LogResponseBody(response.body);
        return result;
    }

    switch (result.status) {
    case VoiceOtaResult::OK:
        ESP_LOGI(TAG, "OTA ok: ws=%s version=%d token=%s", result.ws_url.c_str(),
                 result.ws_version, result.ws_token.empty() ? "(none)" : "(set)");
        break;
    case VoiceOtaResult::ACTIVATION_REQUIRED:
        ESP_LOGI(TAG, "activation required: code=%s message=%s",
                 result.activation_code.empty() ? "(none)" : result.activation_code.c_str(),
                 result.activation_message.c_str());
        break;
    case VoiceOtaResult::MQTT_ONLY:
        ESP_LOGW(TAG, "server only offered MQTT; websocket is required");
        break;
    default:
        break;
    }
    return result;
}

int voice_ota_activate(const std::string &ota_url, const std::string &mac,
                       const std::string &uuid, const std::string &app_version,
                       std::string *error)
{
    std::string local_error;
    if (error == nullptr) {
        error = &local_error;
    }
    error->clear();

    const std::string url = ActivationUrl(ota_url);
    if (url.empty()) {
        *error = "OTA 地址为空";
        return -1;
    }

    ESP_LOGI(TAG, "posting activation to %s", url.c_str());
    HttpResponse response;
    if (!PostJson(url, "{}", mac, uuid, app_version, &response, error)) {
        ESP_LOGE(TAG, "activation request failed: %s", error->c_str());
        return -1;
    }

    if (response.status == 200) {
        ESP_LOGI(TAG, "activation succeeded");
        return 0;
    }
    if (response.status == 202) {
        ESP_LOGI(TAG, "activation pending (202)");
        return 1;
    }

    *error = "激活失败：HTTP " + std::to_string(response.status);
    ESP_LOGE(TAG, "%s", error->c_str());
    LogResponseBody(response.body);
    return -1;
}
