#pragma once

/**
 * xiaozhi OTA / activation client for the InkPane voice assistant.
 *
 * The flow is the one used by xiaozhi-esp32 (MIT): POST the "system info"
 * JSON to the OTA endpoint; the server answers either with a `websocket`
 * section (ready to talk), an `activation` section (the user must bind the
 * device on xiaozhi.me), or only an `mqtt` section (unsupported by InkPane).
 *
 * The HTTP layer uses esp_http_client with the ESP-IDF certificate bundle, so
 * https:// API endpoints work without shipping a private CA.
 *
 * This file is compiled into the inkpane_voice component and is not part of
 * the host test build.
 */

#include <cstdint>
#include <string>

struct VoiceOtaResult {
    enum Status {
        OK = 0,                 ///< websocket url/token received
        ACTIVATION_REQUIRED,    ///< server wants the 6-digit activation code
        FAILED,                 ///< transport / parse / server error
        MQTT_ONLY,              ///< server only offered MQTT; InkPane uses WebSocket
    };

    Status status = FAILED;
    std::string activation_code;
    std::string activation_message;
    std::string ws_url;
    std::string ws_token;
    int ws_version = 1;
    bool has_server_time = false;
    int64_t server_time_ms = 0;
    int tz_offset_minutes = 0;
    std::string error;
};

/**
 * POST the system info to `ota_url` and interpret the response.
 *
 * `mac` is the Wi-Fi STA MAC ("AA:BB:..."), `uuid` the persistent Client-Id and
 * `app_version` the firmware version string reported in the body and User-Agent.
 */
VoiceOtaResult voice_ota_check(const std::string &ota_url, const std::string &mac,
                               const std::string &uuid, const std::string &app_version);

/**
 * POST `{}` to `<ota_url>/activate`, polling the activation state.
 *
 * @return 0 on 200 (activated), 1 on 202 (still waiting for the user),
 *         -1 on any other status / transport error.
 */
int voice_ota_activate(const std::string &ota_url, const std::string &mac,
                       const std::string &uuid, const std::string &app_version,
                       std::string *error = nullptr);
