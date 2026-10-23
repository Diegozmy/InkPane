#include "inkpane_net.h"

#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#define NVS_NAMESPACE "inkpane"

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

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return ESP_OK;
    }
    if (err != ESP_OK) {
        return err;
    }

    load_str(handle, "ssid", config->ssid, sizeof(config->ssid));
    load_str(handle, "pass", config->password, sizeof(config->password));
    load_str(handle, "api_url", config->api_url, sizeof(config->api_url));
    load_str(handle, "token", config->token, sizeof(config->token));
    load_str(handle, "etag", config->etag, sizeof(config->etag));
    config->refresh_minutes = load_int(handle, "refresh_min", config->refresh_minutes);
    config->utc_offset_minutes = load_int(handle, "tz_offset", config->utc_offset_minutes);
    nvs_close(handle);

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
    if (err == ESP_OK) err = nvs_set_i32(handle, "refresh_min", config->refresh_minutes);
    if (err == ESP_OK) err = nvs_set_i32(handle, "tz_offset", config->utc_offset_minutes);
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
