#pragma once

#include "audio_codec.h"

/** Create (once) and return the ES8311 duplex codec on the shared I2C bus. */
AudioCodec *inkpane_voice_board_codec(void);
