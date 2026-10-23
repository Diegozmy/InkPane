#include "inkpane_model.h"

#include <stdio.h>
#include <string.h>

#include "inkpane_json.h"

static const inkpane_rect_t DEFAULT_RECTS[INKPANE_MAX_MODULES] = {
    {16, 16, 220, 100, true, true},    /* clock */
    {16, 128, 220, 180, true, true},   /* calendar */
    {248, 16, 240, 288, true, true},   /* weather */
    {500, 16, 284, 448, true, true},   /* schedule */
    {248, 316, 240, 148, true, true},  /* courses */
    {16, 320, 220, 144, true, true},   /* todos */
};

static const char *MODULE_IDS[INKPANE_MAX_MODULES] = {"clock", "calendar", "weather",
                                                      "schedule", "courses", "todos"};

const inkpane_rect_t *inkpane_default_rects(void)
{
    return DEFAULT_RECTS;
}

const char *inkpane_module_name(inkpane_module_id_t id)
{
    if (id < 0 || id >= INKPANE_MODULE_COUNT) {
        return "";
    }
    static const char *NAMES[] = {"时钟", "月历", "天气", "今日日程", "今日课程", "待办"};
    return NAMES[id];
}

void inkpane_screen_reset(inkpane_screen_t *screen)
{
    memset(screen, 0, sizeof(*screen));
    screen->schema_version = INKPANE_SCHEMA_VERSION;
    screen->refresh_minutes = 30;
    memcpy(screen->modules, DEFAULT_RECTS, sizeof(DEFAULT_RECTS));
}

static void copy_utf8(char *dst, size_t dst_size, const char *src)
{
    if (dst_size == 0) {
        return;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return;
    }
    size_t len = strlen(src);
    if (len >= dst_size) {
        len = dst_size - 1;
        while (len > 0 && (((unsigned char)src[len]) & 0xC0) == 0x80) {
            len--;
        }
    }
    memcpy(dst, src, len);
    dst[len] = '\0';
}

static bool rect_is_valid(int x, int y, int w, int h)
{
    if (x < 0 || y < 0 || w < 80 || h < 48) {
        return false;
    }
    if ((x % 4) != 0 || (y % 4) != 0 || (w % 4) != 0 || (h % 4) != 0) {
        return false;
    }
    if (x + w > INKPANE_SCREEN_WIDTH || y + h > INKPANE_SCREEN_HEIGHT) {
        return false;
    }
    return true;
}

static int module_index(const char *id)
{
    for (int i = 0; i < INKPANE_MAX_MODULES; ++i) {
        if (strcmp(id, MODULE_IDS[i]) == 0) {
            return i;
        }
    }
    return -1;
}

static int local_minute_of(int64_t epoch_seconds, int utc_offset_minutes)
{
    int64_t local = epoch_seconds + (int64_t)utc_offset_minutes * 60;
    int64_t day_seconds = local % INKPANE_SECONDS_PER_DAY;
    if (day_seconds < 0) {
        day_seconds += INKPANE_SECONDS_PER_DAY;
    }
    return (int)(day_seconds / 60);
}

static void parse_layout(const json_value_t *data, inkpane_screen_t *screen)
{
    const json_value_t *screen_value = json_object_get(data, "screen");
    const json_value_t *refresh = json_object_get(screen_value, "refreshMinutes");
    if (refresh != NULL && refresh->type == JSON_NUMBER) {
        int minutes = (int)refresh->number;
        if (minutes >= 5 && minutes <= 720) {
            screen->refresh_minutes = minutes;
        }
    }

    const json_value_t *layout = json_object_get(screen_value, "layout");
    const json_value_t *modules = json_object_get(layout, "modules");
    int count = json_array_size(modules);
    for (int i = 0; i < count; ++i) {
        const json_value_t *module = json_array_at(modules, i);
        const char *id = json_string(json_object_get(module, "id"));
        if (id == NULL) {
            continue;
        }
        int index = module_index(id);
        if (index < 0) {
            continue;
        }
        int x = (int)json_number(json_object_get(module, "x"), -1);
        int y = (int)json_number(json_object_get(module, "y"), -1);
        int w = (int)json_number(json_object_get(module, "w"), -1);
        int h = (int)json_number(json_object_get(module, "h"), -1);
        bool enabled = json_bool(json_object_get(module, "enabled"), true);
        if (!rect_is_valid(x, y, w, h)) {
            continue;
        }
        screen->modules[index].x = x;
        screen->modules[index].y = y;
        screen->modules[index].w = w;
        screen->modules[index].h = h;
        screen->modules[index].enabled = enabled;
        screen->modules[index].present = true;
    }
}

static void parse_now(const json_value_t *data, inkpane_screen_t *screen)
{
    const json_value_t *now = json_object_get(data, "now");
    if (now == NULL) {
        return;
    }
    const char *time = json_string(json_object_get(now, "time"));
    const char *weekday = json_string(json_object_get(now, "weekday"));
    const char *date = json_string(json_object_get(now, "date"));
    const char *label = json_string(json_object_get(now, "dateLabel"));
    const char *local_iso = json_string(json_object_get(now, "localIso"));
    if (time != NULL) {
        copy_utf8(screen->now_time, sizeof(screen->now_time), time);
        int hour = 0;
        int minute = 0;
        if (sscanf(time, "%d:%d", &hour, &minute) == 2 && hour >= 0 && hour <= 23 && minute >= 0 &&
            minute <= 59) {
            screen->now_hour = hour;
            screen->now_minute = minute;
        }
    }
    if (weekday != NULL) {
        copy_utf8(screen->now_weekday, sizeof(screen->now_weekday), weekday);
    }
    if (date != NULL) {
        copy_utf8(screen->now_date, sizeof(screen->now_date), date);
    }
    if (label != NULL) {
        copy_utf8(screen->now_date_label, sizeof(screen->now_date_label), label);
    }
    if (local_iso != NULL && inkpane_parse_iso_local(local_iso, &screen->now_local)) {
        screen->now_valid = true;
    }
    screen->now_epoch = (int64_t)json_number(json_object_get(now, "epochSeconds"), 0);
    screen->utc_offset_minutes = (int)json_number(json_object_get(now, "utcOffsetMinutes"), 0);
}

static void parse_month(const json_value_t *data, inkpane_screen_t *screen)
{
    const json_value_t *month = json_object_get(data, "month");
    if (month == NULL || month->type != JSON_OBJECT) {
        return;
    }
    screen->month.present = true;
    screen->month.year = (int)json_number(json_object_get(month, "year"), 0);
    screen->month.month = (int)json_number(json_object_get(month, "month"), 0);
    screen->month.first_weekday = (int)json_number(json_object_get(month, "firstWeekday"), 0);
    screen->month.days_in_month = (int)json_number(json_object_get(month, "daysInMonth"), 0);
    screen->month.today = (int)json_number(json_object_get(month, "today"), 0);
    const json_value_t *marks = json_object_get(month, "marks");
    int count = json_array_size(marks);
    if (count > INKPANE_MAX_MARKS) {
        count = INKPANE_MAX_MARKS;
    }
    for (int i = 0; i < count; ++i) {
        int day = (int)json_number(json_array_at(marks, i), 0);
        if (day >= 1 && day <= 31) {
            screen->month.marks[screen->month.mark_count++] = (uint8_t)day;
        }
    }
}

static void parse_weather(const json_value_t *data, inkpane_screen_t *screen)
{
    const json_value_t *weather = json_object_get(data, "weather");
    if (weather == NULL || weather->type == JSON_NULL) {
        screen->weather.present = false;
        return;
    }
    screen->weather.present = true;
    const json_value_t *current = json_object_get(weather, "current");
    const json_value_t *today = json_object_get(weather, "today");
    copy_utf8(screen->weather.city, sizeof(screen->weather.city),
              json_string(json_object_get(weather, "city")));
    copy_utf8(screen->weather.condition, sizeof(screen->weather.condition),
              json_string(json_object_get(current, "condition")));
    copy_utf8(screen->weather.icon, sizeof(screen->weather.icon),
              json_string(json_object_get(current, "icon")));
    screen->weather.temperature = (float)json_number(json_object_get(current, "temperature"), 0);
    screen->weather.apparent_temperature =
        (float)json_number(json_object_get(current, "apparentTemperature"), 0);
    screen->weather.humidity = (float)json_number(json_object_get(current, "humidity"), 0);
    screen->weather.wind_speed = (float)json_number(json_object_get(current, "windSpeed"), 0);
    screen->weather.weather_code = (int)json_number(json_object_get(current, "weatherCode"), 0);
    screen->weather.is_day = json_bool(json_object_get(current, "isDay"), true);
    screen->weather.today_min = (float)json_number(json_object_get(today, "min"), 0);
    screen->weather.today_max = (float)json_number(json_object_get(today, "max"), 0);
    screen->weather.precipitation_probability =
        (int)json_number(json_object_get(today, "precipitationProbability"), 0);
    copy_utf8(screen->weather.today_condition, sizeof(screen->weather.today_condition),
              json_string(json_object_get(today, "condition")));

    const json_value_t *forecast = json_object_get(weather, "forecast");
    int count = json_array_size(forecast);
    if (count > INKPANE_MAX_FORECAST) {
        count = INKPANE_MAX_FORECAST;
    }
    screen->weather.forecast_count = count;
    for (int i = 0; i < count; ++i) {
        const json_value_t *item = json_array_at(forecast, i);
        copy_utf8(screen->weather.forecast[i].weekday,
                  sizeof(screen->weather.forecast[i].weekday),
                  json_string(json_object_get(item, "weekday")));
        screen->weather.forecast[i].min = (float)json_number(json_object_get(item, "min"), 0);
        screen->weather.forecast[i].max = (float)json_number(json_object_get(item, "max"), 0);
        screen->weather.forecast[i].precipitation_probability =
            (int)json_number(json_object_get(item, "precipitationProbability"), 0);
        copy_utf8(screen->weather.forecast[i].condition,
                  sizeof(screen->weather.forecast[i].condition),
                  json_string(json_object_get(item, "condition")));
        copy_utf8(screen->weather.forecast[i].icon, sizeof(screen->weather.forecast[i].icon),
                  json_string(json_object_get(item, "icon")));
    }
}

static void parse_event(const json_value_t *item, inkpane_event_t *event, int utc_offset_minutes)
{
    memset(event, 0, sizeof(*event));
    copy_utf8(event->title, sizeof(event->title), json_string(json_object_get(item, "title")));
    copy_utf8(event->location, sizeof(event->location),
              json_string(json_object_get(item, "location")));
    copy_utf8(event->color, sizeof(event->color), json_string(json_object_get(item, "color")));
    event->all_day = json_bool(json_object_get(item, "allDay"), false);
    event->is_course = json_bool(json_object_get(item, "isCourse"), false);
    event->start_minute = -1;
    event->end_minute = -1;
    if (!event->all_day) {
        int64_t start = 0;
        int64_t end = 0;
        if (inkpane_parse_iso_utc(json_string(json_object_get(item, "startAt")), &start)) {
            event->start_minute = local_minute_of(start, utc_offset_minutes);
        }
        if (inkpane_parse_iso_utc(json_string(json_object_get(item, "endAt")), &end)) {
            event->end_minute = local_minute_of(end, utc_offset_minutes);
        }
    }
}

/**
 * Read `key` as the true item total. Servers that predate the totals fields (or
 * omit them) fall back to the number of parsed array items, and a total smaller
 * than that array is ignored as inconsistent so "还有 N 项" can never go negative.
 */
static int parse_total(const json_value_t *data, const char *key, int array_length)
{
    int total = (int)json_number(json_object_get(data, key), array_length);
    if (total < array_length) {
        total = array_length;
    }
    return total;
}

static void parse_events(const json_value_t *data, inkpane_screen_t *screen)
{
    const json_value_t *events = json_object_get(data, "events");
    int available = json_array_size(events);
    int count = available;
    if (count > INKPANE_MAX_EVENTS) {
        count = INKPANE_MAX_EVENTS;
    }
    screen->event_count = count;
    screen->event_total = parse_total(data, "eventTotal", available);
    for (int i = 0; i < count; ++i) {
        parse_event(json_array_at(events, i), &screen->events[i], screen->utc_offset_minutes);
    }

    const json_value_t *courses = json_object_get(data, "courses");
    available = json_array_size(courses);
    count = available;
    if (count > INKPANE_MAX_COURSES) {
        count = INKPANE_MAX_COURSES;
    }
    screen->course_count = count;
    screen->course_total = parse_total(data, "courseTotal", available);
    for (int i = 0; i < count; ++i) {
        parse_event(json_array_at(courses, i), &screen->courses[i], screen->utc_offset_minutes);
        screen->courses[i].is_course = true;
    }
}

static void parse_todos(const json_value_t *data, inkpane_screen_t *screen)
{
    const json_value_t *todos = json_object_get(data, "todos");
    int available = json_array_size(todos);
    int count = available;
    if (count > INKPANE_MAX_TODOS) {
        count = INKPANE_MAX_TODOS;
    }
    screen->todo_count = count;
    screen->todo_total = parse_total(data, "todoTotal", available);
    for (int i = 0; i < count; ++i) {
        const json_value_t *item = json_array_at(todos, i);
        inkpane_todo_t *todo = &screen->todos[i];
        memset(todo, 0, sizeof(*todo));
        copy_utf8(todo->title, sizeof(todo->title), json_string(json_object_get(item, "title")));
        copy_utf8(todo->due_date, sizeof(todo->due_date),
                  json_string(json_object_get(item, "dueDate")));
        copy_utf8(todo->priority, sizeof(todo->priority),
                  json_string(json_object_get(item, "priority")));
    }
}

bool inkpane_screen_parse(const char *json, size_t len, inkpane_screen_t *screen, char *arena,
                          size_t arena_size)
{
    if (json == NULL || screen == NULL || arena == NULL) {
        return false;
    }
    inkpane_screen_reset(screen);

    json_doc_t doc;
    if (!json_parse(&doc, json, len, arena, arena_size)) {
        return false;
    }
    const json_value_t *root = doc.root;
    const json_value_t *data = json_object_get(root, "data");
    if (data == NULL || data->type != JSON_OBJECT) {
        data = root;
        if (data == NULL || data->type != JSON_OBJECT) {
            return false;
        }
    }

    screen->schema_version =
        (int)json_number(json_object_get(data, "schemaVersion"), INKPANE_SCHEMA_VERSION);
    copy_utf8(screen->timezone, sizeof(screen->timezone),
              json_string(json_object_get(data, "timezone")));

    parse_layout(data, screen);
    parse_now(data, screen);
    parse_month(data, screen);
    parse_weather(data, screen);
    parse_events(data, screen);
    parse_todos(data, screen);
    return true;
}
