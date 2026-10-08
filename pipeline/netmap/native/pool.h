/*
 * Tiny pthread pool shared by the native kernels: the calling thread plus
 * N-1 workers run fn(ctx, lo, hi) over [0, total) in dynamically claimed
 * chunks. Header-only (static functions), C11 + pthreads.
 */
#ifndef NETMAP_POOL_H
#define NETMAP_POOL_H

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Online cores (emscripten maps this to navigator.hardwareConcurrency). */
static int cpu_count_online(void) {
    long c = sysconf(_SC_NPROCESSORS_ONLN);
    return c > 0 ? (int)c : 1;
}

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
    if (p->nthreads == 0) return 0;
    p->threads = calloc((size_t)p->nthreads, sizeof(pthread_t));
    if (!p->threads) return 1; /* out of memory */
    for (int i = 0; i < p->nthreads; i++) {
        if (pthread_create(&p->threads[i], NULL, worker, p) != 0) {
            p->nthreads = i; /* run with what we got */
            break;
        }
    }
    return 0;
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

#endif
