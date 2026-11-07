#include "inkpane_epd.h"

#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "inkpane_board.h"

#define EPD_SCLK 11
#define EPD_MOSI 12
#define EPD_CS 10
#define EPD_DC 9
#define EPD_RST 46
#define EPD_BUSY 3

#define EPD_SPI_HOST SPI3_HOST

static const char *TAG = "epd";
static spi_device_handle_t s_spi;
static bool s_ready;
/* Set when a partial refresh hardware-reset the controller: the next full
 * refresh must re-run panel_init() before writing the frame. */
static bool s_config_stale;
/* Which refresh profile panel_init() last programmed (0x1A fast vs normal), so
 * switching profile re-inits instead of sending a waveform the registers do not
 * match. */
static bool s_fast_profile;

static inline void cs_low(void) { gpio_set_level(EPD_CS, 0); }
static inline void dc_command(void) { gpio_set_level(EPD_DC, 0); }
static inline void dc_data(void) { gpio_set_level(EPD_DC, 1); }
static inline void rst_low(void) { gpio_set_level(EPD_RST, 0); }
static inline void rst_high(void) { gpio_set_level(EPD_RST, 1); }

static esp_err_t wait_busy(void)
{
    int elapsed_ms = 0;
    vTaskDelay(pdMS_TO_TICKS(10));
    while (gpio_get_level(EPD_BUSY) != 0) {
        if (elapsed_ms >= 10000) {
            ESP_LOGE(TAG, "BUSY timeout");
            return ESP_ERR_TIMEOUT;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
        elapsed_ms += 10;
    }
    return ESP_OK;
}

/**
 * Bytes pushed per SPI transaction.
 *
 * The framebuffer lives in PSRAM and is sent twice per full refresh (0x24 +
 * 0x26), so a whole frame is 96 KB of bus traffic. The previous 4 KB chunking
 * produced 24 transactions, and every transaction pays a fixed driver/DMA
 * setup cost plus a MOSI gap; at 20 MHz the payload itself is only ~5 ms per
 * frame half.
 *
 * 32 KB is the largest chunk that still lets the SPI driver set up a bounce
 * buffer in internal RAM without competing with the rest of the firmware for
 * tens of kilobytes (esp_driver_spi copies the PSRAM source into a DMA-capable
 * buffer when the size exceeds what it can transfer in place). It cuts the
 * transaction count from 24 to 6 while staying well inside ESP32-S3 internal
 * RAM, unlike a 96 KB max_transfer_sz that would have to be allocated up
 * front.
 */
#define EPD_SPI_CHUNK 32768

static esp_err_t spi_write(const uint8_t *data, size_t len)
{
    for (size_t offset = 0; offset < len; offset += EPD_SPI_CHUNK) {
        size_t part = (len - offset) > EPD_SPI_CHUNK ? EPD_SPI_CHUNK : (len - offset);
        spi_transaction_t transaction = {
            .length = part * 8,
            .tx_buffer = data + offset,
        };
        esp_err_t err = spi_device_polling_transmit(s_spi, &transaction);
        if (err != ESP_OK) {
            return err;
        }
    }
    return ESP_OK;
}

static esp_err_t send_command(uint8_t command)
{
    dc_command();
    return spi_write(&command, 1);
}

static esp_err_t send_data(uint8_t value)
{
    dc_data();
    return spi_write(&value, 1);
}

static esp_err_t send_buffer(const uint8_t *data, size_t len)
{
    dc_data();
    return spi_write(data, len);
}

static void hardware_reset(void)
{
    rst_high();
    vTaskDelay(pdMS_TO_TICKS(50));
    rst_low();
    vTaskDelay(pdMS_TO_TICKS(2));
    rst_high();
    vTaskDelay(pdMS_TO_TICKS(50));
}

/**
 * Program the full-panel RAM window and cursor.
 *
 * A partial refresh (`inkpane_epd_show_region`) leaves 0x44/0x45/0x4E/0x4F set
 * to the clock rectangle. A following full refresh that writes the whole
 * framebuffer without restoring them wraps the 48 KB of data inside that small
 * window, so the panel keeps showing a mix of old frames (the "stuck, ghosted
 * screen" after zooming out of a module). Every full refresh therefore sets
 * the window explicitly.
 *
 * Byte order: 0x44 takes X start then X end. The gate lines are wired
 * bottom-to-top, so RAM Y is mirrored against the visible image and 0x45 takes
 * the RAM Y start (high, HEIGHT-1) then the RAM Y end (low, 0). For the full
 * panel this spans the whole RAM and is correct as-is. The partial path applies
 * the same mirroring to its sub-window; do not send it visible coordinates.
 */
static esp_err_t set_full_window(void)
{
    ESP_RETURN_ON_ERROR(send_command(0x44), TAG, "x window");
    ESP_RETURN_ON_ERROR(send_data(0x00), TAG, "x start lo");
    ESP_RETURN_ON_ERROR(send_data(0x00), TAG, "x start hi");
    ESP_RETURN_ON_ERROR(send_data((INKPANE_EPD_WIDTH - 1) & 0xFF), TAG, "x end lo");
    ESP_RETURN_ON_ERROR(send_data((INKPANE_EPD_WIDTH - 1) >> 8), TAG, "x end hi");

    ESP_RETURN_ON_ERROR(send_command(0x45), TAG, "y window");
    ESP_RETURN_ON_ERROR(send_data((INKPANE_EPD_HEIGHT - 1) & 0xFF), TAG, "y end lo");
    ESP_RETURN_ON_ERROR(send_data((INKPANE_EPD_HEIGHT - 1) >> 8), TAG, "y end hi");
    ESP_RETURN_ON_ERROR(send_data(0x00), TAG, "y start lo");
    ESP_RETURN_ON_ERROR(send_data(0x00), TAG, "y start hi");

    ESP_RETURN_ON_ERROR(send_command(0x4E), TAG, "x counter");
    ESP_RETURN_ON_ERROR(send_data(0x00), TAG, "x counter lo");
    ESP_RETURN_ON_ERROR(send_data(0x00), TAG, "x counter hi");
    ESP_RETURN_ON_ERROR(send_command(0x4F), TAG, "y counter");
    ESP_RETURN_ON_ERROR(send_data(0x00), TAG, "y counter lo");
    ESP_RETURN_ON_ERROR(send_data(0x00), TAG, "y counter hi");
    return ESP_OK;
}

/**
 * Program the controller for a refresh.
 *
 * `fast` selects the vendor's "fast" temperature/voltage profile
 * (0x1A = 0x6A). Combined with the 0xD7 update sequence instead of 0xF7 it
 * cuts a full-screen update from roughly 3-4 s to about 1.5 s, at the cost of
 * a slightly shorter pixel settling time (more residual image if used
 * repeatedly). The controller keeps this setting in a register, so the caller
 * of a fast refresh has to re-run panel_init() in normal mode before a
 * "quality" full refresh.
 */
static esp_err_t panel_init(bool fast)
{
    ESP_RETURN_ON_ERROR(send_command(0x12), TAG, "swreset");
    ESP_RETURN_ON_ERROR(wait_busy(), TAG, "reset busy");

    ESP_RETURN_ON_ERROR(send_command(0x18), TAG, "temp sensor");
    ESP_RETURN_ON_ERROR(send_data(0x80), TAG, "temp sensor value");

    ESP_RETURN_ON_ERROR(send_command(0x0C), TAG, "booster");
    ESP_RETURN_ON_ERROR(send_data(0xAE), TAG, "booster 1");
    ESP_RETURN_ON_ERROR(send_data(0xC7), TAG, "booster 2");
    ESP_RETURN_ON_ERROR(send_data(0xC3), TAG, "booster 3");
    ESP_RETURN_ON_ERROR(send_data(0xC0), TAG, "booster 4");
    ESP_RETURN_ON_ERROR(send_data(0x80), TAG, "booster 5");

    ESP_RETURN_ON_ERROR(send_command(0x01), TAG, "driver output");
    ESP_RETURN_ON_ERROR(send_data((INKPANE_EPD_HEIGHT - 1) & 0xFF), TAG, "height lo");
    ESP_RETURN_ON_ERROR(send_data((INKPANE_EPD_HEIGHT - 1) >> 8), TAG, "height hi");
    ESP_RETURN_ON_ERROR(send_data(0x02), TAG, "scan mode");

    ESP_RETURN_ON_ERROR(send_command(0x3C), TAG, "border");
    ESP_RETURN_ON_ERROR(send_data(0x01), TAG, "border value");

    ESP_RETURN_ON_ERROR(send_command(0x11), TAG, "entry mode");
    ESP_RETURN_ON_ERROR(send_data(0x01), TAG, "entry mode value");

    ESP_RETURN_ON_ERROR(set_full_window(), TAG, "full window");

    /* Vendor EPD_Init_Fast(): the 0x1A register selects the faster update
     * profile. The vendor comment next to it reads "Fast(1.5s)". */
    if (fast) {
        ESP_RETURN_ON_ERROR(send_command(0x1A), TAG, "fast temp");
        ESP_RETURN_ON_ERROR(send_data(0x6A), TAG, "fast temp value");
    }

    return wait_busy();
}

static esp_err_t gpio_init(void)
{
    gpio_config_t output = {
        .pin_bit_mask = (1ULL << EPD_RST) | (1ULL << EPD_DC) | (1ULL << EPD_CS),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&output), TAG, "gpio out");

    gpio_config_t input = {
        .pin_bit_mask = 1ULL << EPD_BUSY,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&input), TAG, "gpio in");

    /* The panel's CS is held low for the whole session (same as the vendor demo). */
    cs_low();
    rst_high();
    return ESP_OK;
}

static esp_err_t spi_init(void)
{
    spi_bus_config_t bus = {
        .mosi_io_num = EPD_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = EPD_SCLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 2 * EPD_SPI_CHUNK,
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(EPD_SPI_HOST, &bus, SPI_DMA_CH_AUTO), TAG, "spi bus");

    spi_device_interface_config_t device = {
        .spics_io_num = -1,
        .clock_speed_hz = 20 * 1000 * 1000,
        .mode = 0,
        .queue_size = 1,
    };
    return spi_bus_add_device(EPD_SPI_HOST, &device, &s_spi);
}

esp_err_t inkpane_epd_init(bool warm)
{
    inkpane_board_epd_power(true);
    vTaskDelay(pdMS_TO_TICKS(10));

    if (!s_ready) {
        if (spi_init() != ESP_OK) {
            /* A retry after a failed first init can leave the bus allocated. */
            spi_bus_free(EPD_SPI_HOST);
            ESP_RETURN_ON_ERROR(spi_init(), TAG, "spi retry");
        }
        ESP_RETURN_ON_ERROR(gpio_init(), TAG, "gpio");
        s_ready = true;
    }

    if (warm) {
        /* ALDO3 stayed on across deep sleep and the controller was never reset,
         * so its RAM and register configuration are still valid. */
        return ESP_OK;
    }

    hardware_reset();
    ESP_RETURN_ON_ERROR(wait_busy(), TAG, "reset");
    /* A cold init is the boot-time "quality" configuration; callers that want
     * the fast profile select it explicitly per full refresh. */
    ESP_RETURN_ON_ERROR(panel_init(false), TAG, "panel init");
    s_fast_profile = false;
    return ESP_OK;
}

/** Update sequence byte: 0xF7 = normal waveform, 0xD7 = vendor "fast". */
#define EPD_UPDATE_NORMAL 0xF7
#define EPD_UPDATE_FAST 0xD7

/**
 * Push one full frame to the panel.
 *
 * `fast` picks the vendor's fast profile: panel_init(fast) + the 0xD7 update
 * sequence instead of 0xF7. The vendor reference driver labels that path
 * "Fast(1.5s)" against roughly 3-4 s for the normal waveform.
 */
static esp_err_t show_full_impl(const uint8_t *framebuffer, bool fast)
{
    if (!s_ready || framebuffer == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    const int64_t start_ms = esp_timer_get_time() / 1000;
    /* A partial refresh hardware-resets the controller (see show_region); the
     * panel configuration has to be restored before the next full frame or the
     * image comes out shifted. Re-init in whichever mode this frame needs, so
     * the 0x1A fast profile and the waveform agree. */
    if (s_config_stale || fast != s_fast_profile) {
        ESP_RETURN_ON_ERROR(panel_init(fast), TAG, "re-init for full frame");
        s_config_stale = false;
        s_fast_profile = fast;
    }
    /* A previous partial refresh left the RAM window on the clock rectangle;
     * writing the whole framebuffer into it would wrap the data. */
    ESP_RETURN_ON_ERROR(set_full_window(), TAG, "full window");
    ESP_RETURN_ON_ERROR(send_command(0x24), TAG, "write new ram");
    ESP_RETURN_ON_ERROR(send_buffer(framebuffer, INKPANE_EPD_FB_SIZE), TAG, "new ram data");
    ESP_RETURN_ON_ERROR(send_command(0x26), TAG, "write old ram");
    ESP_RETURN_ON_ERROR(send_buffer(framebuffer, INKPANE_EPD_FB_SIZE), TAG, "old ram data");

    const int64_t transfer_ms = esp_timer_get_time() / 1000;
    ESP_RETURN_ON_ERROR(send_command(0x22), TAG, "display update");
    ESP_RETURN_ON_ERROR(send_data(fast ? EPD_UPDATE_FAST : EPD_UPDATE_NORMAL), TAG,
                        "update sequence");
    ESP_RETURN_ON_ERROR(send_command(0x20), TAG, "activate");
    esp_err_t err = wait_busy();
    const int64_t end_ms = esp_timer_get_time() / 1000;
    /* Split the two halves: the SPI push is CPU/bus bound, the waveform wait is
     * the panel settling. Knowing which dominates decides whether more work
     * should go into the bus path or into the update profile. */
    ESP_LOGI(TAG, "full refresh (%s): %d ms total (%d ms transfer, %d ms waveform)",
             fast ? "fast" : "normal", (int)(end_ms - start_ms), (int)(transfer_ms - start_ms),
             (int)(end_ms - transfer_ms));
    return err;
}

esp_err_t inkpane_epd_show_full(const uint8_t *framebuffer)
{
    return show_full_impl(framebuffer, false);
}

esp_err_t inkpane_epd_show_full_fast(const uint8_t *framebuffer)
{
    return show_full_impl(framebuffer, true);
}

void inkpane_epd_mark_config_stale(void)
{
    s_config_stale = true;
}

esp_err_t inkpane_epd_show_region(const uint8_t *framebuffer, int x, int y, int width, int height)
{
    if (!s_ready || framebuffer == NULL || width <= 0 || height <= 0) {
        return ESP_ERR_INVALID_ARG;
    }
    if (x < 0) {
        width += x;
        x = 0;
    }
    if (y < 0) {
        height += y;
        y = 0;
    }
    if (x + width > INKPANE_EPD_WIDTH) {
        width = INKPANE_EPD_WIDTH - x;
    }
    if (y + height > INKPANE_EPD_HEIGHT) {
        height = INKPANE_EPD_HEIGHT - y;
    }
    if (width <= 0 || height <= 0) {
        return ESP_ERR_INVALID_ARG;
    }

    const int x0 = (x / 8) * 8;
    const int x1 = ((x + width + 7) / 8) * 8;
    const int stride = (x1 - x0) / 8;
    const size_t packed_size = (size_t)stride * height;
    uint8_t *packed = heap_caps_malloc(packed_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (packed == NULL) {
        return ESP_ERR_NO_MEM;
    }
    for (int row = 0; row < height; ++row) {
        memcpy(packed + (size_t)row * stride,
               framebuffer + (size_t)(y + row) * INKPANE_EPD_STRIDE + x0 / 8,
               stride);
    }

    /* Waveshare 3.97 reference driver (EPD_Display_Partial) does a hardware
     * reset before every partial window. Without it the controller keeps a
     * stale internal address state, so the band starts at the previous cursor
     * instead of the requested one. The reset only clears the controller
     * state; the panel keeps its image. */
    rst_low();
    vTaskDelay(pdMS_TO_TICKS(2));
    rst_high();
    vTaskDelay(pdMS_TO_TICKS(50));
    /* The reset cleared the 0x1A profile and all window registers; the next
     * full refresh must re-run panel_init() regardless of which profile it
     * wants. */
    s_config_stale = true;

    esp_err_t err = ESP_OK;
    if (err == ESP_OK) {
        err = send_command(0x18);
    }
    if (err == ESP_OK) {
        err = send_data(0x80);
    }
    if (err == ESP_OK) {
        err = send_command(0x3C);
    }
    if (err == ESP_OK) {
        err = send_data(0x80);
    }
    /* Window registers: X stays in pixel units (2 bytes each) and X end is the
     * first pixel of the last byte column.
     *
     * The 800x480 SSD1677 panel has its gate lines wired bottom-to-top, so the
     * controller's RAM Y is mirrored against the visible image:
     *
     *     visible row y  <->  RAM row (HEIGHT - 1 - y)
     *
     * Together with data entry mode 0x01 (X increment, Y decrement) the RAM
     * scan runs downwards from the window's first Y value. A region that must
     * appear at visible y..y+height-1 therefore has to be programmed as:
     *
     *     RAM start = HEIGHT - 1 - y          (visible top row)
     *     RAM end   = HEIGHT - y - height     (visible bottom row)
     *
     * Sending the visible y..y+height-1 values directly makes the scan walk off
     * RAM row 0, wrap to the bottom and paint the band across the screen edge
     * (this is the "clock shows up below the todo list" bug). GxEPD2 uses the
     * same mirroring for these panels (GxEPD2_426_GDEQ0426T82). */
    const int pixel_x0 = x0;
    const int pixel_x1 = x1 - 8;
    const int pixel_y0 = INKPANE_EPD_HEIGHT - 1 - y;
    const int pixel_y1 = INKPANE_EPD_HEIGHT - y - height;
    ESP_LOGD(TAG, "partial %dx%d at (%d,%d), ram y %d..%d, bytes=%d", width, height, x, y,
             pixel_y0, pixel_y1, stride);
    if (err == ESP_OK) err = send_command(0x11);
    if (err == ESP_OK) err = send_data(0x01);
    if (err == ESP_OK) err = send_command(0x44);
    if (err == ESP_OK) err = send_data(pixel_x0 & 0xFF);
    if (err == ESP_OK) err = send_data((pixel_x0 >> 8) & 0xFF);
    if (err == ESP_OK) err = send_data(pixel_x1 & 0xFF);
    if (err == ESP_OK) err = send_data((pixel_x1 >> 8) & 0xFF);
    if (err == ESP_OK) err = send_command(0x45);
    if (err == ESP_OK) err = send_data(pixel_y0 & 0xFF);
    if (err == ESP_OK) err = send_data((pixel_y0 >> 8) & 0xFF);
    if (err == ESP_OK) err = send_data(pixel_y1 & 0xFF);
    if (err == ESP_OK) err = send_data((pixel_y1 >> 8) & 0xFF);
    if (err == ESP_OK) err = send_command(0x4E);
    if (err == ESP_OK) err = send_data(pixel_x0 & 0xFF);
    if (err == ESP_OK) err = send_data((pixel_x0 >> 8) & 0xFF);
    if (err == ESP_OK) err = send_command(0x4F);
    if (err == ESP_OK) err = send_data(pixel_y0 & 0xFF);
    if (err == ESP_OK) err = send_data((pixel_y0 >> 8) & 0xFF);
    if (err == ESP_OK) err = send_command(0x24);
    if (err == ESP_OK) err = send_buffer(packed, packed_size);
    if (err == ESP_OK) err = send_command(0x22);
    if (err == ESP_OK) err = send_data(0xFF);
    if (err == ESP_OK) err = send_command(0x20);
    if (err == ESP_OK) err = wait_busy();

    heap_caps_free(packed);
    return err;
}

esp_err_t inkpane_epd_sleep(void)
{
    if (!s_ready) {
        inkpane_board_epd_power(false);
        return ESP_ERR_INVALID_STATE;
    }
    esp_err_t err = send_command(0x10);
    if (err == ESP_OK) {
        err = send_data(0x01);
    }
    vTaskDelay(pdMS_TO_TICKS(10));
    rst_low();
    dc_command();
    inkpane_board_epd_power(false);
    vTaskDelay(pdMS_TO_TICKS(10));
    return err;
}

void inkpane_epd_deinit(void)
{
    if (s_ready) {
        spi_bus_remove_device(s_spi);
        spi_bus_free(EPD_SPI_HOST);
        s_ready = false;
    }
}
