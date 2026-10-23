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

typedef struct {
    char ssid[INKPANE_SSID_LEN];
    char password[INKPANE_PASS_LEN];
    char api_url[INKPANE_URL_LEN];
    char token[INKPANE_TOKEN_LEN];
    char etag[INKPANE_ETAG_LEN];
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

esp_err_t inkpane_wifi_connect(const char *ssid, const char *password, int timeout_ms);
void inkpane_wifi_disconnect(void);
bool inkpane_wifi_connected(void);
int inkpane_wifi_rssi(void);

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
