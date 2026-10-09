"""Lookup tables for the viewer, shared by every bundle in the data root.

* ``ip2asn.bin.gz``: IPv4 -> origin AS (RouteViews via ip-location-db), for
  resolving pasted traceroutes in the browser. Boundaries, not ranges: entry
  ``i`` says addresses from ``start[i]`` up to ``start[i+1]`` belong to
  ``asn[i]`` (0 = unrouted). Little-endian::

      b"NMIP" u32 version u32 count  u32 start[count]  u32 asn[count]

* ``iata.json``: airport codes and city names -> [lat, lon, name], for the
  hostname location hints in iata.py (``mci.googlefiber.net`` -> Kansas City).
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np

from .geo import PrefixTable
from .iata import Gazetteer

MAGIC = b"NMIP"
VERSION = 1


def ip2asn_boundaries(pfx: PrefixTable) -> tuple[np.ndarray, np.ndarray]:
    """Sorted range starts and ASNs with gaps as AS 0 and equal neighbours merged."""
    order = np.argsort(pfx.start, kind="stable")
    s = pfx.start[order].astype(np.int64)
    e = pfx.end[order].astype(np.int64)
    a = pfx.asn[order].astype(np.int64)
    starts, asns = [0], [0]
    end = -1
    for si, ei, ai in zip(s.tolist(), e.tolist(), a.tolist()):
        if ei <= end:  # nested or duplicate range: the first one wins
            continue
        si = max(si, end + 1)
        if si > end + 1:  # a gap
            starts.append(end + 1)
            asns.append(0)
        starts.append(si)
        asns.append(ai)
        end = ei
    if end < 2**32 - 1:
        starts.append(end + 1)
        asns.append(0)
    st = np.asarray(starts, np.int64)
    an = np.asarray(asns, np.int64)
    # drop zero-width and merge runs of the same AS
    keep = np.ones(len(st), bool)
    keep[:-1] &= st[1:] > st[:-1]
    st, an = st[keep], an[keep]
    keep = np.ones(len(st), bool)
    keep[1:] = an[1:] != an[:-1]
    return st[keep].astype(np.uint32), an[keep].astype(np.uint32)


def write_ip2asn(path: Path, pfx: PrefixTable) -> int:
    starts, asns = ip2asn_boundaries(pfx)
    head = MAGIC + np.array([VERSION, len(starts)], "<u4").tobytes()
    body = starts.astype("<u4").tobytes() + asns.astype("<u4").tobytes()
    path.write_bytes(gzip.compress(head + body, compresslevel=9, mtime=0))
    return len(starts)


def lookup(starts: np.ndarray, asns: np.ndarray, ip: int) -> int:
    i = int(np.searchsorted(starts, ip, side="right")) - 1
    return int(asns[i]) if i >= 0 else 0


def write_iata(path: Path, gaz: Gazetteer) -> int:
    codes = {c: [round(p.lat, 3), round(p.lon, 3), p.name] for c, p in gaz.by_code.items()}
    cities = {c: p.code.lower() for c, p in gaz.by_city.items()}
    path.write_text(json.dumps({"codes": codes, "cities": cities}, separators=(",", ":")))
    return len(codes)
