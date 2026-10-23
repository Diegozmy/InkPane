#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "inkpane_time.h"

/** One SHTC3 sample. */
typedef struct {
    float temperature_c;
    float humidity_pct;
} inkpane_env_t;

/**
 * Initialize I2C, AXP2101 power rails, PCF85063 and the four buttons.
 * Must run before any display access (the panel is powered from ALDO3).
 */
esp_err_t inkpane_board_init(void);

/** True when the RTC has a running, plausible time (OS flag clear). */
bool inkpane_board_time_valid(void);
esp_err_t inkpane_board_time_get(inkpane_datetime_t *out);
esp_err_t inkpane_board_time_set(const inkpane_datetime_t *dt);

/** Read SHTC3; returns false on CRC/I2C failure (sensor left asleep). */
bool inkpane_board_read_env(inkpane_env_t *out);

/** -1 when unknown (no battery / I2C error). */
int inkpane_board_battery_percent(void);
int inkpane_board_battery_millivolt(void);
bool inkpane_board_vbus_present(void);

/** EPD power rail (AXP2101 ALDO3). */
void inkpane_board_epd_power(bool on);

/** Cut power via AXP2101 (does not return). */
void inkpane_board_power_off(void);

/** Level of one of the four user buttons (GPIO 0/4/5/6), active low. */
bool inkpane_board_button_held(int gpio);

/**
 * Enable deep-sleep wakeup on the buttons (EXT1, any low).
 * Call right before esp_deep_sleep_start().
 */
esp_err_t inkpane_board_configure_button_wakeup(void);
