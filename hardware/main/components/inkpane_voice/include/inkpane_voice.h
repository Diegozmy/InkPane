#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define INKPANE_VOICE_MAX_WAKE_WORDS 8
#define INKPANE_VOICE_WAKE_WORD_LEN 48
#define INKPANE_VOICE_OTA_URL_LEN 200
#define INKPANE_VOICE_WS_URL_LEN 200
#define INKPANE_VOICE_WS_TOKEN_LEN 160
#define INKPANE_VOICE_USER_TEXT_LEN 256
#define INKPANE_VOICE_REPLY_TEXT_LEN 768
#define INKPANE_VOICE_CODE_LEN 16
#define INKPANE_VOICE_MESSAGE_LEN 160
#define INKPANE_VOICE_ERROR_LEN 160

typedef enum {
    INKPANE_VOICE_DISABLED = 0,
    INKPANE_VOICE_OFFLINE,
    INKPANE_VOICE_ACTIVATING,
    INKPANE_VOICE_READY,
    INKPANE_VOICE_CONNECTING,
    INKPANE_VOICE_LISTENING,
    INKPANE_VOICE_THINKING,
    INKPANE_VOICE_SPEAKING,
    INKPANE_VOICE_ERROR,
} inkpane_voice_state_t;

/**
 * Startup/runtime configuration. Every string is borrowed: app_main keeps the
 * backing `inkpane_config_t` alive for the lifetime of the voice component.
 */
typedef struct {
    bool enabled;
    bool allow_control;
    const char *ota_url;
    const char *ws_url;
    const char *ws_token;
    int ws_version;
    const char *wake_words[INKPANE_VOICE_MAX_WAKE_WORDS];
    int wake_word_count;
    int wake_threshold; /* 0-100 */
    int volume;         /* 0-100 */
    const char *device_mac;
    const char *device_uuid;
    const char *firmware_version;
    const char *timezone;
    const char *api_url;
    const char *api_token;
    int utc_offset_minutes;
} inkpane_voice_config_t;

/** Thread-safe copy of everything the e-paper pages need. */
typedef struct {
    inkpane_voice_state_t state;
    char wake_word[INKPANE_VOICE_WAKE_WORD_LEN];
    char user_text[INKPANE_VOICE_USER_TEXT_LEN];
    char reply_text[INKPANE_VOICE_REPLY_TEXT_LEN];
    char activation_code[INKPANE_VOICE_CODE_LEN];
    char activation_message[INKPANE_VOICE_MESSAGE_LEN];
    char error[INKPANE_VOICE_ERROR_LEN];
    bool muted;
    bool ws_connected;
    bool activation_visible;
    bool control_allowed;
} inkpane_voice_snapshot_t;

typedef enum {
    INKPANE_VOICE_EVT_STATE = 0,
    INKPANE_VOICE_EVT_TEXT,
    INKPANE_VOICE_EVT_ACTIVATION,
    INKPANE_VOICE_EVT_SESSION,
    INKPANE_VOICE_EVT_ERROR,
    /** A MCP tool changed InkPane data: drop the ETag and refresh the screen. */
    INKPANE_VOICE_EVT_REFRESH,
} inkpane_voice_event_type_t;

typedef struct {
    inkpane_voice_event_type_t type;
    char ws_url[INKPANE_VOICE_WS_URL_LEN];
    char ws_token[INKPANE_VOICE_WS_TOKEN_LEN];
    int ws_version;
    bool activated;
} inkpane_voice_event_t;

/** Initialize audio/AFE/protocol resources. Returns NOT_SUPPORTED when off. */
esp_err_t inkpane_voice_init(const inkpane_voice_config_t *config);

/** Apply new settings (wake words/volume/allow-control/OTA URL) at runtime. */
esp_err_t inkpane_voice_apply_config(const inkpane_voice_config_t *config);

/** Start OTA/activation or wake-word listening. Wi-Fi and time must be ready. */
esp_err_t inkpane_voice_start(void);

void inkpane_voice_stop(void);

/** Non-blocking event poll for the main loop. */
bool inkpane_voice_poll_event(inkpane_voice_event_t *out);

void inkpane_voice_get_snapshot(inkpane_voice_snapshot_t *out);

/** True while a conversation page should stay on screen. */
bool inkpane_voice_session_active(void);

/** BOOT button: short press (listen/stop/abort) or long press (wake mute). */
void inkpane_voice_button(bool long_press);

void inkpane_voice_set_muted(bool muted);

void inkpane_voice_notify_network(bool up);
void inkpane_voice_notify_time_ready(void);

/** Activation page can be dismissed by the middle key. */
void inkpane_voice_set_activation_visible(bool visible);

#ifdef __cplusplus
}
#endif
