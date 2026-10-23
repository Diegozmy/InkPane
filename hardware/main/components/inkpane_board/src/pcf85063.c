#include "board_internal.h"

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define REG_CONTROL1 0x00
#define REG_SECONDS 0x04
#define REG_MINUTES 0x05
#define REG_HOURS 0x06
#define REG_DAYS 0x07
#define REG_WEEKDAYS 0x08
#define REG_MONTHS 0x09
#define REG_YEARS 0x0A

static const char *TAG = "pcf85063";

/* True until the clock has been calibrated once after an oscillator stop. */
static bool s_time_lost;

static uint8_t bcd_to_dec(uint8_t value)
{
    return (uint8_t)(((value >> 4) * 10) + (value & 0x0F));
}

static uint8_t dec_to_bcd(uint8_t value)
{
    return (uint8_t)(((value / 10) << 4) | (value % 10));
}

esp_err_t pcf85063_init(void)
{
    uint8_t control = 0;
    if (i2c_read_u8(g_i2c_rtc, REG_CONTROL1, &control) != ESP_OK) {
        return ESP_FAIL;
    }
    /* Bit 7 is the clock-stop / calibration-related control bit in the demo. */
    control &= (uint8_t)~0x80;
    esp_err_t err = i2c_write_u8(g_i2c_rtc, REG_CONTROL1, control);
    if (err != ESP_OK) {
        return err;
    }

    /* Keep the OS flag (seconds bit 7) as-is: valid() must stay false until the
     * time is calibrated from the server, otherwise we would display a bogus
     * 2000-01-01 clock after a battery swap. */
    uint8_t seconds = 0;
    if (i2c_read_u8(g_i2c_rtc, REG_SECONDS, &seconds) != ESP_OK) {
        s_time_lost = true;
        return ESP_OK;
    }
    s_time_lost = (seconds & 0x80) != 0;
    if (s_time_lost) {
        ESP_LOGW(TAG, "oscillator stopped (OS set); waiting for time calibration");
    }
    return ESP_OK;
}

bool pcf85063_valid(void)
{
    if (s_time_lost) {
        return false;
    }
    uint8_t raw[7] = {0};
    if (i2c_read_reg(g_i2c_rtc, REG_SECONDS, raw, sizeof(raw)) != ESP_OK) {
        return false;
    }
    if ((raw[0] & 0x80) != 0) {
        s_time_lost = true;
        return false;
    }
    int second = bcd_to_dec(raw[0] & 0x7F);
    int minute = bcd_to_dec(raw[1] & 0x7F);
    int hour = bcd_to_dec(raw[2] & 0x3F);
    int day = bcd_to_dec(raw[3] & 0x3F);
    int month = bcd_to_dec(raw[5] & 0x1F);
    int year = bcd_to_dec(raw[6]);
    return second < 60 && minute < 60 && hour < 24 && day >= 1 && day <= 31 && month >= 1 &&
           month <= 12 && year <= 99;
}

esp_err_t pcf85063_get(inkpane_datetime_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    uint8_t raw[7] = {0};
    ESP_RETURN_ON_ERROR(i2c_read_reg(g_i2c_rtc, REG_SECONDS, raw, sizeof(raw)), "pcf85063", "read");
    out->second = bcd_to_dec(raw[0] & 0x7F);
    out->minute = bcd_to_dec(raw[1] & 0x7F);
    out->hour = bcd_to_dec(raw[2] & 0x3F);
    out->day = bcd_to_dec(raw[3] & 0x3F);
    out->month = bcd_to_dec(raw[5] & 0x1F);
    out->year = 2000 + bcd_to_dec(raw[6]);
    return ESP_OK;
}

esp_err_t pcf85063_set(const inkpane_datetime_t *dt)
{
    if (dt == NULL || dt->year < 2000 || dt->year > 2099) {
        return ESP_ERR_INVALID_ARG;
    }
    /* 2026-10-18 is a Sunday; PCF85063 day-of-week is 0..6 with 0 = Sunday. */
    static const int days_per_month[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    int y = dt->year;
    int m = dt->month;
    int d = dt->day;
    /* days since 2000-01-01 (a Saturday) */
    int days = 0;
    for (int year = 2000; year < y; ++year) {
        bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        days += leap ? 366 : 365;
    }
    for (int month = 1; month < m; ++month) {
        days += days_per_month[month - 1];
        if (month == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0)) {
            days += 1;
        }
    }
    days += d - 1;
    int weekday = (days + 6) % 7; /* 2000-01-01 was Saturday (6) */

    uint8_t raw[7] = {
        dec_to_bcd((uint8_t)dt->second),
        dec_to_bcd((uint8_t)dt->minute),
        dec_to_bcd((uint8_t)dt->hour),
        dec_to_bcd((uint8_t)dt->day),
        (uint8_t)weekday,
        dec_to_bcd((uint8_t)dt->month),
        dec_to_bcd((uint8_t)(dt->year - 2000)),
    };
    esp_err_t err = i2c_write_reg(g_i2c_rtc, REG_SECONDS, raw, sizeof(raw));
    if (err != ESP_OK) {
        return err;
    }
    /* The seconds byte above was written with bit 7 (OS) clear, which releases
     * the clock; read it back and clear OS again defensively. Only then is the
     * time considered calibrated. */
    uint8_t seconds = 0;
    if (i2c_read_u8(g_i2c_rtc, REG_SECONDS, &seconds) == ESP_OK && (seconds & 0x80) != 0) {
        err = i2c_write_u8(g_i2c_rtc, REG_SECONDS, seconds & 0x7F);
        if (err != ESP_OK) {
            return err;
        }
    }
    s_time_lost = false;
    return ESP_OK;
}
