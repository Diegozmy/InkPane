#include "inkpane_net.h"

#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "esp_random.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#define NVS_NAMESPACE "inkpane"

/* Kconfig options that depend on INKPANE_VOICE may be absent in low-power
 * builds; keep the loader compilable either way. */
#ifndef CONFIG_INKPANE_VOICE
#define CONFIG_INKPANE_VOICE 0
#endif
#ifndef CONFIG_INKPANE_VOICE_ALLOW_CONTROL
#define CONFIG_INKPANE_VOICE_ALLOW_CONTROL 1
#endif
#ifndef CONFIG_INKPANE_VOICE_OTA_URL
#define CONFIG_INKPANE_VOICE_OTA_URL "https://api.tenclass.net/xiaozhi/ota/"
#endif
#ifndef CONFIG_INKPANE_VOICE_WAKE_WORDS
#define CONFIG_INKPANE_VOICE_WAKE_WORDS "你好小智"
#endif
#ifndef CONFIG_INKPANE_VOICE_WAKE_THRESHOLD
#define CONFIG_INKPANE_VOICE_WAKE_THRESHOLD 65
#endif
#ifndef CONFIG_INKPANE_VOICE_VOLUME
#define CONFIG_INKPANE_VOICE_VOLUME 60
#endif

static const char *TAG = "config";

static void copy_str(char *dst, size_t size, const char *src)
{
    if (size == 0) {
        return;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return;
    }
    size_t len = strlen(src);
    if (len >= size) {
        len = size - 1;
    }
    memcpy(dst, src, len);
    dst[len] = '\0';
}

static void load_str(nvs_handle_t handle, const char *key, char *out, size_t out_size)
{
    size_t length = out_size;
    if (nvs_get_str(handle, key, out, &length) != ESP_OK) {
        out[0] = '\0';
    }
}

static int load_int(nvs_handle_t handle, const char *key, int fallback)
{
    int32_t value = fallback;
    if (nvs_get_i32(handle, key, &value) != ESP_OK) {
        return fallback;
    }
    return (int)value;
}

static bool load_bool(nvs_handle_t handle, const char *key, bool fallback)
{
    uint8_t value = fallback ? 1 : 0;
    if (nvs_get_u8(handle, key, &value) != ESP_OK) {
        return fallback;
    }
    return value != 0;
}

static void generate_uuid(char *out, size_t size)
{
    uint8_t bytes[16] = {0};
    esp_fill_random(bytes, sizeof(bytes));
    bytes[6] = (uint8_t)((bytes[6] & 0x0F) | 0x40);
    bytes[8] = (uint8_t)((bytes[8] & 0x3F) | 0x80);
    snprintf(out, size,
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", bytes[0],
             bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8],
             bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
}

esp_err_t inkpane_config_ensure_uuid(char *out, size_t size)
{
    if (out == NULL || size < INKPANE_UUID_LEN) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        generate_uuid(out, size);
        return err;
    }
    load_str(handle, "uuid", out, size);
    if (out[0] == '\0') {
        generate_uuid(out, size);
        nvs_set_str(handle, "uuid", out);
        nvs_commit(handle);
    }
    nvs_close(handle);
    return ESP_OK;
}

esp_err_t inkpane_config_load(inkpane_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(config, 0, sizeof(*config));
    config->refresh_minutes = 30;
    config->utc_offset_minutes = 480;
    copy_str(config->api_url, sizeof(config->api_url), CONFIG_INKPANE_API_URL);
    copy_str(config->token, sizeof(config->token), CONFIG_INKPANE_DEVICE_TOKEN);

    config->voice_enabled = CONFIG_INKPANE_VOICE != 0;
    config->voice_allow_control = CONFIG_INKPANE_VOICE_ALLOW_CONTROL != 0;
    config->voice_wake_threshold = CONFIG_INKPANE_VOICE_WAKE_THRESHOLD;
    config->voice_volume = CONFIG_INKPANE_VOICE_VOLUME;
    config->voice_ws_version = 1;
    copy_str(config->voice_ota_url, sizeof(config->voice_ota_url),
             CONFIG_INKPANE_VOICE_OTA_URL);
    copy_str(config->voice_wake_words, sizeof(config->voice_wake_words),
             CONFIG_INKPANE_VOICE_WAKE_WORDS);

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        inkpane_config_ensure_uuid(config->voice_uuid, sizeof(config->voice_uuid));
        return ESP_OK;
    }
    if (err != ESP_OK) {
        inkpane_config_ensure_uuid(config->voice_uuid, sizeof(config->voice_uuid));
        return err;
    }

    load_str(handle, "ssid", config->ssid, sizeof(config->ssid));
    load_str(handle, "pass", config->password, sizeof(config->password));
    load_str(handle, "api_url", config->api_url, sizeof(config->api_url));
    load_str(handle, "token", config->token, sizeof(config->token));
    load_str(handle, "etag", config->etag, sizeof(config->etag));
    load_str(handle, "voice_ota", config->voice_ota_url, sizeof(config->voice_ota_url));
    load_str(handle, "voice_ws", config->voice_ws_url, sizeof(config->voice_ws_url));
    load_str(handle, "voice_ws_tok", config->voice_ws_token, sizeof(config->voice_ws_token));
    load_str(handle, "wake_words", config->voice_wake_words, sizeof(config->voice_wake_words));
    load_str(handle, "uuid", config->voice_uuid, sizeof(config->voice_uuid));
    config->voice_ws_version = load_int(handle, "voice_ws_ver", config->voice_ws_version);
    config->voice_wake_threshold =
        load_int(handle, "wake_thr", config->voice_wake_threshold);
    config->voice_volume = load_int(handle, "voice_vol", config->voice_volume);
    config->voice_enabled = load_bool(handle, "voice_on", config->voice_enabled);
    config->voice_allow_control =
        load_bool(handle, "voice_ctrl", config->voice_allow_control);
    config->voice_activated = load_bool(handle, "voice_act", false);
    config->refresh_minutes = load_int(handle, "refresh_min", config->refresh_minutes);
    config->utc_offset_minutes = load_int(handle, "tz_offset", config->utc_offset_minutes);
    nvs_close(handle);

    if (config->voice_uuid[0] == '\0') {
        inkpane_config_ensure_uuid(config->voice_uuid, sizeof(config->voice_uuid));
    }
    if (config->voice_ota_url[0] == '\0') {
        copy_str(config->voice_ota_url, sizeof(config->voice_ota_url),
                 CONFIG_INKPANE_VOICE_OTA_URL);
    }
    if (config->voice_wake_words[0] == '\0') {
        copy_str(config->voice_wake_words, sizeof(config->voice_wake_words),
                 CONFIG_INKPANE_VOICE_WAKE_WORDS);
    }
    if (config->voice_wake_threshold < 0 || config->voice_wake_threshold > 100) {
        config->voice_wake_threshold = CONFIG_INKPANE_VOICE_WAKE_THRESHOLD;
    }
    if (config->voice_volume < 0 || config->voice_volume > 100) {
        config->voice_volume = CONFIG_INKPANE_VOICE_VOLUME;
    }
    if (config->voice_ws_version < 1 || config->voice_ws_version > 3) {
        config->voice_ws_version = 1;
    }
    if (config->voice_ws_url[0] != '\0') {
        config->voice_activated = true;
    }

    if (config->refresh_minutes < 5 || config->refresh_minutes > 720) {
        config->refresh_minutes = 30;
    }
    if (config->utc_offset_minutes < -720 || config->utc_offset_minutes > 840) {
        config->utc_offset_minutes = 480;
    }
    if (config->ssid[0] == '\0' || config->token[0] == '\0' || config->api_url[0] == '\0') {
        config->provisioned = false;
    } else {
        config->provisioned = true;
    }
    ESP_LOGI(TAG, "config: ssid=%s url=%s token=%c%c%c%c…",
             config->ssid[0] ? config->ssid : "(none)", config->api_url,
             config->token[0], config->token[1], config->token[2], config->token[3]);
    return ESP_OK;
}

esp_err_t inkpane_config_save(const inkpane_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    ESP_RETURN_ON_ERROR(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle), TAG, "nvs open");

    esp_err_t err = nvs_set_str(handle, "ssid", config->ssid);
    if (err == ESP_OK) err = nvs_set_str(handle, "pass", config->password);
    if (err == ESP_OK) err = nvs_set_str(handle, "api_url", config->api_url);
    if (err == ESP_OK) err = nvs_set_str(handle, "token", config->token);
    if (err == ESP_OK) err = nvs_set_str(handle, "voice_ota", config->voice_ota_url);
    if (err == ESP_OK) err = nvs_set_str(handle, "voice_ws", config->voice_ws_url);
    if (err == ESP_OK) err = nvs_set_str(handle, "voice_ws_tok", config->voice_ws_token);
    if (err == ESP_OK) err = nvs_set_str(handle, "wake_words", config->voice_wake_words);
    if (err == ESP_OK) err = nvs_set_str(handle, "uuid", config->voice_uuid);
    if (err == ESP_OK) err = nvs_set_i32(handle, "voice_ws_ver", config->voice_ws_version);
    if (err == ESP_OK) err = nvs_set_i32(handle, "wake_thr", config->voice_wake_threshold);
    if (err == ESP_OK) err = nvs_set_i32(handle, "voice_vol", config->voice_volume);
    if (err == ESP_OK) err = nvs_set_u8(handle, "voice_on", config->voice_enabled ? 1 : 0);
    if (err == ESP_OK) err = nvs_set_u8(handle, "voice_ctrl", config->voice_allow_control ? 1 : 0);
    if (err == ESP_OK) err = nvs_set_u8(handle, "voice_act", config->voice_activated ? 1 : 0);
    if (err == ESP_OK) err = nvs_set_i32(handle, "refresh_min", config->refresh_minutes);
    if (err == ESP_OK) err = nvs_set_i32(handle, "tz_offset", config->utc_offset_minutes);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err;
}

esp_err_t inkpane_config_update_voice(const char *ws_url, const char *ws_token, int ws_version,
                                      bool activated)
{
    if (ws_url == NULL || ws_token == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    ESP_RETURN_ON_ERROR(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle), TAG, "nvs open");
    esp_err_t err = nvs_set_str(handle, "voice_ws", ws_url);
    if (err == ESP_OK) err = nvs_set_str(handle, "voice_ws_tok", ws_token);
    if (err == ESP_OK) err = nvs_set_i32(handle, "voice_ws_ver", ws_version);
    if (err == ESP_OK) err = nvs_set_u8(handle, "voice_act", activated ? 1 : 0);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err;
}

esp_err_t inkpane_config_save_voice(const inkpane_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    ESP_RETURN_ON_ERROR(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle), TAG, "nvs open");
    esp_err_t err = nvs_set_str(handle, "voice_ota", config->voice_ota_url);
    if (err == ESP_OK) err = nvs_set_str(handle, "wake_words", config->voice_wake_words);
    if (err == ESP_OK) err = nvs_set_i32(handle, "wake_thr", config->voice_wake_threshold);
    if (err == ESP_OK) err = nvs_set_i32(handle, "voice_vol", config->voice_volume);
    if (err == ESP_OK) err = nvs_set_u8(handle, "voice_on", config->voice_enabled ? 1 : 0);
    if (err == ESP_OK) err = nvs_set_u8(handle, "voice_ctrl", config->voice_allow_control ? 1 : 0);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err;
}

esp_err_t inkpane_config_save_etag(const char *etag)
{
    if (etag == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    ESP_RETURN_ON_ERROR(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle), TAG, "nvs open");
    esp_err_t err = nvs_set_str(handle, "etag", etag);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

esp_err_t inkpane_config_save_runtime(int refresh_minutes, int utc_offset_minutes)
{
    nvs_handle_t handle;
    ESP_RETURN_ON_ERROR(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle), TAG, "nvs open");
    esp_err_t err = nvs_set_i32(handle, "refresh_min", refresh_minutes);
    if (err == ESP_OK) err = nvs_set_i32(handle, "tz_offset", utc_offset_minutes);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err;
}

esp_err_t inkpane_config_erase(void)
{
    nvs_handle_t handle;
    ESP_RETURN_ON_ERROR(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle), TAG, "nvs open");
    esp_err_t err = nvs_erase_all(handle);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}
