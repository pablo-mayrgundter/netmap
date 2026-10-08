/*
 * Traceroute-style link sampling: shortest-path trees from many vantage
 * nodes, in parallel.
 *
 * For each root k (in the given order) the shortest-path tree to every other
 * node is what traceroutes from there would reveal. A link's rank is the
 * smallest k whose tree uses it; links no tree uses keep the caller's initial
 * value. Trees are unweighted BFS, or Dijkstra when weights are given (e.g.
 * to prefer transit links, or real latencies).
 *
 * Roots are independent, so they're spread over the thread pool; each tree
 * lowers ranks with an atomic min, so the result is deterministic whatever
 * the thread count or schedule. Parent choice is deterministic too: the first
 * edge (in input order) that reaches a node at its final distance.
 */

#include <float.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "pool.h"

typedef struct {
    int32_t n;
    const int64_t *off;
    const int32_t *adj;  /* neighbour */
    const int32_t *aeid; /* edge id of that adjacency */
    const float *w;      /* per-edge weight or NULL */
    const int32_t *roots;
    _Atomic int32_t *rank;
    atomic_int failed;
} sp_t;

static void atomic_min32(_Atomic int32_t *a, int32_t v) {
    int32_t cur = atomic_load_explicit(a, memory_order_relaxed);
    while (v < cur && !atomic_compare_exchange_weak_explicit(a, &cur, v, memory_order_relaxed,
                                                             memory_order_relaxed)) {
    }
}

/* binary min-heap of (dist, node), lazy deletion */
typedef struct {
    float d;
    int32_t v;
} hitem;

static void heap_push(hitem *h, int64_t *size, float d, int32_t v) {
    int64_t i = (*size)++;
    while (i > 0) {
        int64_t p = (i - 1) / 2;
        if (h[p].d <= d) break;
        h[i] = h[p];
        i = p;
    }
    h[i].d = d, h[i].v = v;
}

static hitem heap_pop(hitem *h, int64_t *size) {
    hitem top = h[0], last = h[--(*size)];
    int64_t i = 0;
    for (;;) {
        int64_t c = 2 * i + 1;
        if (c >= *size) break;
        if (c + 1 < *size && h[c + 1].d < h[c].d) c++;
        if (h[c].d >= last.d) break;
        h[i] = h[c];
        i = c;
    }
    h[i] = last;
    return top;
}

static void tree_job(void *ctx, int64_t lo, int64_t hi) {
    sp_t *S = ctx;
    const int32_t n = S->n;
    int32_t *pe = malloc((size_t)n * sizeof(int32_t)); /* parent edge */
    int32_t *queue = S->w ? NULL : malloc((size_t)n * sizeof(int32_t));
    float *dist = S->w ? malloc((size_t)n * sizeof(float)) : NULL;
    hitem *heap = S->w ? malloc((size_t)(S->off[n] + 1) * sizeof(hitem)) : NULL;
    if (!pe || (S->w ? (!dist || !heap) : !queue)) {
        atomic_store(&S->failed, 1);
        goto out;
    }
    for (int64_t k = lo; k < hi; k++) {
        const int32_t root = S->roots[k];
        for (int32_t i = 0; i < n; i++) pe[i] = -2; /* unreached */
        pe[root] = -1;
        if (!S->w) {
            int32_t head = 0, tail = 0;
            queue[tail++] = root;
            while (head < tail) {
                int32_t u = queue[head++];
                for (int64_t p = S->off[u]; p < S->off[u + 1]; p++) {
                    int32_t v = S->adj[p];
                    if (pe[v] == -2) {
                        pe[v] = S->aeid[p];
                        queue[tail++] = v;
                    }
                }
            }
        } else {
            for (int32_t i = 0; i < n; i++) dist[i] = FLT_MAX; /* built with -ffast-math: no inf */
            int64_t hs = 0;
            dist[root] = 0;
            heap_push(heap, &hs, 0, root);
            while (hs > 0) {
                hitem it = heap_pop(heap, &hs);
                if (it.d > dist[it.v]) continue; /* stale */
                for (int64_t p = S->off[it.v]; p < S->off[it.v + 1]; p++) {
                    int32_t v = S->adj[p];
                    float nd = it.d + S->w[S->aeid[p]];
                    if (nd < dist[v]) {
                        dist[v] = nd;
                        pe[v] = S->aeid[p];
                        heap_push(heap, &hs, nd, v);
                    }
                }
            }
        }
        for (int32_t v = 0; v < n; v++)
            if (pe[v] >= 0) atomic_min32(&S->rank[pe[v]], (int32_t)k);
    }
out:
    free(pe), free(queue), free(dist), free(heap);
}

/*
 * rank[e] must be pre-filled (e.g. with nroots for "never sampled"); it is
 * lowered to the index of the first root whose tree uses each edge.
 * weights may be NULL (BFS). Returns 0, 1 (out of memory) or 2 (bad input).
 */
int netmap_sample_rank(int32_t n, int64_t e, const int32_t *src, const int32_t *dst,
                       const float *weights, const int32_t *roots, int32_t nroots,
                       int32_t nthreads, int32_t *rank) {
    if (n <= 0 || nroots < 0) return 2;
    for (int64_t k = 0; k < e; k++)
        if (src[k] < 0 || src[k] >= n || dst[k] < 0 || dst[k] >= n) return 2;
    for (int32_t k = 0; k < nroots; k++)
        if (roots[k] < 0 || roots[k] >= n) return 2;
    if (weights)
        for (int64_t k = 0; k < e; k++)
            if (weights[k] < 0) return 2; /* Dijkstra needs non-negative weights (NaN/inf checked by the caller) */
    if (nthreads <= 0) nthreads = cpu_count_online();

    int rc = 1;
    int64_t *off = calloc((size_t)n + 1, sizeof(int64_t));
    int32_t *adj = NULL, *aeid = NULL;
    if (!off) return 1;
    for (int64_t k = 0; k < e; k++) {
        if (src[k] == dst[k]) continue;
        off[src[k] + 1]++;
        off[dst[k] + 1]++;
    }
    for (int32_t i = 0; i < n; i++) off[i + 1] += off[i];
    adj = malloc((size_t)(off[n] + 1) * sizeof(int32_t));
    aeid = malloc((size_t)(off[n] + 1) * sizeof(int32_t));
    int64_t *cur = malloc(((size_t)n + 1) * sizeof(int64_t));
    if (!adj || !aeid || !cur) goto done;
    memcpy(cur, off, ((size_t)n + 1) * sizeof(int64_t));
    for (int64_t k = 0; k < e; k++) { /* input order = parent tie-break order */
        if (src[k] == dst[k]) continue;
        adj[cur[src[k]]] = dst[k], aeid[cur[src[k]]++] = (int32_t)k;
        adj[cur[dst[k]]] = src[k], aeid[cur[dst[k]]++] = (int32_t)k;
    }

    sp_t S = {.n = n, .off = off, .adj = adj, .aeid = aeid, .w = weights, .roots = roots,
              .rank = (_Atomic int32_t *)rank};
    atomic_init(&S.failed, 0);
    pool_t pool;
    if (pool_init(&pool, nthreads) != 0) goto done;
    pool_run(&pool, tree_job, &S, nroots, 1);
    pool_free(&pool);
    rc = atomic_load(&S.failed) ? 1 : 0;

done:
    free(off), free(adj), free(aeid), free(cur);
    return rc;
}
