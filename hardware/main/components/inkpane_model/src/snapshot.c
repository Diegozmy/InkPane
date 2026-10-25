#include "inkpane_snapshot.h"

#include <stddef.h>
#include <string.h>

/*
 * RTC zoom snapshot: capture after a successful full refresh, restore on
 * deep-sleep button wakes. Everything here is plain C so the host tests can
 * exercise capture/restore without any ESP-IDF dependency.
 */

/* FNV-1a over the snapshot payload, skipping the checksum field itself so the
 * stored value can be verified in place without copying 4.8 KB. */
static uint32_t hash_bytes(uint32_t hash, const void *data, size_t length)
{
    const uint8_t *bytes = (const uint8_t *)data;
    for (size_t i = 0; i < length; ++i) {
        hash ^= bytes[i];
        hash *= 16777619u;
    }
    return hash;
}

static uint32_t snapshot_checksum(const inkpane_snapshot_t *snapshot)
{
    const size_t checksum_offset = offsetof(inkpane_snapshot_t, checksum);
    uint32_t hash = 2166136261u;
    hash = hash_bytes(hash, snapshot, checksum_offset);
    hash = hash_bytes(hash, (const uint8_t *)snapshot + checksum_offset +
                               sizeof(snapshot->checksum),
                     sizeof(*snapshot) - checksum_offset - sizeof(snapshot->checksum));
    return hash;
}

static void copy_utf8(char *dst, size_t dst_size, const char *src)
{
    /* Truncate on a character boundary: a split multi-byte sequence would be
     * drawn as a broken glyph at the end of the row. */
    if (dst == NULL || dst_size == 0) {
        return;
    }
    dst[0] = '\0';
    if (src == NULL) {
        return;
    }
    size_t used = 0;
    for (size_t i = 0; src[i] != '\0';) {
        unsigned char lead = (unsigned char)src[i];
        size_t sequence = 1;
        if (lead >= 0xF0) {
            sequence = 4;
        } else if (lead >= 0xE0) {
            sequence = 3;
        } else if (lead >= 0xC0) {
            sequence = 2;
        }
        size_t remaining = strlen(&src[i]);
        if (sequence > remaining) {
            sequence = remaining; /* malformed tail: keep raw bytes */
        }
        if (used + sequence > dst_size - 1) {
            break;
        }
        memcpy(&dst[used], &src[i], sequence);
        used += sequence;
        i += sequence;
    }
    dst[used] = '\0';
}

static int clamp_count(int count, int max)
{
    if (count < 0) {
        return 0;
    }
    return count > max ? max : count;
}

/* Keep struct fields that drive renderer loops inside their array bounds, both
 * when capturing (bad server payload) and when restoring (defence in depth). */
static void clamp_month(inkpane_month_t *month)
{
    month->mark_count = clamp_count(month->mark_count, INKPANE_MAX_MARKS);
    month->days_in_month = clamp_count(month->days_in_month, 31);
    month->first_weekday = clamp_count(month->first_weekday, 6);
    month->today = clamp_count(month->today, 31);
}

static void clamp_weather(inkpane_weather_t *weather)
{
    weather->forecast_count = clamp_count(weather->forecast_count, INKPANE_MAX_FORECAST);
}

void inkpane_snapshot_invalidate(inkpane_snapshot_t *snapshot)
{
    if (snapshot != NULL) {
        memset(snapshot, 0, sizeof(*snapshot));
    }
}

bool inkpane_snapshot_valid(const inkpane_snapshot_t *snapshot)
{
    return snapshot != NULL && snapshot->magic == INKPANE_SNAPSHOT_MAGIC &&
           snapshot->version == INKPANE_SNAPSHOT_VERSION &&
           snapshot->checksum == snapshot_checksum(snapshot);
}

void inkpane_snapshot_capture(inkpane_snapshot_t *snapshot, const inkpane_screen_t *screen)
{
    if (snapshot == NULL || screen == NULL) {
        return;
    }
    memset(snapshot, 0, sizeof(*snapshot));
    snapshot->magic = INKPANE_SNAPSHOT_MAGIC;
    snapshot->version = INKPANE_SNAPSHOT_VERSION;

    memcpy(snapshot->modules, screen->modules, sizeof(snapshot->modules));

    snapshot->event_count = clamp_count(screen->event_count, INKPANE_MAX_EVENTS);
    snapshot->event_total = screen->event_total > 0 ? screen->event_total : snapshot->event_count;
    snapshot->course_count = clamp_count(screen->course_count, INKPANE_MAX_COURSES);
    snapshot->course_total = screen->course_total > 0 ? screen->course_total : snapshot->course_count;
    snapshot->todo_count = clamp_count(screen->todo_count, INKPANE_MAX_TODOS);
    snapshot->todo_total = screen->todo_total > 0 ? screen->todo_total : snapshot->todo_count;

    snapshot->month = screen->month;
    snapshot->weather = screen->weather;
    clamp_month(&snapshot->month);
    clamp_weather(&snapshot->weather);

    for (int i = 0; i < snapshot->event_count; ++i) {
        const inkpane_event_t *event = &screen->events[i];
        inkpane_snapshot_event_t *row = &snapshot->events[i];
        copy_utf8(row->title, sizeof(row->title), event->title);
        int minute = event->all_day ? -1 : event->start_minute;
        if (minute < -1) {
            minute = -1;
        }
        if (minute > 1439) {
            minute = 1439;
        }
        row->start_minute = (int16_t)minute;
        row->all_day = event->all_day ? 1u : 0u;
    }
    for (int i = 0; i < snapshot->course_count; ++i) {
        const inkpane_event_t *event = &screen->courses[i];
        inkpane_snapshot_event_t *row = &snapshot->courses[i];
        copy_utf8(row->title, sizeof(row->title), event->title);
        int minute = event->all_day ? -1 : event->start_minute;
        if (minute < -1) {
            minute = -1;
        }
        if (minute > 1439) {
            minute = 1439;
        }
        row->start_minute = (int16_t)minute;
        row->all_day = event->all_day ? 1u : 0u;
    }
    for (int i = 0; i < snapshot->todo_count; ++i) {
        const inkpane_todo_t *todo = &screen->todos[i];
        inkpane_todo_t *row = &snapshot->todos[i];
        copy_utf8(row->title, sizeof(row->title), todo->title);
        copy_utf8(row->due_date, sizeof(row->due_date), todo->due_date);
        copy_utf8(row->priority, sizeof(row->priority), todo->priority);
    }

    snapshot->checksum = snapshot_checksum(snapshot);
}

bool inkpane_snapshot_restore(const inkpane_snapshot_t *snapshot, inkpane_screen_t *screen)
{
    if (screen == NULL) {
        return false;
    }
    memset(screen, 0, sizeof(*screen));
    if (!inkpane_snapshot_valid(snapshot)) {
        return false;
    }

    screen->schema_version = INKPANE_SCHEMA_VERSION;
    memcpy(screen->modules, snapshot->modules, sizeof(screen->modules));

    screen->event_count = clamp_count(snapshot->event_count, INKPANE_MAX_EVENTS);
    screen->event_total = snapshot->event_total;
    screen->course_count = clamp_count(snapshot->course_count, INKPANE_MAX_COURSES);
    screen->course_total = snapshot->course_total;
    screen->todo_count = clamp_count(snapshot->todo_count, INKPANE_MAX_TODOS);
    screen->todo_total = snapshot->todo_total;

    screen->month = snapshot->month;
    screen->weather = snapshot->weather;
    clamp_month(&screen->month);
    clamp_weather(&screen->weather);

    for (int i = 0; i < screen->event_count; ++i) {
        const inkpane_snapshot_event_t *row = &snapshot->events[i];
        inkpane_event_t *event = &screen->events[i];
        copy_utf8(event->title, sizeof(event->title), row->title);
        event->all_day = row->all_day != 0;
        event->is_course = false;
        event->start_minute = event->all_day ? -1 : row->start_minute;
        event->end_minute = event->start_minute;
    }
    for (int i = 0; i < screen->course_count; ++i) {
        const inkpane_snapshot_event_t *row = &snapshot->courses[i];
        inkpane_event_t *event = &screen->courses[i];
        copy_utf8(event->title, sizeof(event->title), row->title);
        event->all_day = row->all_day != 0;
        event->is_course = true;
        event->start_minute = event->all_day ? -1 : row->start_minute;
        event->end_minute = event->start_minute;
    }
    for (int i = 0; i < screen->todo_count; ++i) {
        const inkpane_todo_t *row = &snapshot->todos[i];
        inkpane_todo_t *todo = &screen->todos[i];
        copy_utf8(todo->title, sizeof(todo->title), row->title);
        copy_utf8(todo->due_date, sizeof(todo->due_date), row->due_date);
        copy_utf8(todo->priority, sizeof(todo->priority), row->priority);
    }
    return true;
}
