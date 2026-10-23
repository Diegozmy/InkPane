#include "inkpane_board.h"

#include <string.h>

#include "board_internal.h"
#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "board";

i2c_master_bus_handle_t g_i2c_bus = NULL;
i2c_master_dev_handle_t g_i2c_axp = NULL;
i2c_master_dev_handle_t g_i2c_rtc = NULL;
i2c_master_dev_handle_t g_i2c_shtc3 = NULL;

static const int BUTTON_PINS[] = {0, 4, 5, 6};
#define BUTTON_COUNT ((int)(sizeof(BUTTON_PINS) / sizeof(BUTTON_PINS[0])))

esp_err_t i2c_write_reg(i2c_master_dev_handle_t dev, uint8_t reg, const uint8_t *data, size_t len)
{
    uint8_t buffer[16];
    if (len > sizeof(buffer) - 1) {
        return ESP_ERR_INVALID_SIZE;
    }
    buffer[0] = reg;
    if (len > 0) {
        memcpy(&buffer[1], data, len);
    }
    return i2c_master_transmit(dev, buffer, len + 1, 100);
}

esp_err_t i2c_read_reg(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t *data, size_t len)
{
    return i2c_master_transmit_receive(dev, &reg, 1, data, len, 100);
}

esp_err_t i2c_write_u8(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t value)
{
    return i2c_write_reg(dev, reg, &value, 1);
}

esp_err_t i2c_read_u8(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t *value)
{
    return i2c_read_reg(dev, reg, value, 1);
}

static esp_err_t add_device(uint8_t address, i2c_master_dev_handle_t *out)
{
    i2c_device_config_t config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = address,
        .scl_speed_hz = INKPANE_I2C_FREQ,
    };
    return i2c_master_bus_add_device(g_i2c_bus, &config, out);
}

static esp_err_t i2c_bus_init(void)
{
    i2c_master_bus_config_t config = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = INKPANE_I2C_SDA,
        .scl_io_num = INKPANE_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .intr_priority = 0,
        .trans_queue_depth = 0,
        .flags.enable_internal_pullup = true,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&config, &g_i2c_bus), TAG, "i2c bus");
    ESP_RETURN_ON_ERROR(add_device(AXP2101_ADDR, &g_i2c_axp), TAG, "axp2101");
    ESP_RETURN_ON_ERROR(add_device(PCF85063_ADDR, &g_i2c_rtc), TAG, "pcf85063");
    ESP_RETURN_ON_ERROR(add_device(SHTC3_ADDR, &g_i2c_shtc3), TAG, "shtc3");
    return ESP_OK;
}

static void buttons_init(void)
{
    for (int i = 0; i < BUTTON_COUNT; ++i) {
        gpio_config_t config = {
            .pin_bit_mask = 1ULL << BUTTON_PINS[i],
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        ESP_ERROR_CHECK(gpio_config(&config));
    }
}

esp_err_t inkpane_board_init(void)
{
    ESP_RETURN_ON_ERROR(i2c_bus_init(), TAG, "i2c init");
    buttons_init();

    esp_err_t err = axp2101_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "AXP2101 init failed: %s", esp_err_to_name(err));
    }

    err = pcf85063_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "PCF85063 init failed: %s", esp_err_to_name(err));
    }
    return ESP_OK;
}

bool inkpane_board_time_valid(void)
{
    return pcf85063_valid();
}

esp_err_t inkpane_board_time_get(inkpane_datetime_t *out)
{
    return pcf85063_get(out);
}

esp_err_t inkpane_board_time_set(const inkpane_datetime_t *dt)
{
    return pcf85063_set(dt);
}

bool inkpane_board_read_env(inkpane_env_t *out)
{
    if (out == NULL) {
        return false;
    }
    float temperature = 0.0f;
    float humidity = 0.0f;
    if (shtc3_read(&temperature, &humidity) != ESP_OK) {
        return false;
    }
    out->temperature_c = temperature;
    out->humidity_pct = humidity;
    return true;
}

int inkpane_board_battery_percent(void)
{
    return axp2101_battery_percent();
}

int inkpane_board_battery_millivolt(void)
{
    return axp2101_battery_millivolt();
}

bool inkpane_board_vbus_present(void)
{
    return axp2101_vbus_present();
}

void inkpane_board_epd_power(bool on)
{
    axp2101_set_epd_power(on);
}

void inkpane_board_power_off(void)
{
    ESP_LOGW(TAG, "power off");
    axp2101_power_off();
    /* Should not return; if it does, fall back to deep sleep. */
    esp_deep_sleep_start();
}

bool inkpane_board_button_held(int gpio)
{
    return gpio_get_level((gpio_num_t)gpio) == 0;
}

esp_err_t inkpane_board_configure_button_wakeup(void)
{
    uint64_t mask = 0;
    for (int i = 0; i < BUTTON_COUNT; ++i) {
        mask |= 1ULL << BUTTON_PINS[i];
        /* Keep the RTC domain pull-ups enabled while the digital domain sleeps. */
        rtc_gpio_pullup_en((gpio_num_t)BUTTON_PINS[i]);
        rtc_gpio_pulldown_dis((gpio_num_t)BUTTON_PINS[i]);
    }
#if ESP_IDF_VERSION_MAJOR >= 6
    return esp_sleep_enable_ext1_wakeup_io(mask, ESP_EXT1_WAKEUP_ANY_LOW);
#else
    return esp_sleep_enable_ext1_wakeup(mask, ESP_EXT1_WAKEUP_ANY_LOW);
#endif
}
