#include "inkpane_time.h"

#include <stdio.h>
#include <string.h>

static const char *WEEKDAY_LABELS[] = {"周日", "周一", "周二", "周三", "周四", "周五", "周六"};
static const char *WEEKDAY_SHORT[] = {"日", "一", "二", "三", "四", "五", "六"};
static const char *MONTH_NAMES[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

bool inkpane_is_leap_year(int year)
{
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}

int inkpane_days_in_month(int year, int month)
{
    static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (month < 1 || month > 12) {
        return 0;
    }
    if (month == 2 && inkpane_is_leap_year(year)) {
        return 29;
    }
    return days[month - 1];
}

/* Howard Hinnant's days_from_civil / civil_from_days (proleptic Gregorian). */
int64_t inkpane_days_from_civil(int year, unsigned month, unsigned day)
{
    int y = year;
    y -= month <= 2;
    const int era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return (int64_t)era * 146097 + (int64_t)doe - 719468;
}

void inkpane_civil_from_days(int64_t days, int *year, int *month, int *day)
{
    int64_t z = days + 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = (unsigned)(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int y = (int)yoe + (int)era * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    const unsigned d = doy - (153 * mp + 2) / 5 + 1;
    const unsigned m = mp + (mp < 10 ? 3 : -9);
    *year = y + (m <= 2);
    *month = (int)m;
    *day = (int)d;
}

int inkpane_weekday_of_date(int year, int month, int day)
{
    int64_t days = inkpane_days_from_civil(year, (unsigned)month, (unsigned)day);
    int weekday = (int)((days + 4) % 7); /* 1970-01-01 is Thursday */
    if (weekday < 0) {
        weekday += 7;
    }
    return weekday;
}

int64_t inkpane_local_epoch(const inkpane_datetime_t *dt)
{
    int64_t days = inkpane_days_from_civil(dt->year, (unsigned)dt->month, (unsigned)dt->day);
    return days * INKPANE_SECONDS_PER_DAY + (int64_t)dt->hour * 3600 + (int64_t)dt->minute * 60 +
           dt->second;
}

void inkpane_datetime_from_local_epoch(int64_t local_epoch, inkpane_datetime_t *dt)
{
    int64_t days = local_epoch / INKPANE_SECONDS_PER_DAY;
    int64_t seconds = local_epoch % INKPANE_SECONDS_PER_DAY;
    if (seconds < 0) {
        seconds += INKPANE_SECONDS_PER_DAY;
        days -= 1;
    }
    int year = 0;
    int month = 0;
    int day = 0;
    inkpane_civil_from_days(days, &year, &month, &day);
    dt->year = year;
    dt->month = month;
    dt->day = day;
    dt->hour = (int)(seconds / 3600);
    dt->minute = (int)((seconds % 3600) / 60);
    dt->second = (int)(seconds % 60);
}

static bool read_number(const char **p, int digits, int *out)
{
    int value = 0;
    for (int i = 0; i < digits; ++i) {
        char ch = (*p)[i];
        if (ch < '0' || ch > '9') {
            return false;
        }
        value = value * 10 + (ch - '0');
    }
    *p += digits;
    *out = value;
    return true;
}

bool inkpane_parse_iso_local(const char *text, inkpane_datetime_t *out)
{
    if (text == NULL || out == NULL) {
        return false;
    }
    const char *p = text;
    int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
    if (!read_number(&p, 4, &year) || *p++ != '-' || !read_number(&p, 2, &month) || *p++ != '-' ||
        !read_number(&p, 2, &day)) {
        return false;
    }
    if (*p != 'T' && *p != ' ') {
        return false;
    }
    p++;
    if (!read_number(&p, 2, &hour) || *p++ != ':' || !read_number(&p, 2, &minute)) {
        return false;
    }
    if (*p == ':') {
        p++;
        if (!read_number(&p, 2, &second)) {
            return false;
        }
    }
    if (month < 1 || month > 12 || day < 1 || day > inkpane_days_in_month(year, month) || hour > 23 ||
        minute > 59 || second > 60) {
        return false;
    }
    out->year = year;
    out->month = month;
    out->day = day;
    out->hour = hour;
    out->minute = minute;
    out->second = second;
    return true;
}

bool inkpane_parse_iso_utc(const char *text, int64_t *epoch)
{
    if (text == NULL || epoch == NULL) {
        return false;
    }
    inkpane_datetime_t dt;
    if (!inkpane_parse_iso_local(text, &dt)) {
        return false;
    }
    *epoch = inkpane_local_epoch(&dt);
    return true;
}

bool inkpane_parse_http_date(const char *text, int64_t *epoch)
{
    if (text == NULL || epoch == NULL) {
        return false;
    }
    /* "Sun, 18 Oct 2026 03:40:00 GMT" */
    const char *comma = strchr(text, ',');
    const char *p = comma != NULL ? comma + 1 : text;
    while (*p == ' ') p++;
    int day = 0;
    int year = 0;
    int hour = 0, minute = 0, second = 0;
    char month_name[4] = {0};
    if (sscanf(p, "%d %3s %d %d:%d:%d", &day, month_name, &year, &hour, &minute, &second) != 6) {
        return false;
    }
    int month = 0;
    for (int i = 0; i < 12; ++i) {
        if (strcmp(month_name, MONTH_NAMES[i]) == 0) {
            month = i + 1;
            break;
        }
    }
    if (month == 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
        return false;
    }
    inkpane_datetime_t dt = {year, month, day, hour, minute, second};
    *epoch = inkpane_local_epoch(&dt);
    return true;
}

bool inkpane_parse_date_key(const char *text, int *year, int *month, int *day)
{
    if (text == NULL) {
        return false;
    }
    const char *p = text;
    int y = 0, m = 0, d = 0;
    if (!read_number(&p, 4, &y) || *p++ != '-' || !read_number(&p, 2, &m) || *p++ != '-' ||
        !read_number(&p, 2, &d)) {
        return false;
    }
    if (m < 1 || m > 12 || d < 1 || d > inkpane_days_in_month(y, m)) {
        return false;
    }
    *year = y;
    *month = m;
    *day = d;
    return true;
}

void inkpane_date_label(int year, int month, int day, char *out, size_t out_size)
{
    (void)year;
    snprintf(out, out_size, "%d月%d日", month, day);
}

const char *inkpane_weekday_label(int weekday)
{
    return WEEKDAY_LABELS[((weekday % 7) + 7) % 7];
}

const char *inkpane_weekday_short(int weekday)
{
    return WEEKDAY_SHORT[((weekday % 7) + 7) % 7];
}
