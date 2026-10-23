#include "inkpane_ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_err.h"
#include "esp_log.h"

#define PAD 6

static const char *TAG = "ui";

/* ------------------------------------------------------------------ */
/* UTF-8 / glyph helpers                                              */
/* ------------------------------------------------------------------ */

static uint32_t utf8_next(const char **cursor)
{
    const unsigned char *p = (const unsigned char *)*cursor;
    if (p[0] == 0) {
        return 0;
    }
    uint32_t codepoint = 0;
    int length = 0;
    if (p[0] < 0x80) {
        codepoint = p[0];
        length = 1;
    } else if ((p[0] & 0xE0) == 0xC0) {
        codepoint = p[0] & 0x1F;
        length = 2;
    } else if ((p[0] & 0xF0) == 0xE0) {
        codepoint = p[0] & 0x0F;
        length = 3;
    } else if ((p[0] & 0xF8) == 0xF0) {
        codepoint = p[0] & 0x07;
        length = 4;
    } else {
        *cursor += 1;
        return 0xFFFD;
    }
    for (int i = 1; i < length; ++i) {
        if ((p[i] & 0xC0) != 0x80) {
            *cursor += 1;
            return 0xFFFD;
        }
        codepoint = (codepoint << 6) | (p[i] & 0x3F);
    }
    *cursor += length;
    return codepoint;
}

static int glyph_advance(const inkpane_font_t *font, uint32_t codepoint)
{
    if (codepoint == ' ' || codepoint == 0x3000) {
        return font->px / 2;
    }
    int advance = 0;
    if (inkpane_font_glyph(font, codepoint, NULL, NULL, NULL, NULL, &advance) != NULL) {
        return advance;
    }
    return font->px;
}

static int draw_glyph(inkpane_canvas_t *canvas, const inkpane_font_t *font, int pen_x,
                      int baseline_y, uint32_t codepoint, bool black)
{
    if (codepoint == ' ' || codepoint == 0x3000 || codepoint == '\n' || codepoint == '\r') {
        return codepoint == 0x3000 ? font->px : font->px / 2;
    }
    int dx = 0;
    int dy = 0;
    int width = 0;
    int height = 0;
    int advance = 0;
    const uint8_t *bits =
        inkpane_font_glyph(font, codepoint, &dx, &dy, &width, &height, &advance);
    if (bits == NULL) {
        /* Missing glyph: hollow box, keeps text aligned. */
        int size = font->px - 4;
        int x = pen_x + 2;
        int y = baseline_y - size - 1;
        inkpane_canvas_frame(canvas, x, y, size, size, black);
        return font->px;
    }
    int stride = (width + 7) / 8;
    for (int row = 0; row < height; ++row) {
        const uint8_t *line = bits + (size_t)row * stride;
        for (int column = 0; column < width; ++column) {
            if (line[column >> 3] & (0x80u >> (column & 7))) {
                inkpane_canvas_pixel(canvas, pen_x + dx + column, baseline_y + dy + row, black);
            }
        }
    }
    return advance;
}

int inkpane_text_width(const inkpane_font_t *font, const char *text)
{
    if (font == NULL || text == NULL) {
        return 0;
    }
    int width = 0;
    const char *cursor = text;
    while (*cursor) {
        uint32_t codepoint = utf8_next(&cursor);
        width += glyph_advance(font, codepoint);
    }
    return width;
}

static int draw_run(inkpane_canvas_t *canvas, const inkpane_font_t *font, int x, int baseline,
                    const char *text, const char *stop, bool black)
{
    int pen = x;
    const char *cursor = text;
    while (cursor < stop && *cursor) {
        uint32_t codepoint = utf8_next(&cursor);
        pen += draw_glyph(canvas, font, pen, baseline, codepoint, black);
    }
    return pen - x;
}

int inkpane_text_draw(inkpane_canvas_t *canvas, const inkpane_font_t *font, int x, int y,
                      const char *text, int max_width, inkpane_align_t align, bool black)
{
    if (canvas == NULL || font == NULL || text == NULL) {
        return 0;
    }
    int total = inkpane_text_width(font, text);
    int draw_width = total;
    const char *stop = text + strlen(text);

    if (max_width > 0 && total > max_width) {
        int ellipsis = glyph_advance(font, 0x2026);
        int used = 0;
        const char *cursor = text;
        const char *clipped = text;
        while (*cursor) {
            const char *start = cursor;
            uint32_t codepoint = utf8_next(&cursor);
            int advance = glyph_advance(font, codepoint);
            if (used + advance + ellipsis > max_width) {
                clipped = start;
                break;
            }
            used += advance;
        }
        stop = clipped;
        draw_width = used + ellipsis;
        total = draw_width;
    }

    int pen = x;
    if (align == INKPANE_ALIGN_CENTER) {
        pen = x + (max_width > 0 ? max_width - total : -total) / 2;
    } else if (align == INKPANE_ALIGN_RIGHT) {
        pen = x + (max_width > 0 ? max_width - total : 0);
    }

    int baseline = y + font->ascent;
    pen += draw_run(canvas, font, pen, baseline, text, stop, black);
    if (stop != text + strlen(text)) {
        draw_glyph(canvas, font, pen, baseline, 0x2026, black);
    }
    return draw_width;
}

/* ------------------------------------------------------------------ */
/* Small formatting helpers                                           */
/* ------------------------------------------------------------------ */

static void format_tenths(char *out, size_t size, float value)
{
    int tenths = (int)(value >= 0 ? value * 10.0f + 0.5f : value * 10.0f - 0.5f);
    int whole = tenths / 10;
    int frac = abs(tenths % 10);
    snprintf(out, size, "%d.%d", whole, frac);
}

static void format_hm(char *out, size_t size, int minutes)
{
    if (size < 6) {
        return;
    }
    if (minutes < 0) {
        memcpy(out, "--:--", 6);
        return;
    }
    int hour = (minutes / 60) % 24;
    int minute = minutes % 60;
    out[0] = (char)('0' + hour / 10);
    out[1] = (char)('0' + hour % 10);
    out[2] = ':';
    out[3] = (char)('0' + minute / 10);
    out[4] = (char)('0' + minute % 10);
    out[5] = '\0';
}

static void format_due(char *out, size_t size, const char *date_key)
{
    int year = 0;
    int month = 0;
    int day = 0;
    if (inkpane_parse_date_key(date_key, &year, &month, &day)) {
        if (size >= 6) {
            out[0] = (char)('0' + month / 10);
            out[1] = (char)('0' + month % 10);
            out[2] = '-';
            out[3] = (char)('0' + day / 10);
            out[4] = (char)('0' + day % 10);
            out[5] = '\0';
        } else if (size > 0) {
            out[0] = '\0';
        }
    } else if (size > 0) {
        out[0] = '\0';
    }
}

static const char *status_text(unsigned status)
{
    if (status & INKPANE_STATUS_AUTH) {
        return "令牌无效";
    }
    if (status & INKPANE_STATUS_OFFLINE) {
        return "离线";
    }
    if (status & INKPANE_STATUS_LOW_BATTERY) {
        return "低电";
    }
    return NULL;
}

/* ------------------------------------------------------------------ */
/* Modules                                                            */
/* ------------------------------------------------------------------ */

static void draw_clock(inkpane_canvas_t *canvas, const inkpane_rect_t *rect,
                       const inkpane_clock_t *clock, unsigned status)
{
    inkpane_canvas_fill(canvas, rect->x, rect->y, rect->w, rect->h, false);
    const inkpane_font_t *large = inkpane_font_large();
    const inkpane_font_t *small = inkpane_font_small();
    if (large == NULL || small == NULL) {
        return;
    }

    char time_text[8];
    if (clock->valid) {
        snprintf(time_text, sizeof(time_text), "%02d:%02d", clock->hour, clock->minute);
    } else {
        snprintf(time_text, sizeof(time_text), "--:--");
    }

    int cell = large->digit_advance > 0 ? large->digit_advance : large->px / 2;
    int total = cell * 5;
    int pen = rect->x + (rect->w - total) / 2;
    int baseline = rect->y + 6 + large->ascent;
    for (int i = 0; time_text[i] != '\0'; ++i) {
        uint32_t codepoint = (uint32_t)(unsigned char)time_text[i];
        int advance = glyph_advance(large, codepoint);
        draw_glyph(canvas, large, pen + (cell - advance) / 2, baseline, codepoint, true);
        pen += cell;
    }

    char label[64];
    if (clock->valid) {
        snprintf(label, sizeof(label), "%s %s", clock->weekday_label, clock->date_label);
    } else {
        snprintf(label, sizeof(label), "等待校时");
    }
    inkpane_text_draw(canvas, small, rect->x, rect->y + 6 + large->line_height, label,
                      rect->w, INKPANE_ALIGN_CENTER, true);

    const char *text = status_text(status);
    if (text != NULL) {
        inkpane_text_draw(canvas, small, rect->x + PAD, rect->y + rect->h - small->line_height - 2,
                          text, rect->w - 2 * PAD, INKPANE_ALIGN_RIGHT, true);
    }
}

static void draw_calendar(inkpane_canvas_t *canvas, const inkpane_rect_t *rect,
                          const inkpane_month_t *month)
{
    inkpane_canvas_fill(canvas, rect->x, rect->y, rect->w, rect->h, false);
    const inkpane_font_t *small = inkpane_font_small();
    if (small == NULL) {
        return;
    }
    char title[32];
    snprintf(title, sizeof(title), "%d年%d月", month->year, month->month);
    inkpane_text_draw(canvas, small, rect->x + PAD, rect->y + 2, title, rect->w - 2 * PAD,
                      INKPANE_ALIGN_LEFT, true);

    const int grid_x = rect->x + PAD;
    const int grid_w = rect->w - 2 * PAD;
    const int cell_w = grid_w / 7;
    const int header_y = rect->y + 24;
    for (int i = 0; i < 7; ++i) {
        inkpane_text_draw(canvas, small, grid_x + i * cell_w, header_y, inkpane_weekday_short(i),
                          cell_w, INKPANE_ALIGN_CENTER, true);
    }

    const int grid_y = rect->y + 44;
    const int row_h = 22;
    int day = 1;
    int first = month->first_weekday;
    for (int row = 0; row < 6 && day <= month->days_in_month; ++row) {
        for (int column = 0; column < 7 && day <= month->days_in_month; ++column) {
            if (row == 0 && column < first) {
                continue;
            }
            int cx = grid_x + column * cell_w;
            int cy = grid_y + row * row_h;
            char number[4];
            if (day >= 10) {
                number[0] = (char)('0' + day / 10);
                number[1] = (char)('0' + day % 10);
                number[2] = '\0';
            } else {
                number[0] = (char)('0' + day);
                number[1] = '\0';
            }
            if (day == month->today) {
                inkpane_canvas_fill(canvas, cx + 2, cy, cell_w - 4, row_h - 2, true);
                inkpane_text_draw(canvas, small, cx, cy + 1, number, cell_w, INKPANE_ALIGN_CENTER,
                                  false);
            } else {
                inkpane_text_draw(canvas, small, cx, cy + 1, number, cell_w, INKPANE_ALIGN_CENTER,
                                  true);
            }
            for (int i = 0; i < month->mark_count; ++i) {
                if (month->marks[i] == day) {
                    bool white = day == month->today;
                    inkpane_canvas_fill(canvas, cx + cell_w / 2 - 1, cy + row_h - 3, 2, 2, !white);
                }
            }
            day++;
        }
    }
}

static void draw_weather(inkpane_canvas_t *canvas, const inkpane_rect_t *rect,
                         const inkpane_weather_t *weather)
{
    inkpane_canvas_fill(canvas, rect->x, rect->y, rect->w, rect->h, false);
    const inkpane_font_t *small = inkpane_font_small();
    const inkpane_font_t *large = inkpane_font_large();
    const inkpane_font_t *medium = inkpane_font_medium();
    if (small == NULL || large == NULL) {
        return;
    }

    if (!weather->present) {
        inkpane_text_draw(canvas, medium != NULL ? medium : small, rect->x, rect->y + rect->h / 2,
                          "天气暂无数据", rect->w, INKPANE_ALIGN_CENTER, true);
        return;
    }

    inkpane_text_draw(canvas, small, rect->x + PAD, rect->y + 2, weather->city, rect->w - 2 * PAD,
                      INKPANE_ALIGN_LEFT, true);

    char value[32];
    format_tenths(value, sizeof(value), weather->temperature);
    char temperature[40];
    snprintf(temperature, sizeof(temperature), "%s°", value);
    inkpane_text_draw(canvas, large, rect->x + PAD, rect->y + 24, temperature, rect->w - 2 * PAD,
                      INKPANE_ALIGN_LEFT, true);

    inkpane_text_draw(canvas, small, rect->x + PAD, rect->y + 24 + large->line_height,
                      weather->condition, rect->w - 2 * PAD, INKPANE_ALIGN_LEFT, true);

    char details[64];
    snprintf(details, sizeof(details), "湿度 %d%%  风 %.0fkm/h", (int)weather->humidity,
             weather->wind_speed);
    inkpane_text_draw(canvas, small, rect->x + PAD, rect->y + 24 + large->line_height + 22,
                      details, rect->w - 2 * PAD, INKPANE_ALIGN_LEFT, true);

    int line_y = rect->y + 24 + large->line_height + 46;
    inkpane_canvas_hline(canvas, rect->x + PAD, line_y, rect->w - 2 * PAD, true);
    inkpane_text_draw(canvas, small, rect->x + PAD, line_y + 4, "未来三天", rect->w - 2 * PAD,
                      INKPANE_ALIGN_LEFT, true);

    for (int i = 0; i < weather->forecast_count; ++i) {
        int row_y = line_y + 26 + i * 34;
        if (row_y + 24 > rect->y + rect->h) {
            break;
        }
        inkpane_text_draw(canvas, small, rect->x + PAD, row_y, weather->forecast[i].weekday, 40,
                          INKPANE_ALIGN_LEFT, true);
        inkpane_text_draw(canvas, small, rect->x + PAD + 44, row_y, weather->forecast[i].condition,
                          rect->w - 110, INKPANE_ALIGN_LEFT, true);
        char range[32];
        int minimum = (int)(weather->forecast[i].min + (weather->forecast[i].min >= 0 ? 0.5f : -0.5f));
        int maximum = (int)(weather->forecast[i].max + (weather->forecast[i].max >= 0 ? 0.5f : -0.5f));
        snprintf(range, sizeof(range), "%d~%d°", minimum, maximum);
        inkpane_text_draw(canvas, small, rect->x + rect->w - PAD - 66, row_y, range, 66,
                          INKPANE_ALIGN_RIGHT, true);
    }
}

static void draw_event_list(inkpane_canvas_t *canvas, const inkpane_rect_t *rect,
                            const inkpane_event_t *events, int count, int total, bool courses)
{
    inkpane_canvas_fill(canvas, rect->x, rect->y, rect->w, rect->h, false);
    const inkpane_font_t *small = inkpane_font_small();
    const inkpane_font_t *title_font = courses ? small : inkpane_font_medium();
    if (small == NULL || title_font == NULL) {
        return;
    }
    /* `total` may exceed what the payload carried and what fits on screen. */
    if (total < count) {
        total = count;
    }

    inkpane_text_draw(canvas, small, rect->x + PAD, rect->y + 2, courses ? "今日课程" : "今日日程",
                      rect->w - 2 * PAD, INKPANE_ALIGN_LEFT, true);

    char counter[16];
    snprintf(counter, sizeof(counter), "%d 项", total);
    inkpane_text_draw(canvas, small, rect->x + PAD, rect->y + 2, counter, rect->w - 2 * PAD,
                      INKPANE_ALIGN_RIGHT, true);

    int divider_y = rect->y + (courses ? 22 : 30);
    inkpane_canvas_hline(canvas, rect->x + PAD, divider_y, rect->w - 2 * PAD, true);

    if (total == 0) {
        inkpane_text_draw(canvas, title_font, rect->x, rect->y + rect->h / 2 - 12,
                          courses ? "今日无课" : "今天没有日程", rect->w, INKPANE_ALIGN_CENTER, true);
        return;
    }

    int row_h = courses ? 26 : 34;
    int start_y = divider_y + 6;
    int max_rows = (rect->y + rect->h - start_y) / row_h;
    int rows = count < max_rows ? count : max_rows;
    if (rows < 0) {
        rows = 0;
    }
    if (rows > 0 && rows < total) {
        rows -= 1; /* reserve one row for the "more" hint */
    }
    for (int i = 0; i < rows; ++i) {
        int row_y = start_y + i * row_h;
        char time_text[8];
        if (events[i].all_day) {
            snprintf(time_text, sizeof(time_text), "全天");
        } else {
            format_hm(time_text, sizeof(time_text), events[i].start_minute);
        }
        int time_w = courses ? 44 : 54;
        inkpane_text_draw(canvas, small, rect->x + PAD, row_y, time_text, time_w,
                          INKPANE_ALIGN_LEFT, true);
        inkpane_text_draw(canvas, title_font, rect->x + PAD + time_w + 4, row_y, events[i].title,
                          rect->w - (PAD * 2 + time_w + 4), INKPANE_ALIGN_LEFT, true);
    }
    if (rows < total) {
        char more[32];
        snprintf(more, sizeof(more), "还有 %d 项", total - rows);
        inkpane_text_draw(canvas, small, rect->x + PAD + 54, start_y + rows * row_h, more,
                          rect->w - 2 * PAD - 54, INKPANE_ALIGN_LEFT, true);
    }
}

static void draw_event_list_any(inkpane_canvas_t *canvas, const inkpane_rect_t *rect,
                                const inkpane_event_t *events, int count, int total, bool courses);

static void draw_todos(inkpane_canvas_t *canvas, const inkpane_rect_t *rect,
                       const inkpane_screen_t *screen)
{
    inkpane_canvas_fill(canvas, rect->x, rect->y, rect->w, rect->h, false);
    const inkpane_font_t *small = inkpane_font_small();
    if (small == NULL) {
        return;
    }
    int total = screen->todo_total;
    if (total < screen->todo_count) {
        total = screen->todo_count;
    }

    inkpane_text_draw(canvas, small, rect->x + PAD, rect->y + 2, "待办", rect->w - 2 * PAD,
                      INKPANE_ALIGN_LEFT, true);
    char counter[16];
    snprintf(counter, sizeof(counter), "%d 项", total);
    inkpane_text_draw(canvas, small, rect->x + PAD, rect->y + 2, counter, rect->w - 2 * PAD,
                      INKPANE_ALIGN_RIGHT, true);
    inkpane_canvas_hline(canvas, rect->x + PAD, rect->y + 22, rect->w - 2 * PAD, true);

    if (total == 0) {
        inkpane_text_draw(canvas, small, rect->x, rect->y + rect->h / 2 - 10, "没有待办", rect->w,
                          INKPANE_ALIGN_CENTER, true);
        return;
    }

    int start_y = rect->y + 30;
    int row_h = 26;
    int max_rows = (rect->y + rect->h - start_y) / row_h;
    int rows = screen->todo_count < max_rows ? screen->todo_count : max_rows;
    if (rows < 0) {
        rows = 0;
    }
    if (rows > 0 && rows < total) {
        rows -= 1; /* reserve one row for the "more" hint */
    }
    for (int i = 0; i < rows; ++i) {
        const inkpane_todo_t *todo = &screen->todos[i];
        int row_y = start_y + i * row_h;
        bool urgent = strcmp(todo->priority, "urgent") == 0 || strcmp(todo->priority, "high") == 0;
        inkpane_canvas_frame(canvas, rect->x + PAD, row_y + 4, 11, 11, true);
        if (urgent) {
            inkpane_canvas_fill(canvas, rect->x + PAD + 3, row_y + 7, 5, 5, true);
        }
        char due[8] = {0};
        format_due(due, sizeof(due), todo->due_date);
        int due_w = due[0] ? 48 : 0;
        inkpane_text_draw(canvas, small, rect->x + PAD + 18, row_y, todo->title,
                          rect->w - 2 * PAD - 18 - due_w, INKPANE_ALIGN_LEFT, true);
        if (due_w > 0) {
            inkpane_text_draw(canvas, small, rect->x + rect->w - PAD - due_w, row_y, due, due_w,
                              INKPANE_ALIGN_RIGHT, true);
        }
    }
    if (rows < total) {
        char more[32];
        snprintf(more, sizeof(more), "还有 %d 项", total - rows);
        inkpane_text_draw(canvas, small, rect->x + PAD, start_y + rows * row_h, more,
                          rect->w - 2 * PAD, INKPANE_ALIGN_LEFT, true);
    }
}

/* ------------------------------------------------------------------ */
/* Entry points                                                       */
/* ------------------------------------------------------------------ */

esp_err_t inkpane_ui_init(const uint8_t *font_blob, size_t font_size)
{
    esp_err_t err;
    if (font_blob != NULL) {
        err = inkpane_font_load(font_blob, font_size);
    } else {
        err = inkpane_font_load_embedded();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "font load failed: %s", esp_err_to_name(err));
        return err;
    }
    if (inkpane_font_small() == NULL || inkpane_font_medium() == NULL || inkpane_font_large() == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    return ESP_OK;
}

static inkpane_clock_t clock_from_screen(const inkpane_screen_t *screen)
{
    inkpane_clock_t clock = {
        .valid = screen->now_valid,
        .hour = screen->now_hour,
        .minute = screen->now_minute,
        .month = screen->now_local.month,
        .day = screen->now_local.day,
    };
    snprintf(clock.weekday_label, sizeof(clock.weekday_label), "%s", screen->now_weekday);
    snprintf(clock.date_label, sizeof(clock.date_label), "%s", screen->now_date_label);
    clock.weekday = screen->now_local.month > 0
                        ? inkpane_weekday_of_date(screen->now_local.year, screen->now_local.month,
                                                  screen->now_local.day)
                        : 0;
    return clock;
}

void inkpane_ui_render_full(uint8_t *framebuffer, const inkpane_screen_t *screen)
{
    if (framebuffer == NULL || screen == NULL) {
        return;
    }
    inkpane_canvas_t canvas;
    inkpane_canvas_init(&canvas, framebuffer, INKPANE_SCREEN_WIDTH, INKPANE_SCREEN_HEIGHT, 0, 0);
    inkpane_canvas_clear(&canvas, true);

    const inkpane_rect_t *rects = screen->modules;
    if (rects[INKPANE_MODULE_CLOCK].enabled) {
        inkpane_canvas_set_clip(&canvas, rects[INKPANE_MODULE_CLOCK].x, rects[INKPANE_MODULE_CLOCK].y,
                                rects[INKPANE_MODULE_CLOCK].w, rects[INKPANE_MODULE_CLOCK].h);
        inkpane_clock_t clock = clock_from_screen(screen);
        draw_clock(&canvas, &rects[INKPANE_MODULE_CLOCK], &clock, 0);
    }
    if (rects[INKPANE_MODULE_CALENDAR].enabled) {
        inkpane_canvas_set_clip(&canvas, rects[INKPANE_MODULE_CALENDAR].x,
                                rects[INKPANE_MODULE_CALENDAR].y, rects[INKPANE_MODULE_CALENDAR].w,
                                rects[INKPANE_MODULE_CALENDAR].h);
        draw_calendar(&canvas, &rects[INKPANE_MODULE_CALENDAR], &screen->month);
    }
    if (rects[INKPANE_MODULE_WEATHER].enabled) {
        inkpane_canvas_set_clip(&canvas, rects[INKPANE_MODULE_WEATHER].x,
                                rects[INKPANE_MODULE_WEATHER].y, rects[INKPANE_MODULE_WEATHER].w,
                                rects[INKPANE_MODULE_WEATHER].h);
        draw_weather(&canvas, &rects[INKPANE_MODULE_WEATHER], &screen->weather);
    }
    if (rects[INKPANE_MODULE_SCHEDULE].enabled) {
        inkpane_canvas_set_clip(&canvas, rects[INKPANE_MODULE_SCHEDULE].x,
                                rects[INKPANE_MODULE_SCHEDULE].y, rects[INKPANE_MODULE_SCHEDULE].w,
                                rects[INKPANE_MODULE_SCHEDULE].h);
        draw_event_list_any(&canvas, &rects[INKPANE_MODULE_SCHEDULE], screen->events,
                            screen->event_count, screen->event_total, false);
    }
    if (rects[INKPANE_MODULE_COURSES].enabled) {
        inkpane_canvas_set_clip(&canvas, rects[INKPANE_MODULE_COURSES].x,
                                rects[INKPANE_MODULE_COURSES].y, rects[INKPANE_MODULE_COURSES].w,
                                rects[INKPANE_MODULE_COURSES].h);
        draw_event_list_any(&canvas, &rects[INKPANE_MODULE_COURSES], screen->courses,
                            screen->course_count, screen->course_total, true);
    }
    if (rects[INKPANE_MODULE_TODOS].enabled) {
        inkpane_canvas_set_clip(&canvas, rects[INKPANE_MODULE_TODOS].x, rects[INKPANE_MODULE_TODOS].y,
                                rects[INKPANE_MODULE_TODOS].w, rects[INKPANE_MODULE_TODOS].h);
        draw_todos(&canvas, &rects[INKPANE_MODULE_TODOS], screen);
    }
    inkpane_canvas_clear_clip(&canvas);
}

static void draw_event_list_any(inkpane_canvas_t *canvas, const inkpane_rect_t *rect,
                                const inkpane_event_t *events, int count, int total, bool courses)
{
    draw_event_list(canvas, rect, events, count, total, courses);
}

void inkpane_ui_render_clock(uint8_t *framebuffer, const inkpane_rect_t *rect,
                             const inkpane_clock_t *clock, unsigned status)
{
    if (framebuffer == NULL || rect == NULL || clock == NULL) {
        return;
    }
    inkpane_canvas_t canvas;
    inkpane_canvas_init(&canvas, framebuffer, INKPANE_SCREEN_WIDTH, INKPANE_SCREEN_HEIGHT, 0, 0);
    inkpane_canvas_set_clip(&canvas, rect->x, rect->y, rect->w, rect->h);
    draw_clock(&canvas, rect, clock, status);
    inkpane_canvas_clear_clip(&canvas);
}

void inkpane_ui_render_setup(uint8_t *framebuffer, const char *ap_ssid, const char *url)
{
    if (framebuffer == NULL) {
        return;
    }
    inkpane_canvas_t canvas;
    inkpane_canvas_init(&canvas, framebuffer, INKPANE_SCREEN_WIDTH, INKPANE_SCREEN_HEIGHT, 0, 0);
    inkpane_canvas_clear(&canvas, true);

    const inkpane_font_t *large = inkpane_font_large();
    const inkpane_font_t *medium = inkpane_font_medium();
    const inkpane_font_t *small = inkpane_font_small();
    if (large == NULL || medium == NULL || small == NULL) {
        return;
    }

    inkpane_text_draw(&canvas, large, 40, 40, "InkPane 墨窗 · 配网", INKPANE_SCREEN_WIDTH - 80,
                      INKPANE_ALIGN_LEFT, true);
    inkpane_canvas_hline(&canvas, 40, 104, INKPANE_SCREEN_WIDTH - 80, true);

    char line[160];
    snprintf(line, sizeof(line), "1. 连接 Wi-Fi：%s", ap_ssid ? ap_ssid : "InkPane-XXXX");
    inkpane_text_draw(&canvas, medium, 40, 140, line, INKPANE_SCREEN_WIDTH - 80,
                      INKPANE_ALIGN_LEFT, true);
    snprintf(line, sizeof(line), "2. 浏览器打开 %s", url ? url : "http://192.168.4.1");
    inkpane_text_draw(&canvas, medium, 40, 200, line, INKPANE_SCREEN_WIDTH - 80,
                      INKPANE_ALIGN_LEFT, true);
    inkpane_text_draw(&canvas, medium, 40, 260, "3. 填写 Wi-Fi、服务地址与设备令牌",
                      INKPANE_SCREEN_WIDTH - 80, INKPANE_ALIGN_LEFT, true);
    inkpane_text_draw(&canvas, medium, 40, 320, "4. 保存后设备会自动重启", INKPANE_SCREEN_WIDTH - 80,
                      INKPANE_ALIGN_LEFT, true);
    inkpane_text_draw(&canvas, small, 40, 400, "配网 10 分钟无操作将自动重启", INKPANE_SCREEN_WIDTH - 80,
                      INKPANE_ALIGN_LEFT, true);
}
