/*
 * Line splatting for raster tiles (see netmap/tiles.py).
 *
 * Each segment (already clipped to the tile, in pixel coordinates) is sampled
 * along its length every `spacing` pixels (stratified, jittered from a
 * per-tile seed) and each sample is splatted bilinearly into a float RGB
 * accumulator, weighted by the segment's colour times the pixel length the
 * sample stands for. If the tile would need more than `max_samples` samples,
 * every segment is thinned by the same factor (weights compensate).
 *
 * One pass, no temporaries: the numpy version materialises several arrays
 * of millions of samples per tile. Single-threaded on purpose; tiles are
 * rendered in parallel by the process pool.
 */

#include <math.h>
#include <stdint.h>

static inline uint64_t mix64(uint64_t *s) {
    uint64_t z = (*s += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

static inline float unit(uint64_t *s) { return (float)(mix64(s) >> 40) * (1.0f / 16777216.0f); }

/* acc is [3][h][w] float32, accumulated into (not cleared). */
void netmap_splat_lines(int64_t n, const float *x0, const float *y0, const float *x1, const float *y1,
                        const float *rgbw, /* [n][3] colour * weight */
                        float spacing, int64_t max_samples, uint64_t seed, int32_t w, int32_t h,
                        float *acc) {
    double total = 0;
    for (int64_t k = 0; k < n; k++) {
        float len = hypotf(x1[k] - x0[k], y1[k] - y0[k]);
        total += ceilf(len / spacing) > 1 ? ceilf(len / spacing) : 1;
    }
    double thin = total > (double)max_samples ? (double)max_samples / total : 1.0;
    float *R = acc, *G = acc + (int64_t)w * h, *B = acc + 2 * (int64_t)w * h;
    uint64_t rng = seed;
    for (int64_t k = 0; k < n; k++) {
        float dx = x1[k] - x0[k], dy = y1[k] - y0[k];
        float len = hypotf(dx, dy);
        float ns_f = ceilf(len / spacing);
        int64_t ns = (int64_t)(ns_f > 1 ? ns_f : 1);
        if (thin < 1.0) {
            ns = (int64_t)(ns * thin);
            if (ns < 1) ns = 1;
        }
        /* weight per sample: colour*weight times the pixel length it covers */
        float per = len / (float)ns;
        float cr = rgbw[3 * k] * per, cg = rgbw[3 * k + 1] * per, cb = rgbw[3 * k + 2] * per;
        float inv = 1.0f / (float)ns;
        for (int64_t i = 0; i < ns; i++) {
            float t = ((float)i + unit(&rng)) * inv;
            float px = x0[k] + t * dx, py = y0[k] + t * dy;
            float fx = floorf(px), fy = floorf(py);
            int32_t ix = (int32_t)fx, iy = (int32_t)fy;
            float ax = px - fx, ay = py - fy;
            float wgt[4] = {(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay};
            int32_t cx[4] = {ix, ix + 1, ix, ix + 1}, cy[4] = {iy, iy, iy + 1, iy + 1};
            for (int c = 0; c < 4; c++) {
                if (cx[c] < 0 || cx[c] >= w || cy[c] < 0 || cy[c] >= h) continue;
                int64_t o = (int64_t)cy[c] * w + cx[c];
                R[o] += cr * wgt[c];
                G[o] += cg * wgt[c];
                B[o] += cb * wgt[c];
            }
        }
    }
}
