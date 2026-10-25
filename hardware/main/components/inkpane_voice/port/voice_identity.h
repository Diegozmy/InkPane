#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/** Identity strings handed to the xiaozhi OTA/WebSocket handshake. */
const char *inkpane_voice_device_mac(void);
const char *inkpane_voice_device_uuid(void);

/** Runtime wake-word list (already split/validated by app_main). */
const char *const *inkpane_voice_wake_words(int *count);

/** MultiNet detection threshold in 0.0-1.0. */
float inkpane_voice_wake_threshold(void);

#ifdef __cplusplus
}
#endif
