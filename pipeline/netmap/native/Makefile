# Manual builds. Python compiles lgl.c on demand (see __init__.py), so this is
# only for benchmarking, debugging, and the browser build.

CC ?= cc
CFLAGS ?= -O3 -std=gnu11 -ffast-math -fopenmp-simd -march=native -pthread -fPIC

SRC = lgl.c lgl_opte.c paths.c

libnetmap.so: $(SRC) pool.h
	$(CC) $(CFLAGS) -shared $(SRC) -o $@ -lm

# WebAssembly with threads + SIMD (needs COOP/COEP headers when served).
netmap-lgl.mjs: $(SRC) pool.h
	emcc -O3 -std=gnu11 -ffast-math -fopenmp-simd -msimd128 -pthread \
	  -sEXPORTED_FUNCTIONS=_netmap_lgl,_netmap_lgl_opte,_netmap_sample_rank,_netmap_cpu_count,_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPF64,HEAP32 \
	  -sALLOW_MEMORY_GROWTH -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency \
	  -sMODULARIZE -sEXPORT_ES6 $(SRC) -o $@

clean:
	rm -f libnetmap.so netmap-lgl.mjs netmap-lgl.wasm netmap-lgl.worker.js
