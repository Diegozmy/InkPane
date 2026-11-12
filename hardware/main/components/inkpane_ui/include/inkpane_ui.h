#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "inkpane_canvas.h"
#include "inkpane_font.h"
#include "inkpane_model.h"

typedef enum {
    INKPANE_ALIGN_LEFT = 0,
    INKPANE_ALIGN_CENTER,
    INKPANE_ALIGN_RIGHT,
} inkpane_align_t;

/** Everything the clock module needs, independent of the payload. */
typedef struct {
    bool valid;
    int hour;
    int minute;
    int weekday; /* 0 = Sunday */
    int month;
    int day;
    char weekday_label[INKPANE_WEEKDAY_LEN];
    char date_label[INKPANE_LABEL_LEN];
} inkpane_clock_t;

#define INKPANE_STATUS_OFFLINE (1u << 0)
#define INKPANE_STATUS_AUTH (1u << 1)
#define INKPANE_STATUS_LOW_BATTERY (1u << 2)
/* Voice state shown in the clock module's status line. */
#define INKPANE_STATUS_VOICE_MUTED (1u << 3)
#define INKPANE_STATUS_VOICE_ERROR (1u << 4)

/** Load the font blob; pass NULL to use the blob embedded in the firmware. */
esp_err_t inkpane_ui_init(const uint8_t *font_blob, size_t font_size);
/** Redraw every enabled module from a parsed payload. */
void inkpane_ui_render_full(uint8_t *framebuffer, const inkpane_screen_t *screen);

/** Redraw only the clock rectangle (used for minute-level partial refresh). */
void inkpane_ui_render_clock(uint8_t *framebuffer, const inkpane_rect_t *rect,
                             const inkpane_clock_t *clock, unsigned status);

/*
 * Full-screen zoomed renderings of single modules. Each one clears the whole
 * panel and lays its content out with the large/medium font sizes instead of
 * the compact mini-module rectangles. Driven by the button-activated zoom
 * view; data comes from the cached screen payload.
 */
void inkpane_ui_render_clock_full(uint8_t *framebuffer, const inkpane_clock_t *clock,
                                  unsigned status);
void inkpane_ui_render_calendar_full(uint8_t *framebuffer, const inkpane_month_t *month);
void inkpane_ui_render_weather_full(uint8_t *framebuffer, const inkpane_weather_t *weather);
void inkpane_ui_render_events_full(uint8_t *framebuffer, const inkpane_event_t *events,
                                   int count, int total, bool courses);
void inkpane_ui_render_todos_full(uint8_t *framebuffer, const inkpane_todo_t *todos,
                                  int count, int total);

/** Full-screen provisioning instructions. */
void inkpane_ui_render_setup(uint8_t *framebuffer, const char *ap_ssid, const char *url);

/**
 * Full-screen status notice (network / token failures). All lines are centred;
 * NULL or empty lines are skipped. Used instead of a bare clock when the panel
 * has no trustworthy content yet.
 */
void inkpane_ui_render_notice(uint8_t *framebuffer, const char *title, const char *line1,
                              const char *line2, const char *line3, const char *line4);

/**
 * Full-screen shutdown page. Draws a battery gauge plus the remaining charge
 * percentage so the last thing on screen before power is cut is useful.
 * `battery_percent` < 0 means "unknown"; `reason` may be NULL.
 */
void inkpane_ui_render_shutdown(uint8_t *framebuffer, int battery_percent, bool charging,
                                const char *reason);

/* Text helpers (exposed for host tests). */
int inkpane_text_width(const inkpane_font_t *font, const char *text);
int inkpane_text_draw(inkpane_canvas_t *canvas, const inkpane_font_t *font, int x, int y,
                      const char *text, int max_width, inkpane_align_t align, bool black);

/* ------------------------------------------------------------------ */
/* Voice assistant pages                                              */
/* ------------------------------------------------------------------ */

/** One voice-page frame; all strings are NUL-terminated and may be NULL. */
typedef struct {
    const char *state_label; /* 连接中/聆听中/思考中/正在回答/待命/网络未连接 */
    const char *user_text;
    const char *reply_text;
    const char *footer_hint;
} inkpane_voice_view_t;

/** Full-screen conversation page (status + recognised text + reply). */
void inkpane_ui_render_voice(uint8_t *framebuffer, const inkpane_voice_view_t *view);

/** Full-screen activation page (6-digit code + message + xiaozhi.me hint). */
void inkpane_ui_render_voice_activation(uint8_t *framebuffer, const char *code, const char *message,
                                        const char *url);

/** Full-screen voice error page (model missing / network / token failure). */
void inkpane_ui_render_voice_error(uint8_t *framebuffer, const char *title, const char *reason,
                                   const char *hint);

/**
 * Copy `src` into `dst` while dropping code points the 1-bit font cannot draw
 * (emoji, rare hanzi, control chars), clamping to `max_glyphs` glyphs and
 * appending "..." when truncated. Newlines are preserved. Returns the number
 * of bytes written (excluding the terminator).
 */
size_t inkpane_ui_voice_copy(char *dst, size_t cap, const char *src, size_t max_glyphs);
