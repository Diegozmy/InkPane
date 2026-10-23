#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "inkpane_time.h"

#define INKPANE_SCREEN_WIDTH 800
#define INKPANE_SCREEN_HEIGHT 480
#define INKPANE_MAX_MODULES 6
#define INKPANE_MAX_EVENTS 32
#define INKPANE_MAX_COURSES 16
#define INKPANE_MAX_TODOS 8
#define INKPANE_MAX_MARKS 31
#define INKPANE_MAX_FORECAST 3
#define INKPANE_TITLE_LEN 96
#define INKPANE_LOCATION_LEN 48
#define INKPANE_TEXT_LEN 32
#define INKPANE_DATE_KEY_LEN 11
#define INKPANE_LABEL_LEN 24
#define INKPANE_TIME_LEN 8
#define INKPANE_WEEKDAY_LEN 16
#define INKPANE_SCHEMA_VERSION 1

typedef enum {
    INKPANE_MODULE_CLOCK = 0,
    INKPANE_MODULE_CALENDAR,
    INKPANE_MODULE_WEATHER,
    INKPANE_MODULE_SCHEDULE,
    INKPANE_MODULE_COURSES,
    INKPANE_MODULE_TODOS,
    INKPANE_MODULE_COUNT
} inkpane_module_id_t;

typedef struct {
    int x;
    int y;
    int w;
    int h;
    bool enabled;
    bool present;
} inkpane_rect_t;

typedef struct {
    char title[INKPANE_TITLE_LEN];
    char location[INKPANE_LOCATION_LEN];
    bool all_day;
    bool is_course;
    int start_minute; /* minutes after local midnight, -1 for all-day */
    int end_minute;
    char color[8];
} inkpane_event_t;

typedef struct {
    char title[INKPANE_TITLE_LEN];
    char due_date[INKPANE_DATE_KEY_LEN];
    char priority[8];
} inkpane_todo_t;

typedef struct {
    bool present;
    char city[INKPANE_TEXT_LEN];
    char condition[INKPANE_TEXT_LEN];
    char icon[INKPANE_LABEL_LEN];
    float temperature;
    float apparent_temperature;
    float humidity;
    float wind_speed;
    int weather_code;
    bool is_day;
    float today_min;
    float today_max;
    int precipitation_probability;
    char today_condition[INKPANE_TEXT_LEN];
    int forecast_count;
    struct {
        char weekday[INKPANE_WEEKDAY_LEN];
        float min;
        float max;
        int precipitation_probability;
        char condition[INKPANE_TEXT_LEN];
        char icon[INKPANE_LABEL_LEN];
    } forecast[INKPANE_MAX_FORECAST];
} inkpane_weather_t;

typedef struct {
    bool present;
    int year;
    int month;
    int first_weekday; /* 0 = Sunday */
    int days_in_month;
    int today;
    int mark_count;
    uint8_t marks[INKPANE_MAX_MARKS];
} inkpane_month_t;

typedef struct {
    int schema_version;
    char timezone[40];
    int refresh_minutes;

    inkpane_rect_t modules[INKPANE_MAX_MODULES];

    char now_time[INKPANE_TIME_LEN];
    char now_weekday[INKPANE_WEEKDAY_LEN];
    char now_date[INKPANE_DATE_KEY_LEN];
    char now_date_label[INKPANE_LABEL_LEN];
    int now_hour;
    int now_minute;
    int64_t now_epoch;
    int utc_offset_minutes;
    inkpane_datetime_t now_local;
    bool now_valid;

    inkpane_month_t month;
    inkpane_weather_t weather;

    int event_count;
    inkpane_event_t events[INKPANE_MAX_EVENTS];
    int course_count;
    inkpane_event_t courses[INKPANE_MAX_COURSES];
    int todo_count;
    inkpane_todo_t todos[INKPANE_MAX_TODOS];
} inkpane_screen_t;

/** Default layout rectangles (same as the console defaults). */
const inkpane_rect_t *inkpane_default_rects(void);

/** Reset to defaults (all modules present + enabled). */
void inkpane_screen_reset(inkpane_screen_t *screen);

const char *inkpane_module_name(inkpane_module_id_t id);

/**
 * Parse `{ "data": <DeviceScreenPayload> }`.
 * `arena` backs every JSON node; 256 KB is plenty for a full payload.
 * Returns false only when the envelope itself is unparseable.
 */
bool inkpane_screen_parse(const char *json, size_t len, inkpane_screen_t *screen, char *arena,
                          size_t arena_size);
