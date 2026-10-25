#include "settings.h"

#include <esp_log.h>
#include <nvs.h>

#define TAG "voice_settings"

namespace {

const char *SafeKey(const std::string &key)
{
    return key.c_str();
}

}  // namespace

Settings::Settings(const std::string &ns, bool read_write)
    : ns_(ns.empty() ? std::string(inkpane_voice_port::kNvsNamespace) : ns),
      read_write_(read_write)
{
}

Settings::~Settings()
{
    if (nvs_handle_ != 0) {
        if (read_write_ && dirty_) {
            esp_err_t err = nvs_commit(nvs_handle_);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "nvs commit failed: %s", esp_err_to_name(err));
            }
        }
        nvs_close(nvs_handle_);
        nvs_handle_ = 0;
    }
}

bool Settings::Open()
{
    if (opened_) {
        return nvs_handle_ != 0;
    }
    opened_ = true;
    esp_err_t err = nvs_open(inkpane_voice_port::kNvsNamespace,
                             read_write_ ? NVS_READWRITE : NVS_READONLY, &nvs_handle_);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        /* Read-only open of a namespace that has never been written. */
        ESP_LOGI(TAG, "namespace '%s' has no stored keys yet (requested as '%s')",
                 inkpane_voice_port::kNvsNamespace, ns_.c_str());
        return false;
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open(%s) failed: %s", inkpane_voice_port::kNvsNamespace,
                 esp_err_to_name(err));
        nvs_handle_ = 0;
        return false;
    }
    return true;
}

bool Settings::CanWrite() const
{
    if (!read_write_) {
        ESP_LOGW(TAG, "namespace '%s' (requested as '%s') is not open for writing",
                 inkpane_voice_port::kNvsNamespace, ns_.c_str());
        return false;
    }
    return true;
}

std::string Settings::GetString(const std::string &key, const std::string &default_value)
{
    if (!Open()) {
        return default_value;
    }

    size_t length = 0;
    esp_err_t err = nvs_get_str(nvs_handle_, SafeKey(key), nullptr, &length);
    if (err != ESP_OK || length == 0) {
        return default_value;
    }

    std::string value(length, '\0');
    size_t read_length = length;
    err = nvs_get_str(nvs_handle_, SafeKey(key), value.data(), &read_length);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "nvs_get_str(%s) failed: %s", key.c_str(), esp_err_to_name(err));
        return default_value;
    }
    while (!value.empty() && value.back() == '\0') {
        value.pop_back();
    }
    return value;
}

void Settings::SetString(const std::string &key, const std::string &value)
{
    if (!CanWrite() || !Open()) {
        return;
    }
    esp_err_t err = nvs_set_str(nvs_handle_, SafeKey(key), value.c_str());
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_set_str(%s) failed: %s", key.c_str(), esp_err_to_name(err));
        return;
    }
    dirty_ = true;
}

int32_t Settings::GetInt(const std::string &key, int32_t default_value)
{
    if (!Open()) {
        return default_value;
    }
    int32_t value = default_value;
    esp_err_t err = nvs_get_i32(nvs_handle_, SafeKey(key), &value);
    if (err != ESP_OK) {
        return default_value;
    }
    return value;
}

void Settings::SetInt(const std::string &key, int32_t value)
{
    if (!CanWrite() || !Open()) {
        return;
    }
    esp_err_t err = nvs_set_i32(nvs_handle_, SafeKey(key), value);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_set_i32(%s) failed: %s", key.c_str(), esp_err_to_name(err));
        return;
    }
    dirty_ = true;
}

bool Settings::GetBool(const std::string &key, bool default_value)
{
    if (!Open()) {
        return default_value;
    }
    uint8_t value = 0;
    esp_err_t err = nvs_get_u8(nvs_handle_, SafeKey(key), &value);
    if (err != ESP_OK) {
        return default_value;
    }
    return value != 0;
}

void Settings::SetBool(const std::string &key, bool value)
{
    if (!CanWrite() || !Open()) {
        return;
    }
    esp_err_t err = nvs_set_u8(nvs_handle_, SafeKey(key), value ? 1 : 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_set_u8(%s) failed: %s", key.c_str(), esp_err_to_name(err));
        return;
    }
    dirty_ = true;
}

void Settings::EraseKey(const std::string &key)
{
    if (!CanWrite() || !Open()) {
        return;
    }
    esp_err_t err = nvs_erase_key(nvs_handle_, SafeKey(key));
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return;
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_erase_key(%s) failed: %s", key.c_str(), esp_err_to_name(err));
        return;
    }
    dirty_ = true;
}

void Settings::EraseAll()
{
    if (!CanWrite() || !Open()) {
        return;
    }
    esp_err_t err = nvs_erase_all(nvs_handle_);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_erase_all failed: %s", esp_err_to_name(err));
        return;
    }
    dirty_ = true;
}
