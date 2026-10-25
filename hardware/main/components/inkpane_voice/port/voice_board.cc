#include "voice_board.h"

#include "es8311_audio_codec.h"

extern "C" {
#include "esp_log.h"
#include "inkpane_board.h"
}

#define TAG "voice_board"

/* Waveshare ESP32-S3-ePaper-3.97 audio wiring (same as the xiaozhi board). */
#define VOICE_I2S_MCLK GPIO_NUM_13
#define VOICE_I2S_BCLK GPIO_NUM_14
#define VOICE_I2S_WS GPIO_NUM_47
#define VOICE_I2S_DOUT GPIO_NUM_48
#define VOICE_I2S_DIN GPIO_NUM_21
#define VOICE_PA_PIN GPIO_NUM_39
#define VOICE_SAMPLE_RATE 24000

static Es8311AudioCodec *s_codec;

AudioCodec *inkpane_voice_board_codec(void)
{
    if (s_codec != nullptr) {
        return s_codec;
    }
    i2c_master_bus_handle_t bus = inkpane_board_i2c_bus();
    if (bus == nullptr) {
        ESP_LOGE(TAG, "shared I2C bus is not initialized");
        return nullptr;
    }
    ESP_LOGI(TAG, "creating ES8311 codec");
    s_codec = new Es8311AudioCodec(static_cast<void *>(bus), I2C_NUM_0, VOICE_SAMPLE_RATE,
                                   VOICE_SAMPLE_RATE, VOICE_I2S_MCLK, VOICE_I2S_BCLK, VOICE_I2S_WS,
                                   VOICE_I2S_DOUT, VOICE_I2S_DIN, VOICE_PA_PIN,
                                   ES8311_CODEC_DEFAULT_ADDR, true, false);
    return s_codec;
}
