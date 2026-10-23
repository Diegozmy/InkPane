#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "driver/i2c_master.h"
#include "esp_err.h"
#include "inkpane_board.h"

#define INKPANE_I2C_SCL 42
#define INKPANE_I2C_SDA 41
#define INKPANE_I2C_FREQ 400000

#define AXP2101_ADDR 0x34
#define PCF85063_ADDR 0x51
#define SHTC3_ADDR 0x70

extern i2c_master_bus_handle_t g_i2c_bus;
extern i2c_master_dev_handle_t g_i2c_axp;
extern i2c_master_dev_handle_t g_i2c_rtc;
extern i2c_master_dev_handle_t g_i2c_shtc3;

esp_err_t i2c_write_reg(i2c_master_dev_handle_t dev, uint8_t reg, const uint8_t *data, size_t len);
esp_err_t i2c_read_reg(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t *data, size_t len);
esp_err_t i2c_write_u8(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t value);
esp_err_t i2c_read_u8(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t *value);

esp_err_t axp2101_init(void);
bool axp2101_battery_connected(void);
int axp2101_battery_percent(void);
int axp2101_battery_millivolt(void);
bool axp2101_vbus_present(void);
void axp2101_power_off(void);
void axp2101_set_epd_power(bool on);

esp_err_t pcf85063_init(void);
bool pcf85063_valid(void);
esp_err_t pcf85063_get(inkpane_datetime_t *out);
esp_err_t pcf85063_set(const inkpane_datetime_t *dt);

esp_err_t shtc3_read(float *temperature, float *humidity);
