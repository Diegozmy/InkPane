#pragma once

#include <stdbool.h>
#include <stdint.h>

/** Seconds until the next minute boundary, plus a 1 s guard. */
int inkpane_seconds_to_next_minute(int second_of_minute);

int64_t inkpane_next_net_epoch(int64_t now_epoch, int refresh_minutes);

bool inkpane_should_fetch(bool cold_boot, bool button_wake, bool rtc_valid, int64_t now_epoch,
                          int64_t next_net_epoch);

bool inkpane_should_force_full(bool cold_boot, bool date_changed, bool network_due,
                               int partial_count, int full_refresh_interval);

/** 5 min, 10 min, 15 min ... capped at the refresh interval. */
int inkpane_backoff_seconds(int failure_count, int refresh_minutes);
