#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define INKPANE_FONT_SIZES 3

typedef struct {
    uint16_t px;
    uint16_t line_height;
    uint16_t ascent;
    uint16_t glyph_count;
    uint32_t index_offset;
    uint32_t bitmap_offset;
    uint32_t bitmap_size;
    uint16_t digit_advance;
} inkpane_font_t;

/** Look up one of the three loaded sizes; returns NULL for unknown sizes. */
const inkpane_font_t *inkpane_font(int px);
const inkpane_font_t *inkpane_font_small(void);
const inkpane_font_t *inkpane_font_medium(void);
const inkpane_font_t *inkpane_font_large(void);

/** Load a blob produced by hardware/tools/genfont.py. */
esp_err_t inkpane_font_load(const uint8_t *data, size_t size);

/** Device builds: load the blob embedded in the component. */
esp_err_t inkpane_font_load_embedded(void);

/**
 * Find a glyph. Returns a packed MSB-first bitmap and its metrics, or NULL when
 * the codepoint is not covered.
 */
const uint8_t *inkpane_font_glyph(const inkpane_font_t *font, uint32_t codepoint, int *dx, int *dy,
                                  int *width, int *height, int *advance);
