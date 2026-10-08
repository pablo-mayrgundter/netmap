"""Write the web bundle consumed by the viewer (and by the tile renderer).

Layout of ``<out>/``::

    meta.json        counts, palette, provenance, and the section table of graph.bin
    graph.bin        packed little-endian typed arrays (see SECTIONS)
    names.json       AS name per node index (for search and tooltips)
    info/<k>.json    detail records for node indices [k*1024, (k+1)*1024)
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import numpy as np

from .regions import PALETTE, REGION_NAMES, REGIONS

INFO_CHUNK = 1024
FORMAT_VERSION = 1


def write_bundle(out: Path, *, name: str, topo, metrics, prof_rows, layouts, region_idx,
                 has_geo, pinned, names, info_records, attribution: list[str],
                 backbone=None, sample_rank=None):
    out.mkdir(parents=True, exist_ok=True)
    n, e = topo.n, topo.e
    flags = has_geo.astype(np.uint8) | (pinned.astype(np.uint8) << 1)

    def lonlat(pair):
        return np.stack(pair, 1).astype(np.float32).ravel()

    sections = [
        ("asn", topo.asns.astype(np.uint32), [n]),
        ("pos_cyber", lonlat(layouts["cyber"]), [n, 2]),
        ("pos_geo", lonlat(layouts["geo"]), [n, 2]),
        ("pos_hybrid", lonlat(layouts["hybrid"]), [n, 2]),
        ("level", metrics.level.astype(np.float32), [n]),
        ("degree", metrics.degree.astype(np.uint32), [n]),
        ("cone", metrics.cone.astype(np.uint32), [n]),
        ("region", region_idx.astype(np.uint8), [n]),
        ("flags", flags, [n]),
        ("edges", np.stack([topo.src, topo.dst], 1).astype(np.uint32).ravel(), [e, 2]),
        ("edge_rel", topo.rel.astype(np.int8), [e]),
        ("edge_rank", (np.zeros(e) if sample_rank is None else sample_rank).astype(np.uint8), [e]),
        ("edge_backbone", (np.ones(e, bool) if backbone is None else backbone).astype(np.uint8), [e]),
    ]
    table = {}
    off = 0
    with open(out / "graph.bin", "wb") as f:
        for key, arr, shape in sections:
            arr = np.ascontiguousarray(arr)
            pad = (-off) % 8
            f.write(b"\0" * pad)
            off += pad
            b = arr.astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
            f.write(b)
            table[key] = {"dtype": arr.dtype.name, "offset": off, "length": int(arr.size), "shape": shape}
            off += len(b)

    meta = {
        "format": FORMAT_VERSION,
        "name": name,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "synthetic": bool(topo.synthetic),
        "source": topo.source,
        "notes": topo.notes,
        "counts": {
            "nodes": n, "edges": e,
            "p2c": int((topo.rel == -1).sum()), "p2p": int((topo.rel == 0).sum()),
            "geolocated": int(has_geo.sum()), "pinned": int(pinned.sum()),
            "backbone": int(e if backbone is None else np.asarray(backbone).sum()),
        },
        "modes": ["cyber", "geo", "hybrid"],
        "regions": [{"id": r, "name": REGION_NAMES[r], "rgb": PALETTE[r]} for r in REGIONS],
        "info_chunk": INFO_CHUNK,
        "sections": table,
        "attribution": attribution,
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    (out / "names.json").write_text(json.dumps(names, separators=(",", ":")))
    info_dir = out / "info"
    info_dir.mkdir(exist_ok=True)
    for k in range(0, n, INFO_CHUNK):
        chunk = info_records[k : k + INFO_CHUNK]
        (info_dir / f"{k // INFO_CHUNK}.json").write_text(
            json.dumps(chunk, separators=(",", ":"))
        )
    return meta


def read_bundle(path: Path):
    """Load graph.bin back as numpy arrays (used by the tile renderer)."""
    meta = json.loads((path / "meta.json").read_text())
    raw = (path / "graph.bin").read_bytes()
    arrs = {}
    for key, s in meta["sections"].items():
        dt_ = np.dtype(s["dtype"]).newbyteorder("<")
        a = np.frombuffer(raw, dtype=dt_, count=s["length"], offset=s["offset"])
        arrs[key] = a.reshape(s["shape"])
    return meta, arrs
