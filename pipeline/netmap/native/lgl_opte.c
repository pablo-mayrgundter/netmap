/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Opte-style Large Graph Layout: a port of the layout procedure of LGL's
 * lglayout (Alex Adai 2002-2003, Barrett Lyon 2004-2022, GPLv2,
 * https://github.com/TheOpteProject/LGL), so this file is GPL too.
 *
 * What lglayout does, and what this reproduces:
 *
 *   1. A spanning tree guides the layout. Without weights, each edge weighs
 *      -(deg u + deg v), so the minimum spanning tree (Kruskal) prefers links
 *      between hubs. The root is the tree's median: the node with the least
 *      total hop distance to all others. Levels are BFS depth in the tree.
 *   2. Levels are added one at a time. Children of a node go on a circle of
 *      radius 0.1 around a spot beyond their parent: the direction averages
 *      the parent's offset from the centre of mass of the placed nodes and
 *      from its own parent (each weighted by its length, as lglayout's
 *      "unit vectors" are actually scaled by their magnitude); the distance
 *      is min(0.25 sqrt(children), 10), or 0 with leaves_close = 1 (in
 *      lglayout's -L the "has grandchildren" test never succeeds, so every
 *      family lands on its parent). leaves_close = 2 is what -L meant: only
 *      families that are all leaves start on their parent, so sparse parts
 *      become stars while hubs with descendants still spread apart. Level 1
 *      goes on a unit circle around the root.
 *   3. After each level, a particle simulation over the placed nodes:
 *      neighbours closer than 1 repel as springs of rest length 1, edges
 *      longer than 0.5 attract as springs of rest length 0.5 (both k = 10),
 *      each force component is clamped to 100 and each step to 0.05 with
 *      time step 0.001; overlapping nodes (closer than 0.02) get noise. It
 *      stops when the mean length of the level's edges stops changing
 *      (relative 1e-5) or after 150 iterations. A final settle runs once
 *      more over everything.
 *   4. tree_only lays out with the tree's edges (lglayout -y), otherwise
 *      with every edge between placed nodes.
 *
 * Pins (not in lglayout): nodes with fixed positions, given in layout units.
 * They are placed first and never move; the tree's levels then count hops
 * from the nearest pinned node, so LGL grows the free nodes out from the
 * pins (a family heads away from the parent's other placed neighbours) and
 * relaxes only them. Trees without a pin are laid out as usual, around the
 * pins' centre.
 *
 * Differences: forces are gathered per node over a 3x3 grid of unit cells
 * (the same pairs lglayout's half-stencil visits, each counted once per
 * node), positions are double-buffered and randomness comes from a counter
 * hash, so the result is the same for any thread count. Disconnected graphs
 * get one tree per component, roots spread over a disc. Plain C11 +
 * pthreads, so it also builds with emcc for the browser.
 */

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pool.h"

#define OPTE_OK 0
#define OPTE_ENOMEM 1
#define OPTE_EINVAL 2

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* lglayout's defaults (configs.h / lglayout.C) */
#define NBHD 1.0f        /* INTERACTION_RADIUS: repulsion range and rest length */
#define EQ 0.5f          /* edge rest length */
#define KSPRING 10.0f    /* DEFAULT_SPRING_CONSTANT, casual and special */
#define DT 0.001f        /* PART_TIME_STEP */
#define FMAX 100.0f      /* force limit .1 * voxel / dt */
#define STEPMAX 0.05f    /* per-component step limit in integrateFirstOrder */
#define COLLIDE2 0.0004f /* (2 * NODE_SIZE)^2 */
#define NOISE 1.0f
#define PLACE_RADIUS 0.1
#define CUTOFF 1e-5

static uint64_t mix64(uint64_t z) {
    z += 0x9E3779B97F4A7C15ull;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}
static double hash_unif(uint64_t a, uint64_t b) {
    return (double)(mix64(a ^ mix64(b)) >> 11) * (1.0 / 9007199254740992.0);
}

typedef struct {
    int64_t m;       /* nodes placed (ranks [0, m)) */
    int64_t lstart;  /* first rank of the current level */
    const int64_t *off;
    const int32_t *adj;   /* layout graph, rank space */
    const uint8_t *fixed; /* rank space; NULL: nothing pinned */
    float *x, *y, *nx, *ny;
    /* grid */
    float *sx, *sy;
    int32_t *sid, *cell_of, *slot, *cstart;
    int64_t cap_cells, gw, gh;
    float minx, miny;
    float *part; /* per-chunk partials (bounds, stats) */
    uint64_t seed, iter;
} opte_t;

#define CHUNK 4096

/* ----------------------------------------------------------------- grid -- */

static void bounds_job(void *ctx, int64_t lo, int64_t hi) {
    opte_t *S = ctx;
    float a = S->x[lo], b = a, c = S->y[lo], d = c;
    for (int64_t i = lo + 1; i < hi; i++) {
        float u = S->x[i], v = S->y[i];
        a = u < a ? u : a, b = u > b ? u : b;
        c = v < c ? v : c, d = v > d ? v : d;
    }
    float *p = S->part + 4 * (lo / CHUNK);
    p[0] = a, p[1] = b, p[2] = c, p[3] = d;
}

static void cell_job(void *ctx, int64_t lo, int64_t hi) {
    opte_t *S = ctx;
    for (int64_t i = lo; i < hi; i++) {
        int64_t gx = (int64_t)((S->x[i] - S->minx) / NBHD);
        int64_t gy = (int64_t)((S->y[i] - S->miny) / NBHD);
        gx = gx < 0 ? 0 : gx >= S->gw ? S->gw - 1 : gx;
        gy = gy < 0 ? 0 : gy >= S->gh ? S->gh - 1 : gy;
        S->cell_of[i] = (int32_t)(gy * S->gw + gx);
    }
}

static void scatter_job(void *ctx, int64_t lo, int64_t hi) {
    opte_t *S = ctx;
    for (int64_t i = lo; i < hi; i++) {
        int32_t s = S->slot[i];
        S->sid[s] = (int32_t)i;
        S->sx[s] = S->x[i];
        S->sy[s] = S->y[i];
    }
}

/* Counting-sort placed nodes into unit cells (ids ascending within a cell).
 * Cells are exactly the repulsion range, so a 3x3 neighbourhood is complete;
 * if the layout is so spread out that the grid would be huge, far-flung
 * nodes are clamped into the border cells (their pairs are still tested). */
static int build_grid(opte_t *S, pool_t *pool) {
    const int64_t m = S->m, nch = (m + CHUNK - 1) / CHUNK;
    pool_run(pool, bounds_job, S, m, CHUNK);
    float a = S->part[0], b = S->part[1], c = S->part[2], d = S->part[3];
    for (int64_t k = 1; k < nch; k++) {
        const float *p = S->part + 4 * k;
        a = p[0] < a ? p[0] : a, b = p[1] > b ? p[1] : b;
        c = p[2] < c ? p[2] : c, d = p[3] > d ? p[3] : d;
    }
    S->minx = a, S->miny = c;
    S->gw = (int64_t)((b - a) / NBHD) + 1;
    S->gh = (int64_t)((d - c) / NBHD) + 1;
    const int64_t maxcells = 16 * m + 4096;
    if (S->gw * S->gh > maxcells) { /* keep memory bounded: shrink the far side */
        double f = sqrt((double)maxcells / ((double)S->gw * S->gh));
        S->gw = (int64_t)(S->gw * f) + 1, S->gh = (int64_t)(S->gh * f) + 1;
        S->minx = (a + b) / 2 - S->gw * NBHD / 2, S->miny = (c + d) / 2 - S->gh * NBHD / 2;
    }
    int64_t ncell = S->gw * S->gh;
    if (ncell + 3 > S->cap_cells) {
        int32_t *p = realloc(S->cstart, (size_t)(ncell + 3) * sizeof(int32_t));
        if (!p) return OPTE_ENOMEM;
        S->cstart = p, S->cap_cells = ncell + 3;
    }
    pool_run(pool, cell_job, S, m, CHUNK);
    int32_t *cs = S->cstart;
    memset(cs, 0, (size_t)(ncell + 3) * sizeof(int32_t));
    for (int64_t i = 0; i < m; i++) cs[S->cell_of[i] + 2]++;
    for (int64_t q = 0; q < ncell; q++) cs[q + 2] += cs[q + 1];
    for (int64_t i = m - 1; i >= 0; i--) S->slot[i] = --cs[S->cell_of[i] + 2];
    cs[ncell + 2] = (int32_t)m;
    pool_run(pool, scatter_job, S, m, CHUNK);
    return OPTE_OK;
}

/* --------------------------------------------------------------- forces -- */

static void step_job(void *ctx, int64_t lo, int64_t hi) {
    opte_t *S = ctx;
    const float *restrict sx = S->sx, *restrict sy = S->sy;
    const float *restrict x = S->x, *restrict y = S->y;
    for (int64_t i = lo; i < hi; i++) {
        const float xi = x[i], yi = y[i];
        if (S->fixed && S->fixed[i]) {
            S->nx[i] = xi, S->ny[i] = yi;
            continue;
        }
        const int64_t c = S->cell_of[i], cx = c % S->gw, cy = c / S->gw;
        float fx = 0.f, fy = 0.f;
        int collide = 0;
        /* repulsion: springs of rest length NBHD between close neighbours */
        for (int64_t oy = cy - 1; oy <= cy + 1; oy++) {
            if (oy < 0 || oy >= S->gh) continue;
            int64_t c0 = oy * S->gw + (cx > 0 ? cx - 1 : 0);
            int64_t c1 = oy * S->gw + (cx + 1 < S->gw ? cx + 1 : cx);
            int64_t j0 = S->cstart[c0 + 2], j1 = S->cstart[c1 + 3];
#pragma omp simd reduction(+ : fx, fy, collide)
            for (int64_t j = j0; j < j1; j++) {
                float dx = xi - sx[j], dy = yi - sy[j];
                float d2 = dx * dx + dy * dy;
                int near = d2 < NBHD * NBHD;
                int hit = d2 <= COLLIDE2; /* includes self (d2 = 0) */
                float d = sqrtf(d2 > COLLIDE2 ? d2 : COLLIDE2); /* no 0/0, even masked */
                float w = (near && !hit) ? KSPRING * (NBHD - d) / d : 0.f;
                fx += dx * w;
                fy += dy * w;
                collide += hit;
            }
        }
        if (collide > 1) { /* overlapping: lglayout jiggles instead of pushing */
            uint64_t h = S->seed ^ (S->iter << 32) ^ (uint64_t)i;
            for (int k = 1; k < collide; k++) {
                float u = (float)hash_unif(h, 2 * k), v = (float)hash_unif(h, 2 * k + 1);
                fx += NOISE * (2 * u - 1), fy += NOISE * (2 * v - 1);
            }
        }
        /* attraction: edges longer than EQ pull like springs of rest EQ */
        for (int64_t p = S->off[i]; p < S->off[i + 1]; p++) {
            int32_t v = S->adj[p];
            if (v >= S->m) continue;
            float dx = xi - x[v], dy = yi - y[v];
            float d = sqrtf(dx * dx + dy * dy);
            if (d > EQ) {
                float w = -KSPRING * (d - EQ) / d;
                fx += dx * w, fy += dy * w;
            }
        }
        fx = fx > FMAX ? FMAX : fx < -FMAX ? -FMAX : fx;
        fy = fy > FMAX ? FMAX : fy < -FMAX ? -FMAX : fy;
        float sx_ = fx * DT, sy_ = fy * DT;
        sx_ = sx_ > STEPMAX ? STEPMAX : sx_ < -STEPMAX ? -STEPMAX : sx_;
        sy_ = sy_ > STEPMAX ? STEPMAX : sy_ < -STEPMAX ? -STEPMAX : sy_;
        S->nx[i] = xi + sx_;
        S->ny[i] = yi + sy_;
    }
}

/* Mean length of layout edges touching the current level (lglayout's
 * convergence statistic); per fixed chunk so the sum is thread-independent. */
static void stats_job(void *ctx, int64_t lo, int64_t hi) {
    opte_t *S = ctx;
    double sum = 0;
    int64_t cnt = 0;
    for (int64_t r = S->lstart + lo; r < S->lstart + hi; r++) {
        for (int64_t p = S->off[r]; p < S->off[r + 1]; p++) {
            int32_t v = S->adj[p];
            if (v >= S->m || (v >= S->lstart && v > r)) continue; /* each edge once */
            float dx = S->x[r] - S->x[v], dy = S->y[r] - S->y[v];
            sum += sqrt((double)dx * dx + (double)dy * dy);
            cnt++;
        }
    }
    float *p = S->part + 4 * (lo / CHUNK);
    p[0] = (float)sum, p[1] = (float)cnt;
}

static double edge_stat(opte_t *S, pool_t *pool) {
    int64_t len = S->m - S->lstart;
    if (len <= 0) return 0;
    pool_run(pool, stats_job, S, len, CHUNK);
    double sum = 0, cnt = 0;
    for (int64_t k = 0; k < (len + CHUNK - 1) / CHUNK; k++) sum += S->part[4 * k], cnt += S->part[4 * k + 1];
    return cnt > 0 ? sum / cnt : 0;
}

/* One level's relaxation: lglayout's beginSimulation loop body. */
static int relax(opte_t *S, pool_t *pool, double cutoff, int maxiter, long *iters) {
    double dx = 1e7, avg_prev = 0;
    for (int it = 0;; it++) {
        int rc = build_grid(S, pool);
        if (rc) return rc;
        pool_run(pool, step_job, S, S->m, 512);
        float *t = S->x;
        S->x = S->nx, S->nx = t;
        t = S->y, S->y = S->ny, S->ny = t;
        S->iter++;
        (*iters)++;
        double dnew = edge_stat(S, pool);
        double avg = 0.5 * (dnew + dx);
        if (dnew <= 0 || fabs(dnew - dx) / dnew < cutoff || it > maxiter ||
            (avg > 0 && fabs(avg_prev - avg) / avg < 0.1 * cutoff))
            break;
        avg_prev = avg, dx = dnew;
    }
    return OPTE_OK;
}

/* ---------------------------------------------------------------- tree -- */

typedef struct {
    double w;
    int64_t k;
} wedge_t;

static int wedge_cmp(const void *a, const void *b) {
    const wedge_t *p = a, *q = b;
    if (p->w != q->w) return p->w < q->w ? -1 : 1;
    return p->k < q->k ? -1 : p->k > q->k;
}

static int32_t uf_find(int32_t *uf, int32_t a) {
    while (uf[a] != a) a = uf[a] = uf[uf[a]];
    return a;
}

/* Build CSR from an edge list (both directions). */
static int csr(int32_t n, int64_t e, const int32_t *s, const int32_t *d, int64_t **off_o, int32_t **adj_o) {
    int64_t *off = calloc((size_t)n + 1, sizeof(int64_t));
    if (!off) return OPTE_ENOMEM;
    for (int64_t k = 0; k < e; k++) off[s[k] + 1]++, off[d[k] + 1]++;
    for (int32_t i = 0; i < n; i++) off[i + 1] += off[i];
    int32_t *adj = malloc((size_t)(off[n] > 0 ? off[n] : 1) * sizeof(int32_t));
    int64_t *pos = malloc(((size_t)n + 1) * sizeof(int64_t));
    if (!adj || !pos) return free(off), free(adj), free(pos), OPTE_ENOMEM;
    memcpy(pos, off, ((size_t)n + 1) * sizeof(int64_t));
    for (int64_t k = 0; k < e; k++) adj[pos[s[k]]++] = d[k], adj[pos[d[k]]++] = s[k];
    free(pos);
    *off_o = off, *adj_o = adj;
    return OPTE_OK;
}

/*
 * n nodes, e undirected edges (src, dst), optional weights (NULL: lglayout's
 * hub preference; otherwise lower = kept in the tree, as with lglayout -O).
 * root < 0 picks the tree median. tree_only: layout with tree edges only
 * (-y); leaves_close: 1 = every family starts on its parent (-L as it
 * behaves), 2 = only all-leaf families do (-L as meant). maxiter per level
 * (<= 0: 150). pinned[n] and pin_xy[2n] (both NULL, or both given): nodes
 * held at fixed positions. Writes x,y for each node to xy_out[2n];
 * levels_out[n] (optional) gets each node's tree depth (hops from a pin).
 */
int netmap_lgl_opte(int32_t n, int64_t e, const int32_t *src, const int32_t *dst, const double *weight,
                    int32_t root, int32_t tree_only, int32_t leaves_close, int32_t maxiter, uint64_t seed,
                    int32_t nthreads, const uint8_t *pinned, const double *pin_xy, double *xy_out,
                    int32_t *levels_out) {
    if (n <= 0 || root >= n || (!pinned) != (!pin_xy)) return OPTE_EINVAL;
    if (maxiter <= 0) maxiter = 150;
    if (nthreads <= 0) nthreads = cpu_count_online();
    int rc = OPTE_ENOMEM;
    int64_t *goff = NULL, *toff = NULL, *loff = NULL;
    int32_t *gadj = NULL, *tadj = NULL, *ladj = NULL, *uf = NULL, *ts = NULL, *td = NULL;
    int32_t *order = NULL, *rank = NULL, *tpar = NULL, *level = NULL, *layer_end = NULL, *comp_root = NULL;
    uint8_t *fixed = NULL;
    int64_t *sub = NULL;
    double *dist = NULL;
    wedge_t *we = NULL;
    opte_t S;
    memset(&S, 0, sizeof S);

    for (int64_t k = 0; k < e; k++)
        if (src[k] < 0 || src[k] >= n || dst[k] < 0 || dst[k] >= n) return OPTE_EINVAL;
    if ((rc = csr(n, e, src, dst, &goff, &gadj))) goto done;
    rc = OPTE_ENOMEM;

    /* 1. spanning tree (Kruskal) */
    we = malloc((size_t)(e > 0 ? e : 1) * sizeof(wedge_t));
    uf = malloc((size_t)n * sizeof(int32_t));
    ts = malloc((size_t)(n > 1 ? n : 1) * sizeof(int32_t));
    td = malloc((size_t)(n > 1 ? n : 1) * sizeof(int32_t));
    if (!we || !uf || !ts || !td) goto done;
    int64_t ne = 0;
    for (int64_t k = 0; k < e; k++) {
        if (src[k] == dst[k]) continue;
        double w = weight ? weight[k]
                          : -(double)((goff[src[k] + 1] - goff[src[k]]) + (goff[dst[k] + 1] - goff[dst[k]]));
        we[ne].w = w, we[ne].k = k, ne++;
    }
    qsort(we, (size_t)ne, sizeof(wedge_t), wedge_cmp);
    for (int32_t i = 0; i < n; i++) uf[i] = i;
    int64_t nt = 0;
    for (int64_t q = 0; q < ne && nt < n - 1; q++) {
        int32_t a = uf_find(uf, src[we[q].k]), b = uf_find(uf, dst[we[q].k]);
        if (a == b) continue;
        uf[a] = b;
        ts[nt] = src[we[q].k], td[nt] = dst[we[q].k], nt++;
    }
    free(we), we = NULL;
    if ((rc = csr(n, nt, ts, td, &toff, &tadj))) goto done;
    rc = OPTE_ENOMEM;

    /* 2. roots: the median of each tree (least total hop distance) */
    order = malloc((size_t)n * sizeof(int32_t));
    rank = malloc((size_t)n * sizeof(int32_t));
    tpar = malloc((size_t)n * sizeof(int32_t));
    level = malloc((size_t)n * sizeof(int32_t));
    sub = malloc((size_t)n * sizeof(int64_t));
    dist = malloc((size_t)n * sizeof(double));
    comp_root = malloc((size_t)n * sizeof(int32_t));
    if (!order || !rank || !tpar || !level || !sub || !dist || !comp_root) goto done;
    for (int32_t i = 0; i < n; i++) rank[i] = -1;
    int32_t ncomp = 0;
    for (int32_t s0 = 0; s0 < n; s0++) {
        if (rank[s0] >= 0) continue;
        /* BFS this tree from s0 */
        int32_t head = 0, tail = 0;
        order[tail++] = s0, rank[s0] = 0, tpar[s0] = -1, level[s0] = 0;
        double tot = 0;
        while (head < tail) {
            int32_t u = order[head++];
            for (int64_t p = toff[u]; p < toff[u + 1]; p++) {
                int32_t v = tadj[p];
                if (rank[v] >= 0) continue;
                rank[v] = 0, tpar[v] = u, level[v] = level[u] + 1, tot += level[v];
                order[tail++] = v;
            }
        }
        int has_pin = 0;
        for (int32_t q = 0; q < tail && pinned && !has_pin; q++) has_pin = pinned[order[q]] != 0;
        if (has_pin) continue; /* grown from its pins instead */
        for (int32_t q = 0; q < tail; q++) sub[order[q]] = 1;
        for (int32_t q = tail - 1; q > 0; q--) sub[tpar[order[q]]] += sub[order[q]];
        int32_t best = s0;
        dist[s0] = tot;
        for (int32_t q = 1; q < tail; q++) {
            int32_t v = order[q];
            dist[v] = dist[tpar[v]] - sub[v] + (tail - sub[v]);
            if (dist[v] < dist[best]) best = v;
        }
        if (root >= 0 && rank[root] >= 0 && level[root] >= 0) {
            /* the caller's root wins for its tree */
            for (int32_t q = 0; q < tail; q++)
                if (order[q] == root) best = root;
        }
        comp_root[ncomp++] = best;
    }
    free(sub), sub = NULL;
    free(dist), dist = NULL;

    /* 3. levels: BFS over the tree from the pins and roots, all trees
     * together, so ranks run level by level and each family is contiguous */
    for (int32_t i = 0; i < n; i++) rank[i] = -1;
    int32_t tail = 0;
    for (int32_t i = 0; pinned && i < n; i++)
        if (pinned[i]) order[tail] = i, rank[i] = tail++, tpar[i] = -1, level[i] = 0;
    const int32_t npin = tail;
    for (int32_t c = 0; c < ncomp; c++) {
        int32_t r = comp_root[c];
        order[tail] = r, rank[r] = tail++, tpar[r] = -1, level[r] = 0;
    }
    layer_end = malloc(((size_t)n + 1) * sizeof(int32_t));
    if (!layer_end) goto done;
    int32_t nlayers = 0, head = 0;
    while (head < tail) {
        int32_t end = tail;
        for (; head < end; head++) {
            int32_t u = order[head];
            for (int64_t p = toff[u]; p < toff[u + 1]; p++) {
                int32_t v = tadj[p];
                if (rank[v] >= 0) continue;
                rank[v] = tail, tpar[v] = u, level[v] = level[u] + 1;
                order[tail++] = v;
            }
        }
        layer_end[nlayers++] = end;
    }

    /* layout graph in rank space */
    {
        const int64_t *o = tree_only ? toff : goff;
        const int32_t *a = tree_only ? tadj : gadj;
        loff = malloc(((size_t)n + 1) * sizeof(int64_t));
        ladj = malloc((size_t)(o[n] > 0 ? o[n] : 1) * sizeof(int32_t));
        if (!loff || !ladj) goto done;
        loff[0] = 0;
        for (int32_t r = 0; r < n; r++) {
            int32_t u = order[r];
            int64_t w = loff[r];
            for (int64_t p = o[u]; p < o[u + 1]; p++)
                if (a[p] != u) ladj[w++] = rank[a[p]];
            loff[r + 1] = w;
        }
    }
    free(goff), goff = NULL, free(gadj), gadj = NULL;

    size_t fsz = (size_t)n * sizeof(float);
    S.x = malloc(fsz), S.y = malloc(fsz), S.nx = malloc(fsz), S.ny = malloc(fsz);
    S.sx = malloc(fsz), S.sy = malloc(fsz);
    S.sid = malloc((size_t)n * sizeof(int32_t));
    S.cell_of = malloc((size_t)n * sizeof(int32_t));
    S.slot = malloc((size_t)n * sizeof(int32_t));
    S.part = malloc((size_t)(4 * ((n + CHUNK - 1) / CHUNK + 1)) * sizeof(float));
    if (!S.x || !S.y || !S.nx || !S.ny || !S.sx || !S.sy || !S.sid || !S.cell_of || !S.slot || !S.part) goto done;
    S.off = loff, S.adj = ladj, S.seed = mix64(seed);
    if (npin > 0) {
        fixed = calloc((size_t)n, 1);
        if (!fixed) goto done;
        for (int32_t r = 0; r < npin; r++) fixed[r] = 1;
        S.fixed = fixed;
    }

    pool_t pool;
    if (pool_init(&pool, nthreads) != 0) goto done;

    /* pins where they belong; roots: the first at the origin (or the pins'
     * centre), others spread over a disc of radius sqrt(n) (lglayout lays
     * components out separately) */
    double ox = 0, oy = 0;
    for (int32_t r = 0; r < npin; r++) {
        S.x[r] = (float)pin_xy[2 * (size_t)order[r]], S.y[r] = (float)pin_xy[2 * (size_t)order[r] + 1];
        ox += S.x[r] / npin, oy += S.y[r] / npin;
    }
    for (int32_t c = 0; c < ncomp; c++) {
        double ang = 2 * M_PI * hash_unif(S.seed, 0x1000000000ull + c);
        double rad = c || npin ? sqrt((double)n) * sqrt(hash_unif(S.seed, 0x2000000000ull + c)) : 0;
        S.x[npin + c] = (float)(ox + rad * cos(ang)), S.y[npin + c] = (float)(oy + rad * sin(ang));
    }
    /* has_kids[rank]: the node has children in the tree (for leaves_close 2) */
    uint8_t *has_kids = calloc((size_t)n, 1);
    if (!has_kids) {
        pool_free(&pool);
        goto done;
    }
    for (int32_t r = 0; r < n; r++)
        if (tpar[order[r]] >= 0) has_kids[rank[tpar[order[r]]]] = 1;
    const int prof = getenv("NETMAP_LGL_PROFILE") != NULL;
    long iters = 0;
    for (int32_t l = 1; l < nlayers; l++) {
        const int32_t lstart = layer_end[l - 1], lend = layer_end[l];
        /* centre of mass of everything placed */
        double cmx = 0, cmy = 0;
        for (int32_t r = 0; r < lstart; r++) cmx += S.x[r], cmy += S.y[r];
        cmx /= lstart, cmy /= lstart;
        for (int32_t r = lstart; r < lend;) {
            const int32_t pu = tpar[order[r]], pr = rank[pu];
            int32_t r1 = r;
            while (r1 < lend && tpar[order[r1]] == pu) r1++;
            const int32_t k = r1 - r;
            double spx = S.x[pr], spy = S.y[pr], rad = 1.0;
            if (l > 1 || npin > 0) {
                double d1x = (S.x[pr] - cmx), d1y = (S.y[pr] - cmy);
                double m1 = sqrt(d1x * d1x + d1y * d1y);
                double dx = d1x * m1, dy = d1y * m1;
                const int32_t gp = tpar[pu];
                if (gp < 0 && npin > 0) {
                    /* a pin or root: away from its placed neighbours, which
                     * say where the rest of its network is */
                    double mx = 0, my = 0;
                    int64_t cnt = 0;
                    for (int64_t p = loff[pr]; p < loff[pr + 1]; p++)
                        if (ladj[p] < lstart) mx += S.x[ladj[p]], my += S.y[ladj[p]], cnt++;
                    dx = cnt ? S.x[pr] - mx / cnt : 0, dy = cnt ? S.y[pr] - my / cnt : 0;
                    if (dx * dx + dy * dy < 1e-12) {
                        double ang = 2 * M_PI * hash_unif(S.seed, 0x3000000000ull + (uint64_t)pr);
                        dx = cos(ang), dy = sin(ang);
                    }
                }
                if (gp >= 0) {
                    double d2x = S.x[pr] - S.x[rank[gp]], d2y = S.y[pr] - S.y[rank[gp]];
                    double m2 = sqrt(d2x * d2x + d2y * d2y);
                    if (npin > 0) /* the centre of the world says nothing locally */
                        dx = d2x, dy = d2y;
                    else if (m2 > 0)
                        dx = 0.5 * (dx + d2x * m2), dy = 0.5 * (dy + d2y * m2);
                }
                double m = sqrt(dx * dx + dy * dy);
                double scalef = fmin(0.25 * sqrt((double)k), 10.0);
                if (leaves_close == 1) scalef = 0.0; /* lglayout -L: every family */
                if (leaves_close == 2) {             /* only families of leaves */
                    int leaves = 1;
                    for (int32_t q = r; q < r1 && leaves; q++) leaves = !has_kids[q];
                    if (leaves) scalef = 0.0;
                }
                if (m > 0) spx += dx * scalef / m, spy += dy * scalef / m;
                rad = PLACE_RADIUS;
            }
            for (int32_t q = r; q < r1; q++) {
                double ang = 2 * M_PI * hash_unif(S.seed, (uint64_t)q);
                S.x[q] = (float)(spx + rad * cos(ang));
                S.y[q] = (float)(spy + rad * sin(ang));
            }
            r = r1;
        }
        S.m = lend, S.lstart = lstart;
        if ((rc = relax(&S, &pool, CUTOFF, maxiter, &iters))) {
            pool_free(&pool), free(has_kids);
            goto done;
        }
    }
    free(has_kids);
    /* final settle: everything, tighter cutoff (lglayout keeps the last
     * level's edges as the statistic) */
    if (nlayers > 1) {
        S.m = n, S.lstart = layer_end[nlayers - 2];
        if ((rc = relax(&S, &pool, CUTOFF * 0.1, maxiter, &iters))) {
            pool_free(&pool);
            goto done;
        }
    }
    pool_free(&pool);
    if (prof) fprintf(stderr, "lgl-opte: n=%d levels=%d trees=%d iterations=%ld\n", n, nlayers, ncomp, iters);

    for (int32_t r = 0; r < n; r++) {
        xy_out[2 * (size_t)order[r]] = S.x[r];
        xy_out[2 * (size_t)order[r] + 1] = S.y[r];
        if (levels_out) levels_out[order[r]] = level[order[r]];
    }
    rc = OPTE_OK;

done:
    free(goff), free(gadj), free(toff), free(tadj), free(loff), free(ladj);
    free(uf), free(ts), free(td), free(order), free(rank), free(tpar), free(level);
    free(layer_end), free(comp_root), free(sub), free(dist), free(we), free(fixed);
    free(S.x), free(S.y), free(S.nx), free(S.ny), free(S.sx), free(S.sy);
    free(S.sid), free(S.cell_of), free(S.slot), free(S.cstart), free(S.part);
    return rc;
}
