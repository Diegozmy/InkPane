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

/** Load the font blob; pass NULL to use the blob embedded in the firmware. */
esp_err_t inkpane_ui_init(const uint8_t *font_blob, size_t font_size);

/** Redraw every enabled module from a parsed payload. */
void inkpane_ui_render_full(uint8_t *framebuffer, const inkpane_screen_t *screen);

/** Redraw only the clock rectangle (used for minute-level partial refresh). */
void inkpane_ui_render_clock(uint8_t *framebuffer, const inkpane_rect_t *rect,
                             const inkpane_clock_t *clock, unsigned status);

/** Full-screen provisioning instructions. */
void inkpane_ui_render_setup(uint8_t *framebuffer, const char *ap_ssid, const char *url);

/* Text helpers (exposed for host tests). */
int inkpane_text_width(const inkpane_font_t *font, const char *text);
int inkpane_text_draw(inkpane_canvas_t *canvas, const inkpane_font_t *font, int x, int y,
                      const char *text, int max_width, inkpane_align_t align, bool black);
