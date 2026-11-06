#pragma once

#include <stdint.h>

/* Geometry of a 1-bit framebuffer, independent of ESP-IDF so the host tests can
 * compile this module on its own. */

/** Full-screen refresh is cheaper or required; see inkpane_frame_diff_bands(). */
#define INKPANE_FRAME_DIFF_FULL (-1)

/** One full-width horizontal band that has to be repainted. */
typedef struct {
    int y;      /* first row, 0-based */
    int height; /* number of rows, always > 0 */
} inkpane_damage_band_t;

/**
 * Compare two 1-bit framebuffers row by row and report the horizontal bands
 * that changed.
 *
 * Both frames hold `height` rows of `stride` bytes; only the first
 * `(width + 7) / 8` bytes of each row are compared. A row is dirty when any of
 * those bytes differ, so every reported band spans the full width (the panel
 * window is therefore byte aligned by construction).
 *
 * Consecutive dirty rows form one band. Bands separated by fewer than
 * `merge_gap_rows` clean rows are merged into a single band: each band costs a
 * panel reset plus a window update, so absorbing a few unchanged rows is
 * cheaper than paying for an extra window. Merged bands fill the gap with the
 * clean rows; the caller is expected to repaint the whole band from the new
 * frame anyway.
 *
 * Returns
 *  - 0  when the frames are identical,
 *  - >0 the number of bands written to `out` (at most `max_bands`), or
 *  - INKPANE_FRAME_DIFF_FULL when a full-screen refresh should be used instead,
 *    which is the case when the damage exceeds either budget:
 *      * more than `max_bands` bands after merging,
 *      * more than `max_covered_rows` rows covered by those bands (merged
 *        clean rows count, because the panel drives the whole window).
 *
 * `out` must have room for `max_bands` entries and is left untouched when the
 * result is 0 or INKPANE_FRAME_DIFF_FULL. Invalid arguments also return
 * INKPANE_FRAME_DIFF_FULL so a caller can never under-refresh on bad input.
 */
int inkpane_frame_diff_bands(const uint8_t *before, const uint8_t *after, int width, int height,
                             int stride, int merge_gap_rows, int max_bands, int max_covered_rows,
                             inkpane_damage_band_t *out);
