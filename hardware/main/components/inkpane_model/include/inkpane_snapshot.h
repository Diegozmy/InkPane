#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "inkpane_model.h"

#define INKPANE_SNAPSHOT_MAGIC 0x494E4B53u /* "INKS" */
#define INKPANE_SNAPSHOT_VERSION 1u

/* Full-screen zoom rows render a title in ~616 px at the medium font, which
 * fits roughly 21 CJK glyphs; 64 bytes covers that while keeping the whole
 * snapshot inside ESP32-S3 RTC slow memory (~8 KB total, shared with the
 * persist block). The overview mini modules draw even less per row. */
#define INKPANE_SNAPSHOT_TITLE_LEN 64

/**
 * One condensed event/course row: everything the renderers actually draw
 * (title, start time, all-day flag). Location/color/end time are never
 * painted by inkpane_ui, so they are dropped to keep the RTC footprint low.
 */
typedef struct {
    char title[INKPANE_SNAPSHOT_TITLE_LEN];
    int16_t start_minute; /* minutes after local midnight, -1 for all-day */
    uint8_t all_day;
    uint8_t reserved;
} inkpane_snapshot_event_t;

/**
 * Condensed copy of the last successfully rendered screen payload (~4.9 KB),
 * meant to live in RTC memory (`RTC_DATA_ATTR`) so a deep-sleep button wake
 * can re-render the zoomed module views and the overview offline. The full
 * inkpane_screen_t (~10 KB) would not fit next to the persist block.
 */
typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t reserved;
    /* FNV-1a over every other byte of this struct. RTC memory that is not
     * retained (or gets corrupted) is rejected instead of being rendered as a
     * page full of negative numbers and missing glyphs. */
    uint32_t checksum;

    /* Full layout rects: the overview renderer clips every module to them and
     * the zoom ring uses enabled/present. */
    inkpane_rect_t modules[INKPANE_MAX_MODULES];

    int event_count;
    int event_total;
    int course_count;
    int course_total;
    int todo_count;
    int todo_total;

    inkpane_month_t month;
    inkpane_weather_t weather;

    inkpane_snapshot_event_t events[INKPANE_MAX_EVENTS];
    inkpane_snapshot_event_t courses[INKPANE_MAX_COURSES];
    inkpane_todo_t todos[INKPANE_MAX_TODOS];
} inkpane_snapshot_t;

/** Wipe the snapshot (cold boot, re-provision). */
void inkpane_snapshot_invalidate(inkpane_snapshot_t *snapshot);

/** True when the snapshot holds renderable data (magic, version and checksum). */
bool inkpane_snapshot_valid(const inkpane_snapshot_t *snapshot);

/** Copy everything the renderers draw out of `screen` into `snapshot`. */
void inkpane_snapshot_capture(inkpane_snapshot_t *snapshot, const inkpane_screen_t *screen);

/**
 * Rebuild a renderable `screen` from the snapshot. `screen` is always reset
 * first, so on failure it is left zeroed (no module enabled). Clock fields
 * (`now_*`) are intentionally not stored: they are re-read from the RTC at
 * render time and must be filled by the caller afterwards.
 */
bool inkpane_snapshot_restore(const inkpane_snapshot_t *snapshot, inkpane_screen_t *screen);
