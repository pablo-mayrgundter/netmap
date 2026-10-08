"""Raster XYZ tiles (Web Mercator, 256px) for any of the three layouts.

The output is a standard ``{z}/{x}/{y}.png`` pyramid with a transparent
background, so it drops onto OSM, Google (ImageMapType), Bing (TileLayer),
Leaflet, MapLibre or OpenLayers unchanged, or onto plain black for the
classic look.

Rendering is a small numpy "splatting" rasteriser rather than a vector
library: every edge is clipped to the tile and sampled along its length into
a floating-point RGB accumulator, which is then tone mapped with
``1 - exp(-gain * density)``. That gives the additive, HDR-ish glow of the
Opte maps (dense bundles blow out towards white) and is fast enough to render
deep-zoom tiles on demand.
"""

from __future__ import annotations

import io
import json
import math
import sys
import threading
import time
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

from .export import read_bundle
from .layout import lonlat_to_merc

TILE = 256
PAD = 2.0


class Scene:
    """Mercator coordinates, colours and weights for one mode of a bundle."""

    def __init__(self, bundle: Path, mode: str):
        meta, a = read_bundle(bundle)
        self.meta = meta
        self.mode = mode
        pos = a[f"pos_{mode}"].astype(np.float64)
        x, y = lonlat_to_merc(pos[:, 0], pos[:, 1])
        self.x, self.y = np.asarray(x), np.asarray(y)
        n = len(self.x)
        flags = a["flags"]
        visible = np.ones(n, bool) if mode != "geo" else (flags & 1).astype(bool)
        palette = np.array([r["rgb"] for r in meta["regions"]], np.float64) / 255.0
        self.ncol = palette[a["region"].astype(np.int64)]
        deg = a["degree"].astype(np.float64)
        self.nweight = np.log2(deg + 1)
        self.nvis = visible
        e = a["edges"].astype(np.int64)
        keep = visible[e[:, 0]] & visible[e[:, 1]]
        e = e[keep]
        self.es, self.ed = e[:, 0], e[:, 1]
        self.ecol = 0.5 * (self.ncol[self.es] + self.ncol[self.ed])
        # Transit (p2c) edges slightly brighter than peering.
        rel = a["edge_rel"][keep]
        self.ew = np.where(rel == -1, 1.0, 0.7)
        self.ex0, self.ey0 = self.x[self.es], self.y[self.es]
        self.ex1, self.ey1 = self.x[self.ed], self.y[self.ed]
        self.bx0 = np.minimum(self.ex0, self.ex1)
        self.bx1 = np.maximum(self.ex0, self.ex1)
        self.by0 = np.minimum(self.ey0, self.ey1)
        self.by1 = np.maximum(self.ey0, self.ey1)

    def edges_in(self, z, tx, ty, subset=None):
        s = 1.0 / (1 << z)
        pad = PAD / TILE * s
        x0, y0 = tx * s - pad, ty * s - pad
        x1, y1 = x0 + s + 2 * pad, y0 + s + 2 * pad
        idx = np.arange(len(self.es)) if subset is None else subset
        m = (self.bx1[idx] >= x0) & (self.bx0[idx] <= x1) & (self.by1[idx] >= y0) & (self.by0[idx] <= y1)
        return idx[m]

    def nodes_in(self, z, tx, ty):
        s = 1.0 / (1 << z)
        pad = 4.0 / TILE * s
        m = (
            self.nvis
            & (self.x >= tx * s - pad) & (self.x <= (tx + 1) * s + pad)
            & (self.y >= ty * s - pad) & (self.y <= (ty + 1) * s + pad)
        )
        return np.flatnonzero(m)


def _clip(x0, y0, x1, y1, lo, hi):
    """Liang-Barsky clip of many segments to the square [lo, hi]^2."""
    dx, dy = x1 - x0, y1 - y0
    t0 = np.zeros_like(x0)
    t1 = np.ones_like(x0)
    for p, q in ((-dx, x0 - lo), (dx, hi - x0), (-dy, y0 - lo), (dy, hi - y0)):
        with np.errstate(divide="ignore", invalid="ignore"):
            r = q / p
        par = p == 0
        out = par & (q < 0)
        t0 = np.where(~par & (p < 0), np.maximum(t0, r), t0)
        t1 = np.where(~par & (p > 0), np.minimum(t1, r), t1)
        t1 = np.where(out, -1.0, t1)
    ok = t0 <= t1
    return ok, x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy


def _splat(acc, px, py, w_rgb):
    """Bilinear splat of weighted RGB samples into acc[3, H, W] (C-contiguous)."""
    h, w = acc.shape[1:]
    flat_acc = acc.reshape(3, -1)
    fx, fy = np.floor(px), np.floor(py)
    ax, ay = px - fx, py - fy
    ix, iy = fx.astype(np.int64), fy.astype(np.int64)
    for ox, oy, k in ((0, 0, (1 - ax) * (1 - ay)), (1, 0, ax * (1 - ay)),
                      (0, 1, (1 - ax) * ay), (1, 1, ax * ay)):
        cx, cy = ix + ox, iy + oy
        m = (cx >= 0) & (cx < w) & (cy >= 0) & (cy < h)
        flat = cy[m] * w + cx[m]
        for c in range(3):
            flat_acc[c] += np.bincount(flat, weights=w_rgb[m, c] * k[m], minlength=h * w)


def render(scene: Scene, z: int, tx: int, ty: int, edges=None, style: dict | None = None) -> np.ndarray:
    """Render one tile, returning an RGBA uint8 [256, 256, 4] array."""
    st = {"edge_gain": 0.22, "node_gain": 0.9, "spacing": 0.75, "max_samples": 40_000_000}
    st.update(style or {})
    scale = TILE * (1 << z)
    acc = np.zeros((3, TILE, TILE), np.float64)

    idx = scene.edges_in(z, tx, ty) if edges is None else edges
    if len(idx):
        x0 = scene.ex0[idx] * scale - tx * TILE
        y0 = scene.ey0[idx] * scale - ty * TILE
        x1 = scene.ex1[idx] * scale - tx * TILE
        y1 = scene.ey1[idx] * scale - ty * TILE
        ok, x0, y0, x1, y1 = _clip(x0, y0, x1, y1, -1.0, TILE + 1.0)
        x0, y0, x1, y1, sel = x0[ok], y0[ok], x1[ok], y1[ok], idx[ok]
        length = np.hypot(x1 - x0, y1 - y0)
        ns = np.maximum(np.ceil(length / st["spacing"]).astype(np.int64), 1)
        if ns.sum() > st["max_samples"]:  # pathological tile: thin samples
            ns = np.maximum((ns * st["max_samples"] / ns.sum()).astype(np.int64), 1)
        rep = np.repeat(np.arange(len(ns)), ns)
        starts = np.repeat(np.cumsum(ns) - ns, ns)
        t = (np.arange(len(rep)) - starts + 0.5) / ns[rep]
        px = x0[rep] + t * (x1 - x0)[rep]
        py = y0[rep] + t * (y1 - y0)[rep]
        # Per-sample weight: edge intensity times pixel length per sample.
        wlen = (length / ns)[rep] * scene.ew[sel][rep]
        _splat(acc, px, py, scene.ecol[sel][rep] * wlen[:, None])

    # Zoom-dependent gain: deeper zoom means fewer overlapping edges per px.
    gain = st["edge_gain"] * (1.9 ** min(z, 9))
    img = 1.0 - np.exp(-gain * acc)

    nidx = scene.nodes_in(z, tx, ty)
    if len(nidx):
        nacc = np.zeros_like(acc)
        px = scene.x[nidx] * scale - tx * TILE
        py = scene.y[nidx] * scale - ty * TILE
        w = scene.nweight[nidx] * (0.35 + 0.15 * min(z, 8))
        _splat(nacc, px, py, scene.ncol[nidx] * w[:, None] * 0.6 + 0.4 * w[:, None])
        sigma = 0.6 + 0.12 * min(z, 10)
        for c in range(3):
            nacc[c] = gaussian_filter(nacc[c], sigma) * (2 * math.pi * sigma**2) ** 0.5
        img = 1.0 - (1.0 - img) * np.exp(-st["node_gain"] * nacc)

    img = np.moveaxis(img, 0, -1)
    alpha = img.max(axis=2)
    rgb = np.where(alpha[..., None] > 0, img / np.maximum(alpha[..., None], 1e-9), 0)
    out = np.empty((TILE, TILE, 4), np.uint8)
    out[..., :3] = np.clip(rgb * 255 + 0.5, 0, 255)
    out[..., 3] = np.clip(alpha * 255 + 0.5, 0, 255)
    return out


def png_bytes(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=False, compress_level=6)
    return buf.getvalue()


def pyramid(bundle: Path, out: Path, mode: str, maxzoom: int, minzoom: int = 0):
    """Pre-render all non-empty tiles from minzoom..maxzoom."""
    scene = Scene(bundle, mode)
    base = out / mode
    t0 = time.time()
    count = 0

    def visit(z, tx, ty, subset):
        nonlocal count
        idx = scene.edges_in(z, tx, ty, subset)
        if len(idx) == 0 and len(scene.nodes_in(z, tx, ty)) == 0:
            return
        if z >= minzoom:
            rgba = render(scene, z, tx, ty, edges=idx)
            if rgba[..., 3].any():
                p = base / str(z) / str(tx) / f"{ty}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(png_bytes(rgba))
                count += 1
        if z < maxzoom:
            for dx in (0, 1):
                for dy in (0, 1):
                    visit(z + 1, tx * 2 + dx, ty * 2 + dy, idx)

    visit(0, 0, 0, None)
    base.mkdir(parents=True, exist_ok=True)
    (base / "tiles.json").write_text(json.dumps({
        "tilejson": "3.0.0", "name": f"netmap {mode}", "tiles": ["{z}/{x}/{y}.png"],
        "minzoom": minzoom, "maxzoom": maxzoom, "count": count,
        "attribution": "; ".join(scene.meta.get("attribution", [])),
    }, indent=1))
    print(f"  {count} {mode} tiles z{minzoom}-{maxzoom} in {time.time() - t0:.0f}s", file=sys.stderr)
    return count


def serve(bundle: Path, cache: Path, port: int = 8765, maxzoom: int = 14):
    """On-demand tile server: /<mode>/<z>/<x>/<y>.png, rendered and cached."""
    lock = threading.Lock()

    @lru_cache(maxsize=3)
    def scene_for(mode):
        return Scene(bundle, mode)

    empty = png_bytes(np.zeros((TILE, TILE, 4), np.uint8))

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            parts = self.path.split("?")[0].strip("/").split("/")
            try:
                mode, z, x, y = parts[-4], int(parts[-3]), int(parts[-2]), int(parts[-1].split(".")[0])
                assert mode in ("cyber", "geo", "hybrid") and 0 <= z <= maxzoom
                assert 0 <= x < (1 << z) and 0 <= y < (1 << z)
            except Exception:
                self.send_error(404)
                return
            p = cache / mode / str(z) / str(x) / f"{y}.png"
            if p.exists():
                body = p.read_bytes()
            else:
                with lock:
                    sc = scene_for(mode)
                rgba = render(sc, z, x, y)
                body = png_bytes(rgba) if rgba[..., 3].any() else empty
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(body)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    print(f"tile server on http://localhost:{port}/<mode>/<z>/<x>/<y>.png", file=sys.stderr)
    ThreadingHTTPServer(("", port), H).serve_forever()
