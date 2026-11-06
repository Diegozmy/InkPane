#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define INKPANE_SSID_LEN 33
#define INKPANE_PASS_LEN 65
#define INKPANE_TOKEN_LEN 40
#define INKPANE_URL_LEN 128
#define INKPANE_ETAG_LEN 80
#define INKPANE_OTA_URL_LEN 200
#define INKPANE_WS_URL_LEN 200
#define INKPANE_WS_TOKEN_LEN 160
#define INKPANE_WAKE_WORDS_LEN 320
#define INKPANE_UUID_LEN 40

typedef struct {
    char ssid[INKPANE_SSID_LEN];
    char password[INKPANE_PASS_LEN];
    char api_url[INKPANE_URL_LEN];
    char token[INKPANE_TOKEN_LEN];
    char etag[INKPANE_ETAG_LEN];

    /* Voice assistant. Persistent fields live in NVS; the WebSocket URL/token
     * are filled in by the OTA/activation flow and survive reboots. */
    char voice_ota_url[INKPANE_OTA_URL_LEN];
    char voice_ws_url[INKPANE_WS_URL_LEN];
    char voice_ws_token[INKPANE_WS_TOKEN_LEN];
    char voice_wake_words[INKPANE_WAKE_WORDS_LEN];
    char voice_uuid[INKPANE_UUID_LEN];
    int voice_ws_version;
    int voice_wake_threshold;
    int voice_volume;
    bool voice_enabled;
    bool voice_allow_control;
    bool voice_activated;

    int refresh_minutes;
    int utc_offset_minutes;
    bool provisioned;
} inkpane_config_t;

/** Load configuration from NVS, applying Kconfig defaults for missing keys. */
esp_err_t inkpane_config_load(inkpane_config_t *config);
esp_err_t inkpane_config_save(const inkpane_config_t *config);
esp_err_t inkpane_config_save_etag(const char *etag);
esp_err_t inkpane_config_save_runtime(int refresh_minutes, int utc_offset_minutes);
esp_err_t inkpane_config_erase(void);

/** Persist the WebSocket config obtained from the xiaozhi OTA/activation flow. */
esp_err_t inkpane_config_update_voice(const char *ws_url, const char *ws_token, int ws_version,
                                      bool activated);

/** Load or create the persistent UUIDv4 used as the xiaozhi Client-Id. */
esp_err_t inkpane_config_ensure_uuid(char *out, size_t size);

/** Persist only the voice tuning fields (wake words, threshold, volume, flags). */
esp_err_t inkpane_config_save_voice(const inkpane_config_t *config);

esp_err_t inkpane_wifi_connect(const char *ssid, const char *password, int timeout_ms);
void inkpane_wifi_disconnect(void);
bool inkpane_wifi_connected(void);
int inkpane_wifi_rssi(void);

/** Switch between modem sleep (idle) and no power save (voice session). */
void inkpane_wifi_set_power_save(bool enabled);

/**
 * True once the system clock has been set by SNTP (epoch > 1700000000, i.e.
 * past 2023-11-14). A freshly booted ESP32 starts at 1970, so this answers
 * "is it safe to use TLS / show a wall-clock time yet?".
 */
bool inkpane_time_valid(void);

/**
 * NON-BLOCKING, idempotent: bring up the SNTP service and return immediately.
 * Servers are polled hourly in the background once running, so callers do not
 * need to sync again after the first success. Returns ESP_ERR_INVALID_STATE
 * when Wi-Fi is not connected yet (SNTP has no route to the internet).
 */
esp_err_t inkpane_time_sync_start(void);

/**
 * Start SNTP if it is not running yet, then wait up to `timeout_ms` for a
 * completed sync; retries once with a fresh request on timeout. Returns ESP_OK
 * on success (including when the clock was already valid), ESP_ERR_TIMEOUT if
 * both attempts expired, ESP_ERR_INVALID_STATE without Wi-Fi. Safe to call
 * concurrently from several tasks. The caller converts UTC -> local; this
 * function only sets the system clock.
 */
esp_err_t inkpane_wifi_sync_time(int timeout_ms);

/** Copy the STA IPv4 address as dotted text ("192.168.71.53"). */
esp_err_t inkpane_wifi_ip(char *out, size_t size);

typedef enum {
    INKPANE_HTTP_OK = 0,
    INKPANE_HTTP_NOT_MODIFIED,
    INKPANE_HTTP_UNAUTHORIZED,
    INKPANE_HTTP_FAILED,
} inkpane_http_result_t;

/**
 * GET /api/device/screen. `body` is filled with the response when OK.
 * `etag` may be NULL/empty to force a full response.
 */
inkpane_http_result_t inkpane_http_fetch_screen(const char *api_url, const char *token,
                                                const char *etag, char *body, size_t body_capacity,
                                                size_t *body_length, char *etag_out, size_t etag_out_size,
                                                char *date_out, size_t date_out_size);

inkpane_http_result_t inkpane_http_post_telemetry(const char *api_url, const char *token,
                                                  float temperature, float humidity,
                                                  int battery_percent, int battery_millivolt, int rssi,
                                                  const char *firmware, uint32_t uptime_seconds);
