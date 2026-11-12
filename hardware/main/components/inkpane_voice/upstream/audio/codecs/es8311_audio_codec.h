#ifndef _ES8311_AUDIO_CODEC_H
#define _ES8311_AUDIO_CODEC_H

#include "audio_codec.h"

#include <driver/i2c_master.h>
#include <driver/gpio.h>
#include <esp_codec_dev.h>
#include <esp_codec_dev_defaults.h>
#include <cstdint>
#include <mutex>
#include <vector>


class Es8311AudioCodec : public AudioCodec {
private:
    /* The board has one microphone and no hardware playback reference. When
     * barge-in is enabled we synthesise the missing reference channel from the
     * PCM sent to the speaker so the AFE can cancel its own echo. The ring holds
     * ~340 ms at 24 kHz, enough to cover the I2S DMA latency plus jitter. */
    static constexpr size_t kReferenceRingSamples = 8192;
    /* TX DMA depth (AUDIO_CODEC_DMA_DESC_NUM * AUDIO_CODEC_DMA_FRAME_NUM = 1440
     * frames at 24 kHz), one 10 ms write chunk, and the codec/air delay. */
    static constexpr uint64_t kReferenceDelaySamples = 1680;
    static constexpr int64_t kReferenceIdleUs = 150000;

    const audio_codec_data_if_t* data_if_ = nullptr;
    const audio_codec_ctrl_if_t* ctrl_if_ = nullptr;
    const audio_codec_if_t* codec_if_ = nullptr;
    const audio_codec_gpio_if_t* gpio_if_ = nullptr;

    esp_codec_dev_handle_t dev_ = nullptr;
    gpio_num_t pa_pin_ = GPIO_NUM_NC;
    bool pa_inverted_ = false;
    bool use_reference_ = false;
    std::mutex data_if_mutex_;

    std::mutex reference_mutex_;
    std::vector<int16_t> reference_ring_;
    uint64_t reference_written_ = 0;
    uint64_t reference_consumed_ = 0;
    bool reference_valid_ = false;
    bool reference_reset_pending_ = false;
    int64_t last_output_us_ = 0;

    void StoreReference(const int16_t* data, int samples);

    void CreateDuplexChannels(gpio_num_t mclk, gpio_num_t bclk, gpio_num_t ws, gpio_num_t dout, gpio_num_t din);
    void ResetCodec();
    void UpdateDeviceState();

    virtual int Read(int16_t* dest, int samples) override;
    virtual int Write(const int16_t* data, int samples) override;

public:
    Es8311AudioCodec(void* i2c_master_handle, i2c_port_t i2c_port, int input_sample_rate, int output_sample_rate,
        gpio_num_t mclk, gpio_num_t bclk, gpio_num_t ws, gpio_num_t dout, gpio_num_t din,
        gpio_num_t pa_pin, uint8_t es8311_addr, bool use_mclk = true, bool pa_inverted = false,
        bool use_reference = false);
    virtual ~Es8311AudioCodec();

    virtual void SetOutputVolume(int volume) override;
    virtual void EnableInput(bool enable) override;
    virtual void EnableOutput(bool enable) override;
};

#endif // _ES8311_AUDIO_CODEC_H
