"""Raster XYZ tiles (Web Mercator, 256px) for any of the three layouts.

The output is a standard ``{z}/{x}/{y}.png`` (or ``.webp``) pyramid with a transparent
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
LINK_INK = 0.004  # mercator length (~160 km at the equator) at full brightness
PAD = 2.0


class Scene:
    """Mercator coordinates, colours and weights for one mode of a bundle."""

    def __init__(self, bundle: Path, mode: str, backbone_only: bool = False, pops: bool = True,
                 gain0: float | None = None):
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
        if backbone_only and "edge_backbone" in a:
            keep &= a["edge_backbone"].astype(bool)
        e = e[keep]
        self.es, self.ed = e[:, 0], e[:, 1]
        self.ecol = 0.5 * (self.ncol[self.es] + self.ncol[self.ed])
        # Transit (p2c) edges slightly brighter than peering.
        rel = a["edge_rel"][keep]
        self.ew = np.where(rel == -1, 1.0, 0.7)
        self.ex0, self.ey0 = self.x[self.es], self.y[self.es]
        self.ex1, self.ey1 = self.x[self.ed], self.y[self.ed]
        # Points drawn as dots: nodes, or for PoP'd ASes their PoPs.
        pt_node = np.flatnonzero(visible)
        ptx, pty = self.x[pt_node], self.y[pt_node]
        route_w = np.empty(0)
        use_pops = pops and mode != "cyber" and "edge_pop" in a and len(a["pop_node"])
        if use_pops:
            pop_pos = a["pop_pos"].astype(np.float64)
            qx, qy = (np.asarray(v) for v in lonlat_to_merc(pop_pos[:, 0], pop_pos[:, 1]))
            ep = a["edge_pop"].astype(np.int64)[keep]
            for side, (xs, ys) in enumerate(((self.ex0, self.ey0), (self.ex1, self.ey1))):
                m = ep[:, side] >= 0
                xs[m], ys[m] = qx[ep[m, side]], qy[ep[m, side]]
            # Core routes between each AS's PoPs, drawn brighter.
            r = a["pop_routes"].astype(np.int64)
            owner = a["pop_node"].astype(np.int64)
            self.ex0 = np.concatenate([self.ex0, qx[r[:, 0]]])
            self.ey0 = np.concatenate([self.ey0, qy[r[:, 0]]])
            self.ex1 = np.concatenate([self.ex1, qx[r[:, 1]]])
            self.ey1 = np.concatenate([self.ey1, qy[r[:, 1]]])
            self.ecol = np.concatenate([self.ecol, self.ncol[owner[r[:, 0]]]])
            route_w = np.full(len(r), 4.0)
            has_pops = np.diff(a["pop_offset"].astype(np.int64)) > 0
            keep_pt = ~has_pops[pt_node]
            pt_node = np.concatenate([pt_node[keep_pt], owner])
            ptx = np.concatenate([ptx[keep_pt], qx])
            pty = np.concatenate([pty[keep_pt], qy])
        self.ew = np.concatenate([self.ew, route_w])
        self.ptx, self.pty = ptx, pty
        self.ptcol = self.ncol[pt_node]
        self.ptw = self.nweight[pt_node]
        # Fixed "ink" per link: long-haul lines are dimmer per pixel, so the
        # world view isn't a white-out of trans-oceanic links (matches viewer).
        length = np.hypot(self.ex1 - self.ex0, self.ey1 - self.ey0)
        self.ew = self.ew * np.minimum(1.0, (LINK_INK / np.maximum(length, 1e-7)) ** 0.6)
        self.bx0 = np.minimum(self.ex0, self.ex1)
        self.bx1 = np.maximum(self.ex0, self.ex1)
        self.by0 = np.minimum(self.ey0, self.ey1)
        self.by1 = np.maximum(self.ey0, self.ey1)
        self.gain0 = 1.0
        self.gain0 = self._calibrate() if gain0 is None else gain0

    def _calibrate(self, target=1.3, q=0.97):
        """Gain so the q-quantile of lit z0 pixels reaches 1-exp(-target)."""
        st = {"max_samples": 3_000_000}
        acc = render(self, 0, 0, 0, style={**st, "raw": True})
        d = acc.max(axis=0)
        lit = d[d > 0]
        return float(target / np.quantile(lit, q)) if lit.size else 1.0

    def edges_in(self, z, tx, ty, subset=None):
        s = 1.0 / (1 << z)
        pad = PAD / TILE * s
        x0, y0 = tx * s - pad, ty * s - pad
        x1, y1 = x0 + s + 2 * pad, y0 + s + 2 * pad
        idx = np.arange(len(self.ex0)) if subset is None else subset
        m = (self.bx1[idx] >= x0) & (self.bx0[idx] <= x1) & (self.by1[idx] >= y0) & (self.by0[idx] <= y1)
        return idx[m]

    def nodes_in(self, z, tx, ty):
        s = 1.0 / (1 << z)
        pad = 4.0 / TILE * s
        m = (
            (self.ptx >= tx * s - pad) & (self.ptx <= (tx + 1) * s + pad)
            & (self.pty >= ty * s - pad) & (self.pty <= (ty + 1) * s + pad)
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
    st = {"edge_gain": scene.gain0, "node_gain": 0.9, "spacing": 0.75, "max_samples": 12_000_000}
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
        # Jittered (stratified) samples: thinned long edges then read as
        # smooth haze instead of moire. Seeded per tile, so output is stable.
        rng = np.random.default_rng((z << 48) ^ (tx << 24) ^ ty)
        t = (np.arange(len(rep)) - starts + rng.random(len(rep))) / ns[rep]
        px = x0[rep] + t * (x1 - x0)[rep]
        py = y0[rep] + t * (y1 - y0)[rep]
        # Per-sample weight: edge intensity times pixel length per sample.
        wlen = (length / ns)[rep] * scene.ew[sel][rep]
        _splat(acc, px, py, scene.ecol[sel][rep] * wlen[:, None])

    if st.get("raw"):
        return acc
    # Per-pixel density of long edges halves with each zoom level; raise the
    # gain a bit less than 2x per level so busy hubs don't saturate deep in.
    gain = st["edge_gain"] * (1.7 ** min(z, 12))
    img = 1.0 - np.exp(-gain * acc)

    nidx = scene.nodes_in(z, tx, ty)
    if len(nidx):
        nacc = np.zeros_like(acc)
        px = scene.ptx[nidx] * scale - tx * TILE
        py = scene.pty[nidx] * scale - ty * TILE
        w = scene.ptw[nidx] * (0.35 + 0.15 * min(z, 8))
        _splat(nacc, px, py, scene.ptcol[nidx] * w[:, None] * 0.8 + 0.2 * w[:, None])
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


FORMATS = {"png": "image/png", "webp": "image/webp"}


def encode(rgba: np.ndarray, fmt: str = "png") -> bytes:
    """PNG (lossless) or WebP (lossy q80 with alpha: ~3x smaller, keeps the
    glow gradients that palette PNGs band badly)."""
    buf = io.BytesIO()
    im = Image.fromarray(rgba, "RGBA")
    if fmt == "webp":
        im.save(buf, "WEBP", quality=80, method=4)
    else:
        im.save(buf, "PNG", optimize=False, compress_level=6)
    return buf.getvalue()


def png_bytes(rgba: np.ndarray) -> bytes:
    return encode(rgba, "png")


def _write_tile(scene, base, z, tx, ty, fmt, edges=None) -> int:
    rgba = render(scene, z, tx, ty, edges=edges)
    if not rgba[..., 3].any():
        return 0
    p = base / str(z) / str(tx) / f"{ty}.{fmt}"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(encode(rgba, fmt))
    return 1


def _visit(scene, base, fmt, z, tx, ty, subset, minzoom, maxzoom, stop_at=None, found=None) -> int:
    """Render the subtree under (z, tx, ty); with ``stop_at``, collect the
    non-empty tiles at that zoom into ``found`` instead of descending."""
    idx = scene.edges_in(z, tx, ty, subset)
    if len(idx) == 0 and len(scene.nodes_in(z, tx, ty)) == 0:
        return 0
    if stop_at is not None and z == stop_at:
        found.append((z, tx, ty))
        return 0
    count = _write_tile(scene, base, z, tx, ty, fmt, idx) if z >= minzoom else 0
    if z < maxzoom:
        for dx in (0, 1):
            for dy in (0, 1):
                count += _visit(scene, base, fmt, z + 1, tx * 2 + dx, ty * 2 + dy, idx,
                                minzoom, maxzoom, stop_at, found)
    return count


# Worker state: the scene is inherited (fork) or rebuilt once per process (spawn).
_W: dict = {}


def _worker_init(args):
    bundle, mode, backbone_only, pops, gain0, base, fmt, minzoom, maxzoom, scene = args
    if scene is None:
        scene = Scene(bundle, mode, backbone_only=backbone_only, pops=pops, gain0=gain0)
    _W.update(scene=scene, base=base, fmt=fmt, minzoom=minzoom, maxzoom=maxzoom)


def _worker_task(task):
    kind, z, tx, ty = task
    sc = _W["scene"]
    if kind == "tile":
        return _write_tile(sc, _W["base"], z, tx, ty, _W["fmt"])
    return _visit(sc, _W["base"], _W["fmt"], z, tx, ty, None, _W["minzoom"], _W["maxzoom"])


def pyramid(bundle: Path, out: Path, mode: str, maxzoom: int, minzoom: int = 0,
            backbone_only: bool = False, fmt: str = "png", workers: int | None = None):
    """Pre-render all non-empty tiles from minzoom..maxzoom on all cores.

    Tiles above a split zoom are rendered as individual tasks (they are the
    heaviest: z0 holds every link); each tile at the split zoom is a task for
    its whole subtree. Output is identical to a single-process run (gain is
    calibrated once here; tile sampling noise is seeded per tile).
    """
    import multiprocessing as mp

    from .native import cpu_count

    scene = Scene(bundle, mode, backbone_only=backbone_only)
    base = out / ("backbone" if backbone_only else "") / mode
    t0 = time.time()
    workers = workers or cpu_count()
    if workers <= 1:
        count = _visit(scene, base, fmt, 0, 0, 0, None, minzoom, maxzoom)
    else:
        # Enough subtree tasks to keep every worker busy, tiles above as singles.
        split = min(maxzoom, max(1, int(math.ceil(math.log(8 * workers, 4)))))
        roots: list = []
        _visit(scene, base, fmt, 0, 0, 0, None, minzoom, maxzoom, stop_at=split, found=roots)
        tasks = []
        for z in range(minzoom, split):
            n = 1 << z
            tasks += [("tile", z, x, y) for x in range(n) for y in range(n)
                      if len(scene.edges_in(z, x, y)) or len(scene.nodes_in(z, x, y))]
        tasks += [("tree", z, x, y) for z, x, y in roots]
        method = "fork" if sys.platform.startswith("linux") else "spawn"
        ctx = mp.get_context(method)
        _W.clear()
        init = (bundle, mode, backbone_only, True, scene.gain0, base, fmt, minzoom, maxzoom,
                scene if method == "fork" else None)
        if method == "fork":
            _worker_init(init)  # children inherit the scene copy-on-write
            init = init[:-1] + (_W["scene"],)
        with ctx.Pool(workers, initializer=_worker_init, initargs=(init,)) as pool:
            count = sum(pool.imap_unordered(_worker_task, tasks, chunksize=1))
    base.mkdir(parents=True, exist_ok=True)
    (base / "tiles.json").write_text(json.dumps({
        "tilejson": "3.0.0", "name": f"netmap {mode}", "tiles": [f"{{z}}/{{x}}/{{y}}.{fmt}"],
        "format": fmt, "minzoom": minzoom, "maxzoom": maxzoom, "count": count,
        "attribution": "; ".join(scene.meta.get("attribution", [])),
    }, indent=1))
    print(f"  {count} {mode} tiles z{minzoom}-{maxzoom} in {time.time() - t0:.0f}s "
          f"({workers} worker{'s' if workers > 1 else ''})", file=sys.stderr)
    return count


def serve(bundle: Path, cache: Path, port: int = 8765, maxzoom: int = 14):
    """On-demand tile server: /<mode>/<z>/<x>/<y>.(png|webp), rendered and cached."""
    lock = threading.Lock()

    @lru_cache(maxsize=3)
    def scene_for(mode):
        return Scene(bundle, mode)

    blank = np.zeros((TILE, TILE, 4), np.uint8)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            parts = self.path.split("?")[0].strip("/").split("/")
            try:
                mode, z, x = parts[-4], int(parts[-3]), int(parts[-2])
                y_s, _, fmt = parts[-1].partition(".")
                y, fmt = int(y_s), fmt or "png"
                assert fmt in FORMATS
                assert mode in ("cyber", "geo", "hybrid") and 0 <= z <= maxzoom
                assert 0 <= x < (1 << z) and 0 <= y < (1 << z)
            except Exception:
                self.send_error(404)
                return
            p = cache / mode / str(z) / str(x) / f"{y}.{fmt}"
            if p.exists():
                body = p.read_bytes()
            else:
                with lock:
                    sc = scene_for(mode)
                rgba = render(sc, z, x, y)
                body = encode(rgba if rgba[..., 3].any() else blank, fmt)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(body)
            self.send_response(200)
            self.send_header("Content-Type", FORMATS[fmt])
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    print(f"tile server on http://localhost:{port}/<mode>/<z>/<x>/<y>.png", file=sys.stderr)
    ThreadingHTTPServer(("", port), H).serve_forever()
