#include "inkpane_schedule.h"

int inkpane_seconds_to_next_minute(int second_of_minute)
{
    if (second_of_minute < 0 || second_of_minute > 59) {
        return 60;
    }
    return 60 - second_of_minute + 1;
}

int64_t inkpane_next_net_epoch(int64_t now_epoch, int refresh_minutes)
{
    if (refresh_minutes < 5) {
        refresh_minutes = 5;
    }
    return now_epoch + (int64_t)refresh_minutes * 60;
}

bool inkpane_should_fetch(bool cold_boot, bool button_wake, bool rtc_valid, int64_t now_epoch,
                          int64_t next_net_epoch)
{
    if (cold_boot || button_wake || !rtc_valid || next_net_epoch == 0) {
        return true;
    }
    return now_epoch >= next_net_epoch;
}

bool inkpane_should_force_full(bool cold_boot, bool date_changed, bool network_due,
                               int partial_count, int full_refresh_interval)
{
    if (cold_boot || date_changed) {
        return true;
    }
    if (!network_due) {
        return false;
    }
    if (full_refresh_interval < 1) {
        full_refresh_interval = 1;
    }
    return partial_count >= full_refresh_interval;
}

int inkpane_backoff_seconds(int failure_count, int refresh_minutes)
{
    if (refresh_minutes < 5) {
        refresh_minutes = 5;
    }
    if (failure_count < 1) {
        failure_count = 1;
    }
    int seconds = 300 * failure_count;
    int maximum = refresh_minutes * 60;
    return seconds > maximum ? maximum : seconds;
}
