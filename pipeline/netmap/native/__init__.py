"""Native kernels, compiled on first use with the system C compiler.

No build step at install time: the first call compiles ``lgl.c`` (plain C11
+ pthreads) into a shared library cached under ``$NETMAP_NATIVE_DIR`` or
``~/.cache/netmap``, keyed by a hash of the source and flags, and loads it with
ctypes. If no compiler is available, callers fall back to igraph.

The same source builds for the browser with emscripten, see ``Makefile``.
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SOURCES = [HERE / "lgl.c", HERE / "paths.c", HERE / "splat.c"]
HEADERS = [HERE / "pool.h"]
BASE_FLAGS = ["-O3", "-std=gnu11", "-ffast-math", "-fopenmp-simd", "-fPIC", "-shared", "-pthread"]
ERRORS = {1: "out of memory", 2: "invalid arguments"}

_lib = None
_load_error: str | None = None


class NativeUnavailable(RuntimeError):
    pass


def _cache_dir() -> Path:
    d = os.environ.get("NETMAP_NATIVE_DIR")
    if d:
        return Path(d)
    base = os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")
    return Path(base) / "netmap"


def _compiler() -> str | None:
    for cc in (os.environ.get("CC"), "cc", "clang", "gcc"):
        if cc and shutil.which(cc):
            return cc
    return None


def _try_compile(cc: str, flags: list[str], out: Path) -> bool:
    cmd = [cc, *flags, *map(str, SOURCES), "-o", str(out), "-lm"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode == 0


def load():
    """Compile (once) and load the native library, or raise NativeUnavailable."""
    global _lib, _load_error
    if _lib is not None:
        return _lib
    if _load_error is not None:
        raise NativeUnavailable(_load_error)
    cc = _compiler()
    if cc is None:
        _load_error = "no C compiler found (set CC)"
        raise NativeUnavailable(_load_error)
    src_hash = hashlib.sha256(b"".join(p.read_bytes() for p in SOURCES + HEADERS)).hexdigest()[:16]
    tag = f"{platform.system()}-{platform.machine()}-{src_hash}"
    ext = ".dylib" if sys.platform == "darwin" else ".so"
    lib_path = _cache_dir() / f"libnetmap-{tag}{ext}"
    if not lib_path.exists():
        lib_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=lib_path.parent) as tmp:
            tmp_out = Path(tmp) / lib_path.name
            # Prefer native tuning (AVX2/AVX-512, Apple M-series NEON); fall
            # back to portable flags if the compiler rejects them.
            for extra in (["-march=native"], ["-mcpu=native"], []):
                if _try_compile(cc, BASE_FLAGS + extra, tmp_out):
                    break
            else:
                _load_error = f"compiling {', '.join(p.name for p in SOURCES)} with {cc} failed"
                raise NativeUnavailable(_load_error)
            os.replace(tmp_out, lib_path)
    lib = ctypes.CDLL(str(lib_path))
    lib.netmap_lgl.restype = ctypes.c_int
    lib.netmap_lgl.argtypes = [
        ctypes.c_int32, ctypes.c_int64,
        ctypes.POINTER(ctypes.c_int32), ctypes.POINTER(ctypes.c_int32),
        ctypes.c_int32, ctypes.c_int32,
        ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double,
        ctypes.c_uint64, ctypes.c_int32,
        ctypes.POINTER(ctypes.c_double),
    ]
    lib.netmap_sample_rank.restype = ctypes.c_int
    lib.netmap_sample_rank.argtypes = [
        ctypes.c_int32, ctypes.c_int64,
        ctypes.POINTER(ctypes.c_int32), ctypes.POINTER(ctypes.c_int32),
        ctypes.POINTER(ctypes.c_float),
        ctypes.POINTER(ctypes.c_int32), ctypes.c_int32, ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int32),
    ]
    f32p = ctypes.POINTER(ctypes.c_float)
    lib.netmap_splat_lines.restype = None
    lib.netmap_splat_lines.argtypes = [
        ctypes.c_int64, f32p, f32p, f32p, f32p, f32p,
        ctypes.c_float, ctypes.c_int64, ctypes.c_uint64, ctypes.c_int32, ctypes.c_int32, f32p,
    ]
    _lib = lib
    return lib


def cpu_count() -> int:
    """Cores this process may run on (respects affinity/cgroup cpusets);
    ``NETMAP_THREADS`` overrides."""
    env = int(os.environ.get("NETMAP_THREADS", 0) or 0)
    if env > 0:
        return env
    if hasattr(os, "process_cpu_count"):  # 3.13+
        return os.process_cpu_count() or 1
    if hasattr(os, "sched_getaffinity"):
        return len(os.sched_getaffinity(0)) or 1
    return os.cpu_count() or 1


def lgl(n: int, src, dst, root: int = 0, maxiter: int = 150, maxdelta: float = 0,
        area: float = 0, coolexp: float = 1.5, cellsize: float = 0, seed: int = 1,
        threads: int | None = None) -> np.ndarray:
    """Parallel LGL layout; returns float64 [n, 2]. Zero means igraph's default."""
    lib = load()
    s = np.ascontiguousarray(src, dtype=np.int32)
    d = np.ascontiguousarray(dst, dtype=np.int32)
    out = np.empty((n, 2), dtype=np.float64)
    threads = threads or cpu_count()
    i32p = ctypes.POINTER(ctypes.c_int32)
    rc = lib.netmap_lgl(
        n, len(s), s.ctypes.data_as(i32p), d.ctypes.data_as(i32p), root, maxiter,
        maxdelta, area, coolexp, cellsize, seed & (2**64 - 1), threads,
        out.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
    )
    if rc != 0:
        raise RuntimeError(f"netmap_lgl failed: {ERRORS.get(rc, rc)}")
    return out


def sample_rank(n: int, src, dst, roots, weights=None, threads: int | None = None) -> np.ndarray:
    """Index of the first root whose shortest-path tree uses each edge
    (``len(roots)`` if none does). BFS, or Dijkstra with ``weights``."""
    lib = load()
    s = np.ascontiguousarray(src, dtype=np.int32)
    d = np.ascontiguousarray(dst, dtype=np.int32)
    r = np.ascontiguousarray(roots, dtype=np.int32)
    rank = np.full(len(s), len(r), dtype=np.int32)
    w = None if weights is None else np.ascontiguousarray(weights, dtype=np.float32)
    if w is not None and (len(w) != len(s) or not np.isfinite(w).all() or (w < 0).any()):
        raise ValueError("weights must be finite, non-negative, one per edge")
    i32p = ctypes.POINTER(ctypes.c_int32)
    rc = lib.netmap_sample_rank(
        n, len(s), s.ctypes.data_as(i32p), d.ctypes.data_as(i32p),
        None if w is None else w.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
        r.ctypes.data_as(i32p), len(r), threads or cpu_count(), rank.ctypes.data_as(i32p),
    )
    if rc != 0:
        raise RuntimeError(f"netmap_sample_rank failed: {ERRORS.get(rc, rc)}")
    return rank


def available() -> bool:
    try:
        load()
        return True
    except NativeUnavailable:
        return False


def splat_lines(x0, y0, x1, y1, rgbw, acc, spacing: float, max_samples: int, seed: int) -> None:
    """Accumulate jittered, bilinear line samples into acc (float32 [3, h, w])."""
    lib = load()
    f32p = ctypes.POINTER(ctypes.c_float)
    arrs = [np.ascontiguousarray(a, dtype=np.float32) for a in (x0, y0, x1, y1)]
    c = np.ascontiguousarray(rgbw, dtype=np.float32)
    assert acc.dtype == np.float32 and acc.flags.c_contiguous and acc.ndim == 3
    lib.netmap_splat_lines(
        len(arrs[0]), *(a.ctypes.data_as(f32p) for a in arrs), c.ctypes.data_as(f32p),
        spacing, int(max_samples), seed & (2**64 - 1), acc.shape[2], acc.shape[1],
        acc.ctypes.data_as(f32p),
    )
