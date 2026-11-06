#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define INKPANE_EPD_WIDTH 800
#define INKPANE_EPD_HEIGHT 480
#define INKPANE_EPD_STRIDE (INKPANE_EPD_WIDTH / 8)
#define INKPANE_EPD_FB_SIZE (INKPANE_EPD_STRIDE * INKPANE_EPD_HEIGHT)

/**
 * Initialize SPI, GPIOs and the panel controller. Powers the EPD rail.
 *
 * `warm` is true after a deep-sleep wake where ALDO3 stayed powered: the
 * controller keeps its RAM and register state, so the hardware reset and
 * panel_init are skipped and a partial refresh can be issued directly.
 * A cold init resets and configures the controller; the caller must follow it
 * with a full refresh.
 */
esp_err_t inkpane_epd_init(bool warm);

/** Full refresh from a 800x480 1-bit buffer (1 = white, 0 = black). */
esp_err_t inkpane_epd_show_full(const uint8_t *framebuffer);

/**
 * Partial refresh of one screen region. The region is copied out of the
 * framebuffer (x is aligned down/up to byte boundaries) before transfer.
 *
 * Like the vendor driver it hardware-resets the controller before every
 * partial window, which clears the registers that panel_init() programmed.
 * The panel image survives the reset, but the next full refresh must re-run
 * panel_init() first; the driver tracks that internally and also exposes
 * inkpane_epd_mark_config_stale() for callers that persist the state across
 * deep sleep.
 */
esp_err_t inkpane_epd_show_region(const uint8_t *framebuffer, int x, int y, int width, int height);

/**
 * Mark the controller configuration as stale so the next full refresh re-runs
 * panel_init() before writing the frame.
 *
 * `show_region()` sets this internally, but that flag lives in normal RAM and
 * is lost across deep sleep while the panel rail stays powered. A caller that
 * persists "a partial refresh happened" in RTC memory must call this after a
 * warm init on the next wake.
 */
void inkpane_epd_mark_config_stale(void);

/** Put the controller to deep sleep and cut the panel rail (provisioning / teardown). */
esp_err_t inkpane_epd_sleep(void);

/** Release the SPI bus (used only by the provisioning screen before reboot). */
void inkpane_epd_deinit(void);
