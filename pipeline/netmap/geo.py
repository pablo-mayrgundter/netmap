"""Address space and geography per AS.

Joins the prefix->AS table with an IP->location table to work out, for every
AS, how much IPv4 space it originates and where that space lives:

* the dominant site (address-weighted mode on a ~1 degree grid, refined to the
  weighted mean inside that cell) - this is where the AS is pinned in geo mode,
* ``concentration``: the share of its addresses within ``SITE_RADIUS_KM`` of
  that site. Regional ISPs score near 1; global transit and CDNs score low and
  are left free (unpinned) in the hybrid layout,
* the country (address-weighted mode) and a few top sites for the info panel.
"""

from __future__ import annotations

import csv
import gzip
import ipaddress
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SITE_RADIUS_KM = 400.0
EARTH_R_KM = 6371.0


def _open_text(path: Path):
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace", newline="")
    return open(path, "rt", encoding="utf-8", errors="replace", newline="")


@dataclass
class PrefixTable:
    start: np.ndarray  # uint64
    end: np.ndarray  # uint64 (inclusive)
    asn: np.ndarray  # uint32
    names: dict[int, str]


def load_prefixes(path: Path, cache: Path | None = None) -> PrefixTable:
    """ip-location-db ``asn-ipv4-num.csv``: start,end,asn,org."""
    npz = cache / "prefixes.npz" if cache else None
    if npz and npz.exists() and npz.stat().st_mtime >= Path(path).stat().st_mtime:
        z = np.load(npz, allow_pickle=True)
        return PrefixTable(z["start"], z["end"], z["asn"], z["names"].item())
    s, e, a = [], [], []
    names: dict[int, str] = {}
    with _open_text(path) as f:
        for row in csv.reader(f):
            if len(row) < 3:
                continue
            try:
                asn = int(row[2])
                s.append(int(row[0]))
                e.append(int(row[1]))
            except ValueError:
                continue
            a.append(asn)
            if len(row) > 3 and asn not in names:
                names[asn] = row[3]
    t = PrefixTable(
        np.asarray(s, np.uint64), np.asarray(e, np.uint64), np.asarray(a, np.uint32), names
    )
    order = np.argsort(t.start, kind="stable")
    t.start, t.end, t.asn = t.start[order], t.end[order], t.asn[order]
    if npz:
        npz.parent.mkdir(parents=True, exist_ok=True)
        np.savez(npz, start=t.start, end=t.end, asn=t.asn, names=np.asarray(names, dtype=object))
    return t


@dataclass
class GeoTable:
    start: np.ndarray  # uint64
    end: np.ndarray  # uint64
    lat: np.ndarray  # float32
    lon: np.ndarray  # float32
    cc: np.ndarray  # int16 index into countries
    city: np.ndarray  # int32 index into cities
    countries: list[str]
    cities: list[str]


def load_geo(path: Path, cache: Path | None = None) -> GeoTable:
    """ip-location-db city CSV (dbip-city or geolite2-city, ``-num`` variant).

    Columns: start,end,cc,state1,state2,city,postcode,lat,lon[,tz]
    """
    npz = cache / f"{Path(path).name}.npz" if cache else None
    if npz and npz.exists() and npz.stat().st_mtime >= Path(path).stat().st_mtime:
        z = np.load(npz, allow_pickle=True)
        return GeoTable(
            z["start"], z["end"], z["lat"], z["lon"], z["cc"], z["city"],
            list(z["countries"]), list(z["cities"]),
        )
    print(f"  parsing {Path(path).name} (one-off, cached afterwards)", file=sys.stderr)
    cc_ids: dict[str, int] = {}
    city_ids: dict[str, int] = {}
    s, e, la, lo, cc, ci = [], [], [], [], [], []
    with _open_text(path) as f:
        for row in csv.reader(f):
            if len(row) < 9 or not row[7] or not row[8]:
                continue
            try:
                lat_v, lon_v = float(row[7]), float(row[8])
                s.append(int(row[0]))
                e.append(int(row[1]))
            except ValueError:
                continue
            la.append(lat_v)
            lo.append(lon_v)
            cc.append(cc_ids.setdefault(row[2], len(cc_ids)))
            city = row[5] or row[3]
            ci.append(city_ids.setdefault(city, len(city_ids)))
    t = GeoTable(
        np.asarray(s, np.uint64), np.asarray(e, np.uint64),
        np.asarray(la, np.float32), np.asarray(lo, np.float32),
        np.asarray(cc, np.int16), np.asarray(ci, np.int32),
        list(cc_ids), list(city_ids),
    )
    order = np.argsort(t.start, kind="stable")
    for k in ("start", "end", "lat", "lon", "cc", "city"):
        setattr(t, k, getattr(t, k)[order])
    if npz:
        npz.parent.mkdir(parents=True, exist_ok=True)
        np.savez(
            npz, start=t.start, end=t.end, lat=t.lat, lon=t.lon, cc=t.cc, city=t.city,
            countries=np.asarray(t.countries, dtype=object),
            cities=np.asarray(t.cities, dtype=object),
        )
    return t


def overlap_join(a_start, a_end, b_start, b_end):
    """All overlapping pairs of two sorted, internally disjoint interval lists.

    Returns (ia, ib, overlap_size).
    """
    i0 = np.searchsorted(b_end, a_start, side="left")
    i1 = np.searchsorted(b_start, a_end, side="right")
    cnt = np.maximum(i1 - i0, 0)
    total = int(cnt.sum())
    ia = np.repeat(np.arange(len(a_start)), cnt)
    offs = np.repeat(np.cumsum(cnt) - cnt, cnt)
    ib = i0[ia] + (np.arange(total) - offs)
    lo = np.maximum(a_start[ia], b_start[ib])
    hi = np.minimum(a_end[ia], b_end[ib])
    return ia, ib, (hi - lo + 1).astype(np.float64)


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(lon2 - lon1)
    h = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_R_KM * np.arcsin(np.sqrt(np.clip(h, 0, 1)))


@dataclass
class AsProfile:
    asns: np.ndarray  # uint32 sorted
    addrs: np.ndarray  # float64 IPv4 addresses originated
    nprefix: np.ndarray  # int32 ranges originated
    has_geo: np.ndarray  # bool
    lat: np.ndarray  # float64 dominant site
    lon: np.ndarray
    concentration: np.ndarray  # float64 0..1
    country: list[str]
    sites: list[list[tuple[float, float, float, str]]]  # (lat, lon, share, city)
    names: dict[int, str]

    def index(self) -> dict[int, int]:
        return {int(a): i for i, a in enumerate(self.asns)}


def profile_ases(pfx: PrefixTable, geo: GeoTable, top_sites: int = 5) -> AsProfile:
    asns, a_idx = np.unique(pfx.asn, return_inverse=True)
    n = len(asns)
    size = (pfx.end - pfx.start + 1).astype(np.float64)
    addrs = np.bincount(a_idx, weights=size, minlength=n)
    nprefix = np.bincount(a_idx, minlength=n).astype(np.int32)

    ia, ig, w = overlap_join(pfx.start, pfx.end, geo.start, geo.end)
    owner = a_idx[ia]
    plat = geo.lat[ig].astype(np.float64)
    plon = geo.lon[ig].astype(np.float64)

    # Dominant 1-degree cell per AS.
    cell = (np.floor(plat + 90).astype(np.int64) * 360 + np.floor(plon + 180).astype(np.int64))
    key = owner.astype(np.int64) * 65536 + cell
    ukey, kinv = np.unique(key, return_inverse=True)
    kw = np.bincount(kinv, weights=w)
    k_owner = (ukey // 65536).astype(np.int64)
    # argmax weight per owner: sort by (owner, -weight)
    order = np.lexsort((-kw, k_owner))
    first = np.ones(len(order), bool)
    first[1:] = k_owner[order][1:] != k_owner[order][:-1]
    best_key = np.full(n, -1, np.int64)
    best_key[k_owner[order][first]] = ukey[order][first]

    in_best = key == best_key[owner]
    bw = np.bincount(owner, weights=w * in_best, minlength=n)
    has_geo = bw > 0
    with np.errstate(invalid="ignore", divide="ignore"):
        lat = np.bincount(owner, weights=w * in_best * plat, minlength=n) / bw
        lon = np.bincount(owner, weights=w * in_best * plon, minlength=n) / bw

    d = haversine_km(plat, plon, lat[owner], lon[owner])
    near = np.bincount(owner, weights=w * (d <= SITE_RADIUS_KM), minlength=n)
    tot = np.bincount(owner, weights=w, minlength=n)
    with np.errstate(invalid="ignore", divide="ignore"):
        conc = np.where(tot > 0, near / tot, 0.0)

    # Country: weighted mode.
    ckey = owner.astype(np.int64) * 1024 + geo.cc[ig].astype(np.int64)
    uc, cinv = np.unique(ckey, return_inverse=True)
    cw = np.bincount(cinv, weights=w)
    c_owner = uc // 1024
    order = np.lexsort((-cw, c_owner))
    first = np.ones(len(order), bool)
    first[1:] = c_owner[order][1:] != c_owner[order][:-1]
    country = [""] * n
    for k in order[first]:
        country[int(c_owner[k])] = geo.countries[int(uc[k] % 1024)]

    # Top sites per AS (by city) for the info panel.
    skey = owner.astype(np.int64) * (1 << 24) + geo.city[ig].astype(np.int64)
    us, sinv = np.unique(skey, return_inverse=True)
    sw = np.bincount(sinv, weights=w)
    slat = np.bincount(sinv, weights=w * plat) / sw
    slon = np.bincount(sinv, weights=w * plon) / sw
    s_owner = us // (1 << 24)
    order = np.lexsort((-sw, s_owner))
    sites: list[list[tuple[float, float, float, str]]] = [[] for _ in range(n)]
    for k in order:
        o = int(s_owner[k])
        if len(sites[o]) < top_sites and tot[o] > 0:
            sites[o].append(
                (round(float(slat[k]), 4), round(float(slon[k]), 4),
                 round(float(sw[k] / tot[o]), 4), geo.cities[int(us[k] % (1 << 24))])
            )

    return AsProfile(
        asns=asns, addrs=addrs, nprefix=nprefix, has_geo=has_geo,
        lat=np.nan_to_num(lat), lon=np.nan_to_num(lon), concentration=conc,
        country=country, sites=sites, names=pfx.names,
    )


def range_to_cidrs(start: int, end: int) -> list[str]:
    nets = ipaddress.summarize_address_range(
        ipaddress.IPv4Address(int(start)), ipaddress.IPv4Address(int(end))
    )
    return [str(n) for n in nets]


def prefixes_by_as(pfx: PrefixTable, limit: int = 48) -> dict[int, list[str]]:
    """Largest ``limit`` CIDRs per AS (for the info panel)."""
    size = (pfx.end - pfx.start + 1).astype(np.float64)
    order = np.lexsort((-size, pfx.asn))
    out: dict[int, list[str]] = {}
    for k in order:
        asn = int(pfx.asn[k])
        lst = out.setdefault(asn, [])
        if len(lst) < limit:
            lst.extend(range_to_cidrs(int(pfx.start[k]), int(pfx.end[k])))
    for asn, lst in out.items():
        del lst[limit:]
    return out
