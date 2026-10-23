#include "inkpane_canvas.h"

#include <string.h>

void inkpane_canvas_init(inkpane_canvas_t *canvas, uint8_t *buffer, int width, int height,
                         int origin_x, int origin_y)
{
    canvas->buffer = buffer;
    canvas->width = width;
    canvas->height = height;
    canvas->stride = (width + 7) / 8;
    canvas->origin_x = origin_x;
    canvas->origin_y = origin_y;
    canvas->clip_x0 = origin_x;
    canvas->clip_y0 = origin_y;
    canvas->clip_x1 = origin_x + width;
    canvas->clip_y1 = origin_y + height;
}

void inkpane_canvas_set_clip(inkpane_canvas_t *canvas, int x, int y, int width, int height)
{
    canvas->clip_x0 = x;
    canvas->clip_y0 = y;
    canvas->clip_x1 = x + width;
    canvas->clip_y1 = y + height;
}

void inkpane_canvas_clear_clip(inkpane_canvas_t *canvas)
{
    canvas->clip_x0 = canvas->origin_x;
    canvas->clip_y0 = canvas->origin_y;
    canvas->clip_x1 = canvas->origin_x + canvas->width;
    canvas->clip_y1 = canvas->origin_y + canvas->height;
}

void inkpane_canvas_clear(inkpane_canvas_t *canvas, bool white)
{
    memset(canvas->buffer, white ? 0xFF : 0x00, (size_t)canvas->stride * canvas->height);
}

void inkpane_canvas_pixel(inkpane_canvas_t *canvas, int x, int y, bool black)
{
    if (x < canvas->clip_x0 || x >= canvas->clip_x1 || y < canvas->clip_y0 ||
        y >= canvas->clip_y1) {
        return;
    }
    int local_x = x - canvas->origin_x;
    int local_y = y - canvas->origin_y;
    if (local_x < 0 || local_y < 0 || local_x >= canvas->width || local_y >= canvas->height) {
        return;
    }
    uint8_t *byte = &canvas->buffer[(size_t)local_y * canvas->stride + (local_x >> 3)];
    uint8_t mask = (uint8_t)(0x80u >> (local_x & 7));
    if (black) {
        *byte &= (uint8_t)~mask;
    } else {
        *byte |= mask;
    }
}

void inkpane_canvas_fill(inkpane_canvas_t *canvas, int x, int y, int width, int height, bool black)
{
    if (width <= 0 || height <= 0) {
        return;
    }
    for (int row = 0; row < height; ++row) {
        for (int column = 0; column < width; ++column) {
            inkpane_canvas_pixel(canvas, x + column, y + row, black);
        }
    }
}

void inkpane_canvas_hline(inkpane_canvas_t *canvas, int x, int y, int width, bool black)
{
    inkpane_canvas_fill(canvas, x, y, width, 1, black);
}

void inkpane_canvas_frame(inkpane_canvas_t *canvas, int x, int y, int width, int height, bool black)
{
    inkpane_canvas_hline(canvas, x, y, width, black);
    inkpane_canvas_hline(canvas, x, y + height - 1, width, black);
    inkpane_canvas_fill(canvas, x, y, 1, height, black);
    inkpane_canvas_fill(canvas, x + width - 1, y, 1, height, black);
}
