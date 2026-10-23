#include "board_internal.h"

#include "esp_check.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "axp2101";

/* AXP2101 registers used by InkPane. */
#define REG_STATUS1 0x00
#define REG_STATUS2 0x01
#define REG_COMMON_CONFIG 0x10
#define REG_ADC_CHANNEL_CTRL 0x30
#define REG_ADC_DATA_H 0x34
#define REG_ADC_DATA_L 0x35
#define REG_BAT_DET_CTRL 0x68
#define REG_DC_ONOFF 0x80
#define REG_DC_VOL0 0x82
#define REG_LDO_ONOFF0 0x90
#define REG_LDO_VOL0 0x92
#define REG_LDO_VOL1 0x93
#define REG_LDO_VOL2 0x94
#define REG_BAT_PERCENT 0xA4

static esp_err_t update_bits(uint8_t reg, uint8_t mask, uint8_t value)
{
    uint8_t current = 0;
    esp_err_t err = i2c_read_u8(g_i2c_axp, reg, &current);
    if (err != ESP_OK) {
        return err;
    }
    current = (uint8_t)((current & (uint8_t)~mask) | (value & mask));
    return i2c_write_u8(g_i2c_axp, reg, current);
}

/* ALDO1/2/3 are all 500..3500 mV in 100 mV steps. */
static esp_err_t set_aldo_voltage(uint8_t reg, int millivolt)
{
    int value = (millivolt - 500) / 100;
    if (value < 0 || value > 0x1F) {
        return ESP_ERR_INVALID_ARG;
    }
    uint8_t current = 0;
    esp_err_t err = i2c_read_u8(g_i2c_axp, reg, &current);
    if (err != ESP_OK) {
        return err;
    }
    return i2c_write_u8(g_i2c_axp, reg, (uint8_t)((current & 0xE0) | value));
}

esp_err_t axp2101_init(void)
{
    uint8_t status = 0;
    esp_err_t err = i2c_read_u8(g_i2c_axp, REG_STATUS1, &status);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "no response from AXP2101: %s", esp_err_to_name(err));
        return err;
    }

    /* DC1 3.3 V, ALDO1/2/3 3.3 V. Values are (mV - min) / step. */
    ESP_RETURN_ON_ERROR(i2c_write_u8(g_i2c_axp, REG_DC_VOL0, (3300 - 1500) / 100), TAG, "dc1");
    ESP_RETURN_ON_ERROR(set_aldo_voltage(REG_LDO_VOL0, 3300), TAG, "aldo1");
    ESP_RETURN_ON_ERROR(set_aldo_voltage(REG_LDO_VOL1, 3300), TAG, "aldo2");
    ESP_RETURN_ON_ERROR(set_aldo_voltage(REG_LDO_VOL2, 3300), TAG, "aldo3");

    /* Enable DC1 and the three ALDO rails (ALDO3 is the EPD rail). */
    ESP_RETURN_ON_ERROR(update_bits(REG_DC_ONOFF, 0x01, 0x01), TAG, "dc1 on");
    ESP_RETURN_ON_ERROR(update_bits(REG_LDO_ONOFF0, 0x07, 0x07), TAG, "ldo on");

    /* Battery detection + voltage measurement. */
    ESP_RETURN_ON_ERROR(update_bits(REG_BAT_DET_CTRL, 0x01, 0x01), TAG, "bat det");
    ESP_RETURN_ON_ERROR(update_bits(REG_ADC_CHANNEL_CTRL, 0x01, 0x01), TAG, "adc");

    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_LOGI(TAG, "power rails ready");
    return ESP_OK;
}

void axp2101_set_epd_power(bool on)
{
    update_bits(REG_LDO_ONOFF0, 0x04, on ? 0x04 : 0x00);
    if (on) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

bool axp2101_battery_connected(void)
{
    uint8_t status = 0;
    if (i2c_read_u8(g_i2c_axp, REG_STATUS1, &status) != ESP_OK) {
        return false;
    }
    return (status & 0x08) != 0;
}

int axp2101_battery_percent(void)
{
    if (!axp2101_battery_connected()) {
        return -1;
    }
    uint8_t value = 0;
    if (i2c_read_u8(g_i2c_axp, REG_BAT_PERCENT, &value) != ESP_OK) {
        return -1;
    }
    if (value > 100) {
        value = 100;
    }
    return value;
}

int axp2101_battery_millivolt(void)
{
    if (!axp2101_battery_connected()) {
        return -1;
    }
    uint8_t high = 0;
    uint8_t low = 0;
    if (i2c_read_u8(g_i2c_axp, REG_ADC_DATA_H, &high) != ESP_OK ||
        i2c_read_u8(g_i2c_axp, REG_ADC_DATA_L, &low) != ESP_OK) {
        return -1;
    }
    int millivolt = (int)((high & 0x1F) << 8) | low;
    if (millivolt <= 0) {
        return -1;
    }
    return millivolt;
}

bool axp2101_vbus_present(void)
{
    uint8_t status1 = 0;
    uint8_t status2 = 0;
    if (i2c_read_u8(g_i2c_axp, REG_STATUS1, &status1) != ESP_OK ||
        i2c_read_u8(g_i2c_axp, REG_STATUS2, &status2) != ESP_OK) {
        return false;
    }
    return (status2 & 0x08) == 0 && (status1 & 0x20) != 0;
}

void axp2101_power_off(void)
{
    /* Bit 0 of COMMON_CONFIG turns the PMU off (only VRTC stays alive). */
    update_bits(REG_COMMON_CONFIG, 0x01, 0x01);
    vTaskDelay(pdMS_TO_TICKS(200));
}
