#include "board_internal.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define SHTC3_WAKE 0x3517
#define SHTC3_SLEEP 0xB098
#define SHTC3_MEASURE 0x7866
#define SHTC3_CRC_POLY 0x31

static uint8_t crc8(const uint8_t *data, size_t len)
{
    uint8_t crc = 0xFF;
    for (size_t i = 0; i < len; ++i) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ SHTC3_CRC_POLY) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}

static esp_err_t send_command(uint16_t command)
{
    uint8_t buffer[2] = {(uint8_t)(command >> 8), (uint8_t)(command & 0xFF)};
    return i2c_master_transmit(g_i2c_shtc3, buffer, sizeof(buffer), 100);
}

esp_err_t shtc3_read(float *temperature, float *humidity)
{
    if (temperature == NULL || humidity == NULL || g_i2c_shtc3 == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t err = send_command(SHTC3_WAKE);
    if (err != ESP_OK) {
        return err;
    }
    vTaskDelay(pdMS_TO_TICKS(1));

    err = send_command(SHTC3_MEASURE);
    if (err != ESP_OK) {
        send_command(SHTC3_SLEEP);
        return err;
    }
    vTaskDelay(pdMS_TO_TICKS(20));

    uint8_t raw[6] = {0};
    err = i2c_master_receive(g_i2c_shtc3, raw, sizeof(raw), 100);
    send_command(SHTC3_SLEEP);
    if (err != ESP_OK) {
        return err;
    }
    if (crc8(&raw[0], 2) != raw[2] || crc8(&raw[3], 2) != raw[5]) {
        ESP_LOGW("shtc3", "CRC mismatch");
        return ESP_ERR_INVALID_CRC;
    }

    uint16_t raw_temperature = (uint16_t)((raw[0] << 8) | raw[1]);
    uint16_t raw_humidity = (uint16_t)((raw[3] << 8) | raw[4]);
    *temperature = -45.0f + 175.0f * (float)raw_temperature / 65536.0f;
    *humidity = 100.0f * (float)raw_humidity / 65536.0f;
    return ESP_OK;
}
