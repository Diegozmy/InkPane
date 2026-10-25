#pragma once

/**
 * NVS key/value shim for the vendored xiaozhi voice code.
 *
 * The interface intentionally matches xiaozhi-esp32 `main/settings.h` so the
 * upstream sources can stay almost untouched:
 *
 *     Settings settings("websocket", true);
 *     settings.SetString("url", url);
 *
 * The namespace argument is kept for source compatibility, but every key is
 * stored in the single `voice` NVS namespace instead of the upstream
 * per-subsystem namespaces. InkPane already owns the `inkpane` namespace, and
 * keeping the voice state in exactly one namespace makes wiping or migrating
 * the assistant state a single `nvs_erase_all`.
 *
 * Unlike upstream this shim never calls ESP_ERROR_CHECK()/abort() on storage
 * errors: NVS failures are logged and reads fall back to their defaults, so a
 * corrupt NVS partition cannot brick the dashboard firmware.
 *
 * The read_write flag must be true for any Set.../Erase... call; writes to a
 * read-only handle are ignored with a warning, matching upstream behaviour.
 */

#include <cstdint>
#include <string>

#include <nvs_flash.h>

namespace inkpane_voice_port {
/** NVS namespace used by every Settings instance of the voice component. */
inline constexpr const char *kNvsNamespace = "voice";
}  // namespace inkpane_voice_port

class Settings {
public:
    explicit Settings(const std::string &ns, bool read_write = false);
    ~Settings();

    Settings(const Settings &) = delete;
    Settings &operator=(const Settings &) = delete;

    std::string GetString(const std::string &key, const std::string &default_value = "");
    void SetString(const std::string &key, const std::string &value);
    int32_t GetInt(const std::string &key, int32_t default_value = 0);
    void SetInt(const std::string &key, int32_t value);
    bool GetBool(const std::string &key, bool default_value = false);
    void SetBool(const std::string &key, bool value);
    void EraseKey(const std::string &key);
    void EraseAll();

private:
    bool Open();
    bool CanWrite() const;

    std::string ns_;
    nvs_handle_t nvs_handle_ = 0;
    bool read_write_ = false;
    bool opened_ = false;
    bool dirty_ = false;
};
