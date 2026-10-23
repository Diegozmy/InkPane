#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/**
 * 1-bit canvas over a caller-provided buffer (1 = white, 0 = black, matching
 * the panel's RAM convention). Coordinates are absolute; `origin_x/y` shift a
 * canvas over a sub-region of the screen.
 */
typedef struct {
    uint8_t *buffer;
    int width;
    int height;
    int stride; /* bytes per row */
    int origin_x;
    int origin_y;
    /* Absolute clip rectangle; defaults to the whole canvas. */
    int clip_x0;
    int clip_y0;
    int clip_x1;
    int clip_y1;
} inkpane_canvas_t;

void inkpane_canvas_init(inkpane_canvas_t *canvas, uint8_t *buffer, int width, int height,
                         int origin_x, int origin_y);
void inkpane_canvas_set_clip(inkpane_canvas_t *canvas, int x, int y, int width, int height);
void inkpane_canvas_clear_clip(inkpane_canvas_t *canvas);
void inkpane_canvas_clear(inkpane_canvas_t *canvas, bool white);
void inkpane_canvas_pixel(inkpane_canvas_t *canvas, int x, int y, bool black);
void inkpane_canvas_fill(inkpane_canvas_t *canvas, int x, int y, int width, int height, bool black);
void inkpane_canvas_hline(inkpane_canvas_t *canvas, int x, int y, int width, bool black);
void inkpane_canvas_frame(inkpane_canvas_t *canvas, int x, int y, int width, int height, bool black);
