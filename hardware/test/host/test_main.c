#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "inkpane_canvas.h"
#include "inkpane_font.h"
#include "inkpane_model.h"
#include "inkpane_schedule.h"
#include "inkpane_time.h"
#include "inkpane_ui.h"

static int g_failures;
static const char *g_font_path;
static const char *g_fixture_dir;

#define FB_SIZE (800 * 480 / 8)

#define CHECK(condition)                                                               \
    do {                                                                               \
        if (!(condition)) {                                                            \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);                \
            g_failures++;                                                              \
        }                                                                              \
    } while (0)

#define CHECK_STR(actual, expected)                                                    \
    do {                                                                               \
        const char *a_ = (actual);                                                     \
        const char *e_ = (expected);                                                   \
        if (a_ == NULL || strcmp(a_, e_) != 0) {                                       \
            printf("FAIL %s:%d: \"%s\" != \"%s\"\n", __FILE__, __LINE__,                \
                   a_ ? a_ : "(null)", e_);                                            \
            g_failures++;                                                              \
        }                                                                              \
    } while (0)

static char *read_file(const char *path, size_t *length)
{
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        printf("cannot open %s\n", path);
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
    if (length != NULL) {
        *length = read;
    }
    return buffer;
}

static char *fixture_path(const char *name)
{
    static char path[512];
    snprintf(path, sizeof(path), "%s/%s", g_fixture_dir, name);
    return path;
}

static void test_time(void)
{
    inkpane_datetime_t dt;
    CHECK(inkpane_parse_iso_local("2026-10-18T11:40:00", &dt));
    CHECK(dt.year == 2026);
    CHECK(dt.month == 10);
    CHECK(dt.day == 18);
    CHECK(dt.hour == 11);
    CHECK(dt.minute == 40);
    CHECK(inkpane_weekday_of_date(2026, 10, 18) == 0); /* Sunday */
    CHECK(inkpane_weekday_of_date(2026, 10, 19) == 1);
    CHECK(inkpane_days_in_month(2024, 2) == 29);
    CHECK(inkpane_days_in_month(2025, 2) == 28);
    CHECK(!inkpane_parse_iso_local("2025-02-29T00:00:00", &dt));
    CHECK(inkpane_parse_iso_local("2024-02-29T00:00:00", &dt));

    int64_t epoch = 0;
    CHECK(inkpane_parse_iso_utc("2026-10-18T03:40:00.000Z", &epoch));
    CHECK(epoch % 86400 == 3 * 3600 + 40 * 60);
    CHECK(inkpane_parse_http_date("Sun, 18 Oct 2026 03:40:00 GMT", &epoch));
    CHECK(epoch % 86400 == 3 * 3600 + 40 * 60);

    char label[24];
    inkpane_date_label(2026, 10, 18, label, sizeof(label));
    CHECK_STR(label, "10月18日");
    CHECK_STR(inkpane_weekday_label(0), "周日");
    CHECK_STR(inkpane_weekday_short(1), "一");

    inkpane_datetime_t round_trip = {2026, 10, 18, 11, 40, 30};
    int64_t local = inkpane_local_epoch(&round_trip);
    inkpane_datetime_t back;
    inkpane_datetime_from_local_epoch(local, &back);
    CHECK(back.year == 2026 && back.month == 10 && back.day == 18);
    CHECK(back.hour == 11 && back.minute == 40 && back.second == 30);
}

static void test_schedule(void)
{
    CHECK(inkpane_seconds_to_next_minute(30) == 31);
    CHECK(inkpane_seconds_to_next_minute(59) == 2);
    CHECK(inkpane_seconds_to_next_minute(0) == 61);
    CHECK(inkpane_should_fetch(true, false, true, 100, 200));
    CHECK(inkpane_should_fetch(false, false, true, 200, 200));
    CHECK(!inkpane_should_fetch(false, false, true, 199, 200));
    CHECK(inkpane_should_fetch(false, true, true, 100, 200));
    CHECK(inkpane_should_fetch(false, false, false, 100, 200));
    CHECK(inkpane_should_force_full(true, false, false, 0, 60));
    CHECK(inkpane_should_force_full(false, true, false, 0, 60));
    CHECK(!inkpane_should_force_full(false, false, true, 59, 60));
    CHECK(inkpane_should_force_full(false, false, true, 60, 60));
    CHECK(!inkpane_should_force_full(false, false, false, 100, 60));
    CHECK(inkpane_backoff_seconds(1, 30) == 300);
    CHECK(inkpane_backoff_seconds(10, 30) == 1800);
    CHECK(inkpane_backoff_seconds(10, 5) == 300);
}

static void test_model(void)
{
    size_t length = 0;
    char *text = read_file(fixture_path("screen_200.json"), &length);
    CHECK(text != NULL);
    if (text == NULL) {
        return;
    }
    char *arena = malloc(256 * 1024);
    inkpane_screen_t *screen = malloc(sizeof(inkpane_screen_t));
    CHECK(arena != NULL && screen != NULL);
    if (arena == NULL || screen == NULL) {
        free(text);
        return;
    }
    CHECK(inkpane_screen_parse(text, length, screen, arena, 256 * 1024));
    CHECK(screen->schema_version == 1);
    CHECK(screen->refresh_minutes == 30);
    CHECK(screen->utc_offset_minutes == 480);
    CHECK_STR(screen->now_time, "11:40");
    CHECK_STR(screen->now_weekday, "周日");
    CHECK_STR(screen->now_date, "2026-10-18");
    CHECK_STR(screen->now_date_label, "10月18日");
    CHECK(screen->now_valid);
    CHECK(screen->now_local.hour == 11 && screen->now_local.minute == 40);
    CHECK(screen->event_count == 3);
    CHECK(screen->course_count == 0);
    CHECK(screen->todo_count == 3);
    CHECK(screen->modules[INKPANE_MODULE_CLOCK].x == 16);
    CHECK(screen->modules[INKPANE_MODULE_SCHEDULE].w == 284);
    CHECK(screen->month.present);
    CHECK(screen->month.today == 18);
    CHECK(screen->month.mark_count == 9);
    CHECK(screen->weather.present);
    CHECK_STR(screen->weather.city, "上海");
    CHECK_STR(screen->weather.condition, "多云");
    CHECK(screen->weather.forecast_count == 3);
    CHECK(screen->events[0].start_minute == 11 * 60); /* 03:00Z + 8h */
    CHECK(screen->events[1].all_day);
    CHECK(screen->events[1].start_minute == -1);
    CHECK_STR(screen->todos[0].priority, "high");
    CHECK_STR(screen->todos[1].due_date, "2026-10-20");
    CHECK(screen->todos[2].due_date[0] == '\0');

    free(text);
    text = read_file(fixture_path("screen_weather_null.json"), &length);
    CHECK(text != NULL);
    if (text != NULL) {
        CHECK(inkpane_screen_parse(text, length, screen, arena, 256 * 1024));
        CHECK(!screen->weather.present);
        CHECK(screen->event_count == 0);
        CHECK(screen->todo_count == 0);
        CHECK(screen->month.mark_count == 0);
        CHECK(screen->refresh_minutes == 15);
        free(text);
    }

    CHECK(!inkpane_screen_parse("{\"data\":", 8, screen, arena, 256 * 1024));

    const char *partial = "{\"data\":{\"screen\":{\"refreshMinutes\":30,\"layout\":{\"modules\":["
                          "{\"id\":\"clock\",\"enabled\":false,\"x\":3,\"y\":16,\"w\":220,\"h\":100},"
                          "{\"id\":\"clock\",\"enabled\":false,\"x\":32,\"y\":16,\"w\":220,\"h\":100}"
                          "]}}}}";
    CHECK(inkpane_screen_parse(partial, strlen(partial), screen, arena, 256 * 1024));
    CHECK(screen->modules[INKPANE_MODULE_CLOCK].x == 32);
    CHECK(!screen->modules[INKPANE_MODULE_CLOCK].enabled);

    free(arena);
    free(screen);
}

static void test_font_and_text(void)
{
    size_t length = 0;
    char *blob = read_file(g_font_path, &length);
    CHECK(blob != NULL);
    if (blob == NULL) {
        return;
    }
    CHECK(inkpane_ui_init((const uint8_t *)blob, length) == ESP_OK);
    const inkpane_font_t *small = inkpane_font_small();
    const inkpane_font_t *large = inkpane_font_large();
    CHECK(small != NULL && large != NULL);
    if (small == NULL || large == NULL) {
        free(blob);
        return;
    }
    CHECK(small->px == 16 && small->line_height == 22);
    CHECK(large->px == 32);
    CHECK(large->digit_advance > 0);

    int dx = 0, dy = 0, w = 0, h = 0, advance = 0;
    CHECK(inkpane_font_glyph(small, 0x4E2D, &dx, &dy, &w, &h, &advance) != NULL);
    CHECK(w >= 14 && w <= 16 && h >= 14 && h <= 16);
    CHECK(inkpane_font_glyph(small, 'A', &dx, &dy, &w, &h, &advance) != NULL);
    CHECK(inkpane_font_glyph(small, 0x2026, &dx, &dy, &w, &h, &advance) != NULL);
    CHECK(inkpane_font_glyph(small, 0x1F600, &dx, &dy, &w, &h, &advance) == NULL);

    CHECK(inkpane_text_width(small, "数学竞赛辅导") == 16 * 6);
    CHECK(inkpane_text_width(large, "11:40") > 0);
    CHECK(inkpane_text_width(small, "订正物理周测卷") == 16 * 7);

    static uint8_t framebuffer[FB_SIZE];
    inkpane_canvas_t canvas;
    inkpane_canvas_init(&canvas, framebuffer, 800, 480, 0, 0);
    inkpane_canvas_clear(&canvas, true);

    int drawn = inkpane_text_draw(&canvas, small, 10, 10, "数学竞赛辅导", 100, INKPANE_ALIGN_LEFT,
                                  true);
    CHECK(drawn <= 100);
    int ink = 0;
    for (size_t i = 0; i < sizeof(framebuffer); ++i) {
        if (framebuffer[i] != 0xFF) {
            ink++;
        }
    }
    CHECK(ink > 0);

    inkpane_canvas_clear(&canvas, true);
    const char *long_text = "订正物理周测卷并准备英语演讲提纲和归还图书馆借书";
    drawn = inkpane_text_draw(&canvas, small, 10, 10, long_text, 120, INKPANE_ALIGN_LEFT, true);
    CHECK(drawn <= 120);

    inkpane_canvas_clear(&canvas, true);
    for (int i = 0; i < 200; ++i) {
        inkpane_canvas_pixel(&canvas, i, 0, true);
    }
    CHECK(framebuffer[0] == 0x00);

    /* The font module keeps a pointer into `blob`; intentionally not freed. */
}

static void test_render(void)
{
    size_t length = 0;
    char *text = read_file(fixture_path("screen_200.json"), &length);
    CHECK(text != NULL);
    if (text == NULL) {
        return;
    }
    char *arena = malloc(256 * 1024);
    inkpane_screen_t *screen = malloc(sizeof(inkpane_screen_t));
    CHECK(arena != NULL && screen != NULL);
    if (arena != NULL && screen != NULL) {
        CHECK(inkpane_screen_parse(text, length, screen, arena, 256 * 1024));
        static uint8_t framebuffer[FB_SIZE];
        inkpane_ui_render_full(framebuffer, screen);
        int ink = 0;
        for (size_t i = 0; i < sizeof(framebuffer); ++i) {
            if (framebuffer[i] != 0xFF) {
                ink++;
            }
        }
        CHECK(ink > 500);
    }
    free(arena);
    free(screen);
    free(text);
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    g_font_path = argc > 1 ? argv[1]
                           : "../../main/components/inkpane_ui/fonts/inkpane_fonts.bin";
    g_fixture_dir = argc > 2 ? argv[2] : "../fixtures";

    printf("== time ==\n");
    test_time();
    printf("== schedule ==\n");
    test_schedule();
    printf("== model ==\n");
    test_model();
    printf("== font ==\n");
    test_font_and_text();
    printf("== render ==\n");
    test_render();

    if (g_failures == 0) {
        printf("all host tests passed\n");
        return 0;
    }
    printf("%d host test(s) failed\n", g_failures);
    return 1;
}
