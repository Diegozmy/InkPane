#include "inkpane_font.h"

#include <string.h>

#define FONT_MAGIC 0x4E465049u /* "IPFN" little endian */
#define FONT_VERSION 1
#define FONT_DESC_SIZE 24
#define FONT_ENTRY_SIZE 16

static const uint8_t *s_blob;
static size_t s_blob_size;
static inkpane_font_t s_fonts[INKPANE_FONT_SIZES];
static int s_font_count;

#ifndef INKPANE_HOST_TEST
extern const uint8_t inkpane_fonts_bin_start[] asm("_binary_inkpane_fonts_bin_start");
extern const uint8_t inkpane_fonts_bin_end[] asm("_binary_inkpane_fonts_bin_end");
#endif

static uint16_t read_u16(const uint8_t *p)
{
    return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t read_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

esp_err_t inkpane_font_load(const uint8_t *data, size_t size)
{
    s_blob = NULL;
    s_font_count = 0;
    if (data == NULL || size < 8 + FONT_DESC_SIZE) {
        return ESP_ERR_INVALID_ARG;
    }
    if (read_u32(data) != FONT_MAGIC || read_u16(data + 4) != FONT_VERSION) {
        return ESP_ERR_INVALID_VERSION;
    }
    int count = read_u16(data + 6);
    if (count <= 0 || count > INKPANE_FONT_SIZES ||
        size < 8 + (size_t)count * FONT_DESC_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }

    for (int i = 0; i < count; ++i) {
        const uint8_t *desc = data + 8 + (size_t)i * FONT_DESC_SIZE;
        inkpane_font_t *font = &s_fonts[i];
        font->px = read_u16(desc + 0);
        font->line_height = read_u16(desc + 2);
        font->ascent = read_u16(desc + 4);
        font->glyph_count = read_u16(desc + 6);
        font->index_offset = read_u32(desc + 8);
        font->bitmap_offset = read_u32(desc + 12);
        font->bitmap_size = read_u32(desc + 16);
        font->digit_advance = read_u16(desc + 20);
        if ((size_t)font->index_offset + (size_t)font->glyph_count * FONT_ENTRY_SIZE > size ||
            (size_t)font->bitmap_offset + font->bitmap_size > size) {
            s_font_count = 0;
            return ESP_ERR_INVALID_SIZE;
        }
    }
    s_blob = data;
    s_blob_size = size;
    s_font_count = count;
    return ESP_OK;
}

esp_err_t inkpane_font_load_embedded(void)
{
#ifdef INKPANE_HOST_TEST
    return ESP_ERR_NOT_SUPPORTED;
#else
    return inkpane_font_load(inkpane_fonts_bin_start,
                             (size_t)(inkpane_fonts_bin_end - inkpane_fonts_bin_start));
#endif
}

const inkpane_font_t *inkpane_font(int px)
{
    for (int i = 0; i < s_font_count; ++i) {
        if (s_fonts[i].px == px) {
            return &s_fonts[i];
        }
    }
    return NULL;
}

const inkpane_font_t *inkpane_font_small(void)
{
    return inkpane_font(16);
}

const inkpane_font_t *inkpane_font_medium(void)
{
    return inkpane_font(24);
}

const inkpane_font_t *inkpane_font_large(void)
{
    return inkpane_font(32);
}

const uint8_t *inkpane_font_glyph(const inkpane_font_t *font, uint32_t codepoint, int *dx, int *dy,
                                  int *width, int *height, int *advance)
{
    (void)s_blob_size;
    if (font == NULL || s_blob == NULL || codepoint > 0x10FFFF) {
        return NULL;
    }
    int low = 0;
    int high = (int)font->glyph_count - 1;
    while (low <= high) {
        int mid = (low + high) / 2;
        const uint8_t *entry = s_blob + font->index_offset + (size_t)mid * FONT_ENTRY_SIZE;
        uint32_t value = read_u32(entry);
        if (value == codepoint) {
            uint32_t offset = read_u32(entry + 4);
            if ((size_t)offset >= font->bitmap_size) {
                return NULL;
            }
            if (dx) *dx = (int8_t)entry[8];
            if (dy) *dy = (int8_t)entry[9];
            if (width) *width = entry[10];
            if (height) *height = entry[11];
            if (advance) *advance = entry[12];
            return s_blob + font->bitmap_offset + offset;
        }
        if (value < codepoint) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return NULL;
}
