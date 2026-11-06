#include "inkpane_frame_diff.h"

#include <string.h>

/* One band being accumulated while the rows are scanned. `out[]` cannot be
 * written as we go: a budget overflow has to leave the caller's buffer
 * untouched, so the frame is scanned twice - once to check the budgets, once to
 * emit the bands. `end` is one past the last dirty row, so clean rows inside a
 * merged gap are covered by `height = end - y` when the band is closed. */
typedef struct {
    int y;   /* first dirty row of this band */
    int end; /* one past the last dirty row */
    int gap; /* clean rows seen since `end` */
    int open;
} band_scan_t;

/* Reuse one loop for both passes: `out == NULL` counts bands/rows only, a
 * non-NULL `out` writes them. The caller guarantees `count < max_bands`. */
static void scan_bands(const uint8_t *before, const uint8_t *after, int height, int stride,
                       size_t row_bytes, int merge_gap_rows, inkpane_damage_band_t *out,
                       int *band_count, int *covered_rows)
{
    band_scan_t band = {0, 0, 0, 0};
    int count = 0;
    int covered = 0;

    for (int y = 0; y < height; ++y) {
        const size_t offset = (size_t)y * (size_t)stride;
        const int dirty = memcmp(before + offset, after + offset, row_bytes) != 0;

        if (dirty) {
            if (!band.open) {
                band.y = y;
                band.open = 1;
            }
            band.end = y + 1;
            band.gap = 0;
            continue;
        }
        if (!band.open) {
            continue;
        }
        /* A gap narrower than merge_gap_rows is cheaper to drive as part of the
         * band than to pay for another panel reset and window update. */
        ++band.gap;
        if (band.gap >= merge_gap_rows) {
            const int band_height = band.end - band.y;
            if (out != NULL) {
                out[count].y = band.y;
                out[count].height = band_height;
            }
            ++count;
            covered += band_height;
            band.open = 0;
        }
    }

    if (band.open) {
        const int band_height = band.end - band.y;
        if (out != NULL) {
            out[count].y = band.y;
            out[count].height = band_height;
        }
        ++count;
        covered += band_height;
    }

    *band_count = count;
    *covered_rows = covered;
}

int inkpane_frame_diff_bands(const uint8_t *before, const uint8_t *after, int width, int height,
                             int stride, int merge_gap_rows, int max_bands, int max_covered_rows,
                             inkpane_damage_band_t *out)
{
    /* Never under-refresh on bad input: a full refresh is always safe. */
    if (before == NULL || after == NULL || out == NULL || width <= 0 || height <= 0 ||
        stride <= 0 || merge_gap_rows < 0 || max_bands <= 0 || max_covered_rows <= 0) {
        return INKPANE_FRAME_DIFF_FULL;
    }
    /* width / 8 instead of (width + 7) / 8 avoids overflowing int for width
     * near INT_MAX; both forms are the same for positive widths. */
    const int row_bytes = width / 8 + (width % 8 != 0);
    if (stride < row_bytes) {
        return INKPANE_FRAME_DIFF_FULL;
    }

    int band_count = 0;
    int covered_rows = 0;
    scan_bands(before, after, height, stride, (size_t)row_bytes, merge_gap_rows, NULL, &band_count,
               &covered_rows);

    if (band_count == 0) {
        return 0;
    }
    /* Both budgets are about panel work, so an over-budget frame is cheaper to
     * drive full-screen than as many small windows. */
    if (band_count > max_bands || covered_rows > max_covered_rows) {
        return INKPANE_FRAME_DIFF_FULL;
    }

    scan_bands(before, after, height, stride, (size_t)row_bytes, merge_gap_rows, out, &band_count,
               &covered_rows);
    return band_count;
}
