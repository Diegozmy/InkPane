#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Broken-down local wall-clock time (no timezone attached). */
typedef struct {
    int year;
    int month;
    int day;
    int hour;
    int minute;
    int second;
} inkpane_datetime_t;

#define INKPANE_SECONDS_PER_DAY 86400

int64_t inkpane_days_from_civil(int year, unsigned month, unsigned day);
void inkpane_civil_from_days(int64_t days, int *year, int *month, int *day);
int inkpane_weekday_of_date(int year, int month, int day); /* 0 = Sunday */
int inkpane_days_in_month(int year, int month);
bool inkpane_is_leap_year(int year);

int64_t inkpane_local_epoch(const inkpane_datetime_t *dt);
void inkpane_datetime_from_local_epoch(int64_t local_epoch, inkpane_datetime_t *dt);

/** "YYYY-MM-DDTHH:MM:SS" (fractional seconds and offsets ignored). */
bool inkpane_parse_iso_local(const char *text, inkpane_datetime_t *out);
/** "YYYY-MM-DDTHH:MM:SS(.sss)?Z" */
bool inkpane_parse_iso_utc(const char *text, int64_t *epoch);
/** "Sun, 18 Oct 2026 03:40:00 GMT" */
bool inkpane_parse_http_date(const char *text, int64_t *epoch);
/** "YYYY-MM-DD" */
bool inkpane_parse_date_key(const char *text, int *year, int *month, int *day);

/** "10月18日" */
void inkpane_date_label(int year, int month, int day, char *out, size_t out_size);
/** 周日 .. 周六 */
const char *inkpane_weekday_label(int weekday);
/** 日 .. 六 */
const char *inkpane_weekday_short(int weekday);
