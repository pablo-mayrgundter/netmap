/*
 * Parallel Large Graph Layout (LGL).
 *
 * Adai, Date, Wieland & Marcotte, "LGL: creating a map of protein function
 * with an algorithm for visualizing very large biological networks",
 * J. Mol. Biol. 2004. Same scheme as igraph's layout_lgl:
 *
 *   1. BFS from a root gives layers. Layers are added one at a time; each new
 *      node is dropped just outside its BFS parent (away from the root).
 *   2. After each layer, `maxiter` iterations of Fruchterman-Reingold run over
 *      every node placed so far, with repulsion cut off at `cellsize` (grid
 *      neighbourhood only) and a temperature that cools as
 *      maxdelta * ((maxiter - it) / maxiter) ^ coolexp.
 *
 * What's different is how each iteration runs:
 *
 *   - Nodes are relabelled in BFS order, so "placed so far" is the prefix
 *     [0, m) and no indirection is needed.
 *   - Every iteration counting-sorts the placed nodes into grid cells and
 *     gathers their coordinates into cell-ordered float arrays, so the
 *     repulsion inner loop over the 3x3 neighbouring cells is a contiguous,
 *     branch-free, sqrt-free loop the compiler vectorises (AVX2/NEON/wasm
 *     SIMD128). FR repulsion k^2/d along the unit vector is just k^2*dx/d^2.
 *   - Repulsion, attraction and moves run on a small pthread pool with
 *     dynamically claimed chunks (dense hub cells make static splits uneven).
 *     Positions are double-buffered, so there are no races and the result is
 *     the same for any thread count.
 *
 * Plain C11 + pthreads, no other dependencies: builds with cc on Linux and
 * macOS, and with emcc -pthread -msimd128 for the browser.
 */

#include <math.h>
#include <stdio.h>
#include <time.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define LGL_OK 0
#define LGL_ENOMEM 1
#define LGL_EINVAL 2

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

/* ---------------------------------------------------------------- RNG -- */

static uint64_t splitmix64(uint64_t *s) {
    uint64_t z = (*s += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

static double unif(uint64_t *s) { return (double)(splitmix64(s) >> 11) * (1.0 / 9007199254740992.0); }

/* --------------------------------------------------------- thread pool -- */

typedef void (*job_fn)(void *ctx, int64_t lo, int64_t hi);

typedef struct {
    pthread_t *threads;
    int nthreads;
    pthread_mutex_t mu;
    pthread_cond_t start_cv, done_cv;
    uint64_t generation;
    int active; /* workers still running the current job */
    int quit;
    /* current job */
    job_fn fn;
    void *ctx;
    int64_t total, chunk;
    atomic_llong next;
} pool_t;

static void run_chunks(pool_t *p) {
    for (;;) {
        int64_t lo = atomic_fetch_add(&p->next, p->chunk);
        if (lo >= p->total) break;
        int64_t hi = lo + p->chunk < p->total ? lo + p->chunk : p->total;
        p->fn(p->ctx, lo, hi);
    }
}

static void *worker(void *arg) {
    pool_t *p = arg;
    uint64_t seen = 0;
    for (;;) {
        pthread_mutex_lock(&p->mu);
        while (p->generation == seen && !p->quit) pthread_cond_wait(&p->start_cv, &p->mu);
        if (p->quit) {
            pthread_mutex_unlock(&p->mu);
            return NULL;
        }
        seen = p->generation;
        pthread_mutex_unlock(&p->mu);
        run_chunks(p);
        pthread_mutex_lock(&p->mu);
        if (--p->active == 0) pthread_cond_signal(&p->done_cv);
        pthread_mutex_unlock(&p->mu);
    }
}

static int pool_init(pool_t *p, int nthreads) {
    memset(p, 0, sizeof *p);
    p->nthreads = nthreads > 1 ? nthreads - 1 : 0; /* caller thread works too */
    pthread_mutex_init(&p->mu, NULL);
    pthread_cond_init(&p->start_cv, NULL);
    pthread_cond_init(&p->done_cv, NULL);
    if (p->nthreads == 0) return LGL_OK;
    p->threads = calloc((size_t)p->nthreads, sizeof(pthread_t));
    if (!p->threads) return LGL_ENOMEM;
    for (int i = 0; i < p->nthreads; i++) {
        if (pthread_create(&p->threads[i], NULL, worker, p) != 0) {
            p->nthreads = i; /* run with what we got */
            break;
        }
    }
    return LGL_OK;
}

static void pool_run(pool_t *p, job_fn fn, void *ctx, int64_t total, int64_t chunk) {
    if (total <= 0) return;
    if (p->nthreads == 0 || total <= chunk) {
        /* same chunk boundaries as the threaded path */
        for (int64_t lo = 0; lo < total; lo += chunk) fn(ctx, lo, lo + chunk < total ? lo + chunk : total);
        return;
    }
    pthread_mutex_lock(&p->mu);
    p->fn = fn;
    p->ctx = ctx;
    p->total = total;
    p->chunk = chunk;
    atomic_store(&p->next, 0);
    p->active = p->nthreads;
    p->generation++;
    pthread_cond_broadcast(&p->start_cv);
    pthread_mutex_unlock(&p->mu);
    run_chunks(p);
    pthread_mutex_lock(&p->mu);
    while (p->active > 0) pthread_cond_wait(&p->done_cv, &p->mu);
    pthread_mutex_unlock(&p->mu);
}

static void pool_free(pool_t *p) {
    if (p->threads) {
        pthread_mutex_lock(&p->mu);
        p->quit = 1;
        pthread_cond_broadcast(&p->start_cv);
        pthread_mutex_unlock(&p->mu);
        for (int i = 0; i < p->nthreads; i++) pthread_join(p->threads[i], NULL);
        free(p->threads);
    }
    pthread_mutex_destroy(&p->mu);
    pthread_cond_destroy(&p->start_cv);
    pthread_cond_destroy(&p->done_cv);
}

/* ------------------------------------------------------------- layout -- */

typedef struct {
    /* graph, BFS-relabelled CSR */
    int64_t *off;
    int32_t *adj;
    /* positions (double-buffered) and displacement */
    float *x, *y, *nx, *ny;
    float *dx, *dy;
    /* grid, rebuilt per iteration */
    float *sx, *sy;    /* coordinates in cell order */
    int32_t *sid;      /* node id in cell order */
    int32_t *cell_of;  /* cell of each node */
    int32_t *slot;     /* each node's position in cell order */
    float *part_bounds; /* per-chunk min/max partials */
    int32_t *cstart;   /* [ncell + 3]; cell c spans [cstart[c+2], cstart[c+3]) */
    int64_t cap_cells;
    int64_t gw, gh;
    float minx, miny, inv_cs;
    /* parameters for the current iteration */
    int64_t m;      /* nodes placed */
    float k2;       /* frk^2 */
    float inv_k;    /* 1 / frk */
    float cut2;     /* repulsion cutoff^2 */
    float temp;
} lgl_t;

/* Repulsion for sorted slots [lo, hi): contiguous loops over neighbour cells. */
static void repulse_job(void *ctx, int64_t lo, int64_t hi) {
    lgl_t *L = ctx;
    const float *restrict sx = L->sx, *restrict sy = L->sy;
    const float k2 = L->k2, cut2 = L->cut2;
    for (int64_t s = lo; s < hi; s++) {
        const int32_t i = L->sid[s];
        const float xi = sx[s], yi = sy[s];
        const int64_t c = L->cell_of[i];
        const int64_t cx = c % L->gw, cy = c / L->gw;
        float fx = 0.f, fy = 0.f;
        for (int64_t oy = cy - 1; oy <= cy + 1; oy++) {
            if (oy < 0 || oy >= L->gh) continue;
            /* the three cells in this row are adjacent in cell order */
            int64_t c0 = oy * L->gw + (cx > 0 ? cx - 1 : 0);
            int64_t c1 = oy * L->gw + (cx + 1 < L->gw ? cx + 1 : cx);
            int64_t j0 = L->cstart[c0 + 2], j1 = L->cstart[c1 + 3];
#pragma omp simd reduction(+ : fx, fy)
            for (int64_t j = j0; j < j1; j++) {
                float ddx = xi - sx[j];
                float ddy = yi - sy[j];
                float d2 = ddx * ddx + ddy * ddy;
                /* k^2 * d / |d|^2, only inside the cutoff, never self */
                float w = (d2 > 0.f && d2 < cut2) ? k2 / d2 : 0.f;
                fx += ddx * w;
                fy += ddy * w;
            }
        }
        L->dx[i] = fx;
        L->dy[i] = fy;
    }
}

/* Attraction along placed edges, then move (into the other buffer). */
static void attract_move_job(void *ctx, int64_t lo, int64_t hi) {
    lgl_t *L = ctx;
    const float *restrict x = L->x, *restrict y = L->y;
    const float inv_k = L->inv_k, temp = L->temp;
    const int64_t m = L->m;
    for (int64_t i = lo; i < hi; i++) {
        float fx = L->dx[i], fy = L->dy[i];
        const float xi = x[i], yi = y[i];
        for (int64_t p = L->off[i]; p < L->off[i + 1]; p++) {
            int32_t v = L->adj[p];
            if (v >= m) continue; /* not placed yet */
            float ddx = x[v] - xi, ddy = y[v] - yi;
            float d = sqrtf(ddx * ddx + ddy * ddy);
            /* FR attraction d^2/k along the unit vector */
            fx += ddx * d * inv_k;
            fy += ddy * d * inv_k;
        }
        float len = sqrtf(fx * fx + fy * fy);
        if (len > temp) {
            float s = temp / len;
            fx *= s;
            fy *= s;
        }
        L->nx[i] = xi + fx;
        L->ny[i] = yi + fy;
    }
}

/* Grid build helpers: bounds per fixed chunk, cell of each node, scatter. */
#define BOUNDS_CHUNK 8192

static void bounds_job(void *ctx, int64_t lo, int64_t hi) {
    lgl_t *L = ctx;
    float minx = L->x[lo], maxx = minx, miny = L->y[lo], maxy = miny;
    for (int64_t i = lo + 1; i < hi; i++) {
        float a = L->x[i], b = L->y[i];
        minx = a < minx ? a : minx;
        maxx = a > maxx ? a : maxx;
        miny = b < miny ? b : miny;
        maxy = b > maxy ? b : maxy;
    }
    float *pb = L->part_bounds + 4 * (lo / BOUNDS_CHUNK);
    pb[0] = minx, pb[1] = maxx, pb[2] = miny, pb[3] = maxy;
}

static void cell_job(void *ctx, int64_t lo, int64_t hi) {
    lgl_t *L = ctx;
    const float minx = L->minx, miny = L->miny, inv = L->inv_cs;
    const int64_t gw = L->gw, gh = L->gh;
    for (int64_t i = lo; i < hi; i++) {
        int64_t gx = (int64_t)((L->x[i] - minx) * inv);
        int64_t gy = (int64_t)((L->y[i] - miny) * inv);
        if (gx >= gw) gx = gw - 1;
        if (gy >= gh) gy = gh - 1;
        L->cell_of[i] = (int32_t)(gy * gw + gx);
    }
}

static void scatter_job(void *ctx, int64_t lo, int64_t hi) {
    lgl_t *L = ctx;
    for (int64_t i = lo; i < hi; i++) {
        int32_t s = L->slot[i];
        L->sid[s] = (int32_t)i;
        L->sx[s] = L->x[i];
        L->sy[s] = L->y[i];
    }
}

/* Counting-sort the placed nodes into grid cells; returns 0 or LGL_ENOMEM.
 * Within a cell nodes keep increasing id order, whatever the thread count. */
static int build_grid(lgl_t *L, pool_t *pool, float cs) {
    const int64_t m = L->m;
    /* fixed chunk size, so the partials (and the result) don't depend on threads */
    pool_run(pool, bounds_job, L, m, BOUNDS_CHUNK);
    float minx = L->part_bounds[0], maxx = L->part_bounds[1];
    float miny = L->part_bounds[2], maxy = L->part_bounds[3];
    for (int64_t k = 1; k < (m + BOUNDS_CHUNK - 1) / BOUNDS_CHUNK; k++) {
        const float *pb = L->part_bounds + 4 * k;
        minx = pb[0] < minx ? pb[0] : minx;
        maxx = pb[1] > maxx ? pb[1] : maxx;
        miny = pb[2] < miny ? pb[2] : miny;
        maxy = pb[3] > maxy ? pb[3] : maxy;
    }
    /* Keep the grid bounded: if the layout is very spread out, use bigger
     * cells (the cutoff test still applies, there are just more candidates). */
    for (;;) {
        L->gw = (int64_t)((maxx - minx) / cs) + 1;
        L->gh = (int64_t)((maxy - miny) / cs) + 1;
        if (L->gw * L->gh <= 8 * m + 4096) break;
        cs *= 1.5f;
    }
    int64_t ncell = L->gw * L->gh;
    if (ncell + 3 > L->cap_cells) {
        int32_t *c = realloc(L->cstart, (size_t)(ncell + 3) * sizeof(int32_t));
        if (!c) return LGL_ENOMEM;
        L->cstart = c;
        L->cap_cells = ncell + 3;
    }
    L->minx = minx;
    L->miny = miny;
    L->inv_cs = 1.0f / cs;
    pool_run(pool, cell_job, L, m, 4096);

    /* Counts go in cs_[c+2] and are prefix-summed, so cs_[c+2] = end of cell
     * c. Slots are then handed out from the top (i descending keeps id order
     * within a cell), which leaves cs_[c+2] = start of cell c, so no restore
     * pass is needed: cell c spans [cs_[c+2], cs_[c+3]). */
    int32_t *cs_ = L->cstart;
    memset(cs_, 0, (size_t)(ncell + 3) * sizeof(int32_t));
    for (int64_t i = 0; i < m; i++) cs_[L->cell_of[i] + 2]++;
    for (int64_t c = 0; c < ncell; c++) cs_[c + 2] += cs_[c + 1];
    for (int64_t i = m - 1; i >= 0; i--) L->slot[i] = --cs_[L->cell_of[i] + 2];
    cs_[ncell + 2] = (int32_t)m;
    pool_run(pool, scatter_job, L, m, 4096);
    return LGL_OK;
}

/*
 * n nodes, e undirected edges (src[k], dst[k]); every node must be reachable
 * from root (lay out connected components separately). Writes x,y pairs for
 * the original node ids to xy_out[2n].
 *
 * Defaults matching igraph: maxiter 150, maxdelta n, area n^2, coolexp 1.5,
 * cellsize sqrt(sqrt(area)). Pass <= 0 for any of them to get the default.
 */
int netmap_lgl(int32_t n, int64_t e, const int32_t *src, const int32_t *dst, int32_t root,
               int32_t maxiter, double maxdelta, double area, double coolexp, double cellsize,
               uint64_t seed, int32_t nthreads, double *xy_out) {
    if (n <= 0 || root < 0 || root >= n) return LGL_EINVAL;
    if (maxiter <= 0) maxiter = 150;
    if (maxdelta <= 0) maxdelta = n;
    if (area <= 0) area = (double)n * n;
    if (coolexp <= 0) coolexp = 1.5;
    if (cellsize <= 0) cellsize = sqrt(sqrt(area));
    if (nthreads <= 0) nthreads = 1;

    int rc = LGL_ENOMEM;
    lgl_t L;
    memset(&L, 0, sizeof L);
    int64_t *deg = calloc((size_t)n + 1, sizeof(int64_t));
    int64_t *off0 = NULL;
    int32_t *adj0 = NULL, *order = NULL, *rank = NULL, *parent = NULL, *layer_end = NULL;
    if (!deg) goto done;

    /* CSR in original ids */
    for (int64_t k = 0; k < e; k++) {
        if (src[k] < 0 || src[k] >= n || dst[k] < 0 || dst[k] >= n) {
            rc = LGL_EINVAL;
            goto done;
        }
        if (src[k] == dst[k]) continue;
        deg[src[k] + 1]++;
        deg[dst[k] + 1]++;
    }
    for (int32_t i = 0; i < n; i++) deg[i + 1] += deg[i];
    off0 = malloc(((size_t)n + 1) * sizeof(int64_t));
    adj0 = malloc((size_t)(deg[n] > 0 ? deg[n] : 1) * sizeof(int32_t));
    if (!off0 || !adj0) goto done;
    memcpy(off0, deg, ((size_t)n + 1) * sizeof(int64_t));
    for (int64_t k = 0; k < e; k++) {
        if (src[k] == dst[k]) continue;
        adj0[deg[src[k]]++] = dst[k];
        adj0[deg[dst[k]]++] = src[k];
    }

    /* BFS layers from root (unreached nodes become extra layers, rooted at
     * their own first member, so the function never fails on them) */
    order = malloc((size_t)n * sizeof(int32_t));
    rank = malloc((size_t)n * sizeof(int32_t));
    parent = malloc((size_t)n * sizeof(int32_t));
    layer_end = malloc(((size_t)n + 1) * sizeof(int32_t));
    if (!order || !rank || !parent || !layer_end) goto done;
    for (int32_t i = 0; i < n; i++) rank[i] = -1;
    int32_t head = 0, tail = 0, nlayers = 0, next_root = 0;
    order[tail++] = root;
    rank[root] = 0;
    parent[root] = -1;
    while (head < n) {
        int32_t end = tail;
        if (head == end) { /* disconnected: seed the next component */
            while (rank[next_root] >= 0) next_root++;
            order[tail] = next_root;
            rank[next_root] = tail++;
            parent[next_root] = -1;
            end = tail;
        }
        for (; head < end; head++) {
            int32_t u = order[head];
            for (int64_t p = off0[u]; p < off0[u + 1]; p++) {
                int32_t v = adj0[p];
                if (rank[v] < 0) {
                    rank[v] = tail;
                    parent[v] = u;
                    order[tail++] = v;
                }
            }
        }
        layer_end[nlayers++] = end;
    }

    /* relabelled CSR: new id = BFS rank */
    L.off = malloc(((size_t)n + 1) * sizeof(int64_t));
    L.adj = malloc((size_t)(off0[n] > 0 ? off0[n] : 1) * sizeof(int32_t));
    size_t fsz = (size_t)n * sizeof(float);
    L.x = malloc(fsz), L.y = malloc(fsz), L.nx = malloc(fsz), L.ny = malloc(fsz);
    L.dx = malloc(fsz), L.dy = malloc(fsz), L.sx = malloc(fsz), L.sy = malloc(fsz);
    L.sid = malloc((size_t)n * sizeof(int32_t));
    L.cell_of = malloc((size_t)n * sizeof(int32_t));
    L.slot = malloc((size_t)n * sizeof(int32_t));
    L.part_bounds = malloc((size_t)(4 * ((n + BOUNDS_CHUNK - 1) / BOUNDS_CHUNK)) * sizeof(float));
    if (!L.off || !L.adj || !L.x || !L.y || !L.nx || !L.ny || !L.dx || !L.dy || !L.sx || !L.sy ||
        !L.sid || !L.cell_of || !L.slot || !L.part_bounds)
        goto done;
    L.off[0] = 0;
    for (int32_t r = 0; r < n; r++) {
        int32_t u = order[r];
        int64_t o = L.off[r];
        for (int64_t p = off0[u]; p < off0[u + 1]; p++) L.adj[o++] = rank[adj0[p]];
        L.off[r + 1] = o;
    }

    pool_t pool;
    if (pool_init(&pool, nthreads) != LGL_OK) goto done;

    const float frk = (float)sqrt(area / n);
    L.k2 = frk * frk;
    L.inv_k = 1.0f / frk;
    L.cut2 = (float)(cellsize * cellsize);
    uint64_t rng = seed ^ 0x6A09E667F3BCC908ull;

    /* igraph's placement: layer l lands on a circle of radius sconst / l
     * around a point just beyond its parent (nudged along the parent's own
     * outward direction and towards the centre of mass). The big early radii
     * are what stretch the tree into long rays before the springs relax it. */
    double H_n = 0;
    for (int32_t l = 1; l < nlayers; l++) H_n += 1.0 / l;
    const double sconst = sqrt(area / M_PI) / (H_n > 0 ? H_n : 1);

    const int prof = getenv("NETMAP_LGL_PROFILE") != NULL;
    double t_grid = 0, t_rep = 0, t_att = 0;
    long n_iter = 0;
    double cells_sum = 0;
    int32_t placed = 0;
    for (int32_t l = 0; l < nlayers; l++) {
        double massx = 0, massy = 0;
        for (int32_t r = 0; r < placed; r++) massx += L.x[r], massy += L.y[r];
        if (placed) massx /= placed, massy /= placed;
        double ml = sqrt(massx * massx + massy * massy);
        if (ml > 0) massx /= ml, massy /= ml;
        const int32_t lstart = placed;
        for (int32_t r = placed; r < layer_end[l]; r++) {
            int32_t pu = parent[order[r]];
            if (pu < 0) { /* a root: the origin, or beside everything so far */
                double ang = 2 * M_PI * unif(&rng);
                double rad = placed ? sconst * (1 + unif(&rng)) : 0;
                L.x[r] = (float)(massx * rad + cos(ang) * rad * 0.5);
                L.y[r] = (float)(massy * rad + sin(ang) * rad * 0.5);
                continue;
            }
            int32_t pr = rank[pu];
            int32_t gp = parent[pu];
            double px = 0, py = 0;
            if (gp >= 0) {
                px = L.x[pr] - L.x[rank[gp]];
                py = L.y[pr] - L.y[rank[gp]];
                double pl = sqrt(px * px + py * py);
                if (pl > 0) px /= pl, py /= pl;
            }
            double cx = L.x[pr] + massx + px, cy = L.y[pr] + massy + py;
            double rx, ry;
            if (gp < 0 && l == 1) { /* first ring: evenly spaced */
                double phi = 2 * M_PI * (r - lstart) / (double)(layer_end[l] - lstart);
                rx = cos(phi), ry = sin(phi);
            } else {
                double ang = 2 * M_PI * unif(&rng);
                rx = cos(ang), ry = sin(ang);
            }
            L.x[r] = (float)(cx + rx * sconst / l);
            L.y[r] = (float)(cy + ry * sconst / l);
        }
        placed = layer_end[l];
        L.m = placed;
        if (placed < 2) continue;

        for (int32_t it = 0; it < maxiter; it++) {
            L.temp = (float)(maxdelta * pow((double)(maxiter - it) / maxiter, coolexp));
            double t0 = prof ? now_s() : 0;
            if ((rc = build_grid(&L, &pool, (float)cellsize)) != LGL_OK) {
                pool_free(&pool);
                goto done;
            }
            double t1 = prof ? now_s() : 0;
            pool_run(&pool, repulse_job, &L, L.m, 256);
            double t2 = prof ? now_s() : 0;
            pool_run(&pool, attract_move_job, &L, L.m, 1024);
            if (prof) {
                double t3 = now_s();
                t_grid += t1 - t0, t_rep += t2 - t1, t_att += t3 - t2;
                n_iter++;
                cells_sum += (double)L.gw * L.gh;
            }
            float *t;
            t = L.x, L.x = L.nx, L.nx = t;
            t = L.y, L.y = L.ny, L.ny = t;
        }
    }
    pool_free(&pool);
    if (prof)
        fprintf(stderr, "lgl: n=%d layers=%d iterations=%ld cells/iter %.0f grid %.2fs repulse %.2fs attract+move %.2fs\n",
                n, nlayers, n_iter, n_iter ? cells_sum / n_iter : 0, t_grid, t_rep, t_att);

    for (int32_t r = 0; r < n; r++) {
        xy_out[2 * (size_t)order[r]] = L.x[r];
        xy_out[2 * (size_t)order[r] + 1] = L.y[r];
    }
    rc = LGL_OK;

done:
    free(deg), free(off0), free(adj0), free(order), free(rank), free(parent), free(layer_end);
    free(L.off), free(L.adj), free(L.x), free(L.y), free(L.nx), free(L.ny), free(L.dx), free(L.dy);
    free(L.sx), free(L.sy), free(L.sid), free(L.cell_of), free(L.cstart);
    free(L.slot), free(L.part_bounds);
    return rc;
}

/* For bindings that want to check what they loaded. */
int netmap_lgl_abi(void) { return 1; }
