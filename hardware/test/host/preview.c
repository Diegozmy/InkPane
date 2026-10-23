#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "inkpane_model.h"
#include "inkpane_ui.h"

#define WIDTH 800
#define HEIGHT 480

static char *read_file(const char *path, size_t *length)
{
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        fprintf(stderr, "cannot open %s\n", path);
        return NULL;
    }
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    fseek(file, 0, SEEK_SET);
    char *buffer = malloc((size_t)size + 1);
    if (buffer == NULL) {
        fclose(file);
        return NULL;
    }
    size_t read = fread(buffer, 1, (size_t)size, file);
    fclose(file);
    buffer[read] = '\0';
    *length = read;
    return buffer;
}

static void write_le16(uint8_t *p, uint16_t value)
{
    p[0] = (uint8_t)(value & 0xFF);
    p[1] = (uint8_t)(value >> 8);
}

static void write_le32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)(value & 0xFF);
    p[1] = (uint8_t)((value >> 8) & 0xFF);
    p[2] = (uint8_t)((value >> 16) & 0xFF);
    p[3] = (uint8_t)((value >> 24) & 0xFF);
}

static int write_bmp(const char *path, const uint8_t *framebuffer)
{
    const int row_size = (WIDTH * 3 + 3) & ~3;
    const uint32_t pixel_size = (uint32_t)row_size * HEIGHT;
    uint8_t header[54] = {0};
    header[0] = 'B';
    header[1] = 'M';
    write_le32(&header[2], 54 + pixel_size);
    write_le32(&header[10], 54);
    write_le32(&header[14], 40);
    write_le32(&header[18], WIDTH);
    write_le32(&header[22], HEIGHT);
    write_le16(&header[26], 1);
    write_le16(&header[28], 24);
    write_le32(&header[34], pixel_size);

    FILE *file = fopen(path, "wb");
    if (file == NULL) {
        fprintf(stderr, "cannot write %s\n", path);
        return 1;
    }
    fwrite(header, 1, sizeof(header), file);
    uint8_t *row = calloc((size_t)row_size, 1);
    if (row == NULL) {
        fclose(file);
        return 1;
    }
    for (int y = HEIGHT - 1; y >= 0; --y) {
        memset(row, 0xFF, (size_t)row_size);
        for (int x = 0; x < WIDTH; ++x) {
            const uint8_t byte = framebuffer[y * (WIDTH / 8) + (x >> 3)];
            const bool white = (byte & (0x80u >> (x & 7))) != 0;
            uint8_t value = white ? 0xFF : 0x00;
            row[x * 3 + 0] = value;
            row[x * 3 + 1] = value;
            row[x * 3 + 2] = value;
        }
        fwrite(row, 1, (size_t)row_size, file);
    }
    free(row);
    fclose(file);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 4) {
        fprintf(stderr, "usage: %s <font.bin> <fixture.json> <out.bmp>\n", argv[0]);
        return 1;
    }
    size_t font_size = 0;
    char *font = read_file(argv[1], &font_size);
    if (font == NULL) {
        return 1;
    }
    if (inkpane_ui_init((const uint8_t *)font, font_size) != ESP_OK) {
        fprintf(stderr, "font load failed\n");
        return 1;
    }

    size_t json_size = 0;
    char *json = read_file(argv[2], &json_size);
    if (json == NULL) {
        return 1;
    }
    char *arena = malloc(256 * 1024);
    inkpane_screen_t *screen = malloc(sizeof(inkpane_screen_t));
    if (arena == NULL || screen == NULL) {
        return 1;
    }
    if (!inkpane_screen_parse(json, json_size, screen, arena, 256 * 1024)) {
        fprintf(stderr, "parse failed\n");
        return 1;
    }

    static uint8_t framebuffer[WIDTH * HEIGHT / 8];
    inkpane_ui_render_full(framebuffer, screen);
    int result = write_bmp(argv[3], framebuffer);
    if (result == 0) {
        printf("wrote %s\n", argv[3]);
    }
    free(font);
    free(json);
    free(arena);
    free(screen);
    return result;
}
