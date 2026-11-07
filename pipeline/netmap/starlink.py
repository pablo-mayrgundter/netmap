"""Starlink (AS14593): PoPs, customer prefixes and regions from its own feeds.

Starlink publishes two CSVs at ``geoip.starlinkisp.net``:

* ``feed.csv``, an RFC 8805 geofeed: ``prefix,country,region,city,``. Each
  row is a block of customer addresses and where those customers are.
* ``pops.csv`` (since October 2025): ``prefix,popcode,iata``, the point of
  presence each block is assigned to, e.g. ``9.170.0.0/24,lsancax1,lax``.
  Not every feed prefix has one.

``build`` joins them, places each PoP at its airport (OurAirports, public
domain) and each customer region at a city, region or country point (also
from OurAirports), and ``write`` turns that into the files the web app reads
(``pops.json``, ``prefixes.json``, ``regions.json``, ``meta.json``; the
README has the schema). ``diff`` compares the PoP assignment against an older
snapshot from clarkzjw/starlink-geoip-data, which archives both feeds.
"""

from __future__ import annotations

import csv
import hashlib
import io
import ipaddress
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .sources import UA

ASN = 14593
FEED_URL = "https://geoip.starlinkisp.net/feed.csv"
POPS_URL = "https://geoip.starlinkisp.net/pops.csv"
OURAIRPORTS = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main"
HISTORY_REPO = "clarkzjw/starlink-geoip-data"
HISTORY_RAW = f"https://raw.githubusercontent.com/{HISTORY_REPO}/master"
HISTORY_API = f"https://api.github.com/repos/{HISTORY_REPO}/contents"
SCHEMA = 1

# IATA metropolitan-area codes are not airports, so OurAirports doesn't list
# them. Each maps to the area's main airport.
METRO = {
    "bjs": "pek", "bue": "eze", "buh": "otp", "chi": "ord", "dtt": "dtw", "jkt": "cgk",
    "lon": "lhr", "mil": "mxp", "mow": "svo", "nyc": "jfk", "osa": "kix", "par": "cdg",
    "rio": "gig", "rom": "fco", "sao": "gru", "sel": "icn", "spk": "cts", "sto": "arn",
    "tyo": "nrt", "was": "iad", "ymq": "yul", "yto": "yyz", "rek": "kef", "yea": "yeg",
}
# Airports first, then the rest; closed ones last.
TYPE_RANK = {"large_airport": 0, "medium_airport": 1, "small_airport": 2, "heliport": 3,
             "seaplane_base": 4, "balloonport": 5, "closed": 9}
CENTROID_TYPES = {"large_airport", "medium_airport", "small_airport"}

CAVEATS = [
    "A prefix's PoP is the one Starlink assigns that address block to; it does not reliably "
    "predict which PoP a given user's traffic leaves through.",
    "Before October 2025 Starlink published no PoP list; PoP mappings from then (e.g. in "
    "clarkzjw/starlink-geoip-data's geoip/ directory) came from DNS PTR records, which were "
    "often stale.",
    "The feed's city is the region Starlink sells into, not always a real town "
    "(mines, research stations), and customers can be hundreds of km away from it.",
    "PoP locations are their IATA airport's coordinates, not the facility's.",
]


def _fold(s: str) -> str:
    """Place name for matching: no accents, case, punctuation, "(...)" or "Saint"."""
    s = unicodedata.normalize("NFKD", re.sub(r"\(.*?\)", "", s))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"\b(saint|sainte|ste?)\b\.?", "st", s)
    return re.sub(r"[^a-z0-9]", "", s)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# Sources: a URL (downloaded into the cache) or a local file.


@dataclass
class Source:
    url: str
    data: bytes
    fetched_at: datetime

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()

    @property
    def text(self) -> str:
        return self.data.decode("utf-8-sig", "replace")

    def describe(self, **extra) -> dict:
        return {"url": self.url, "sha256": self.sha256, "bytes": len(self.data),
                "fetched_at": _iso(self.fetched_at), **extra}


def _is_url(s: str) -> bool:
    return s.startswith(("http://", "https://"))


def _http_get(url: str, headers: dict | None = None, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def load_source(src: str, dest: Path | None, refresh: bool = False, prune: str | None = None) -> Source:
    """Read ``src`` (a path, or a URL cached at ``dest``).

    ``prune`` is a glob of older copies next to ``dest`` to delete once a new
    one lands (the live feeds are cached one file per day).
    """
    if not _is_url(src):
        p = Path(src)
        return Source(str(p), p.read_bytes(), datetime.fromtimestamp(p.stat().st_mtime, timezone.utc))
    if dest is not None and dest.exists() and dest.stat().st_size > 0 and not refresh:
        return Source(src, dest.read_bytes(), datetime.fromtimestamp(dest.stat().st_mtime, timezone.utc))
    print(f"  fetching {src}", file=sys.stderr)
    data = _http_get(src)
    if dest is not None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, dest)
        if prune:
            for old in dest.parent.glob(prune):
                if old != dest:
                    old.unlink()
    return Source(src, data, _now())


# --------------------------------------------------------------------------
# Parsing


@dataclass(frozen=True)
class FeedRow:
    prefix: str
    country: str
    region: str
    city: str


def _net(s: str):
    try:
        return ipaddress.ip_network(s.strip(), strict=False)
    except ValueError:
        return None


def _rows(text: str):
    for row in csv.reader(io.StringIO(text)):
        if not row or not row[0].strip() or row[0].lstrip().startswith("#"):
            continue
        yield [c.strip() for c in row]


def parse_feed(text: str) -> tuple[dict[str, FeedRow], int]:
    """RFC 8805 geofeed -> {prefix: FeedRow}, and the count of rows skipped."""
    out: dict[str, FeedRow] = {}
    bad = 0
    for row in _rows(text):
        net = _net(row[0])
        if net is None:
            bad += 1
            continue
        row += [""] * (4 - len(row))
        p = str(net)
        out.setdefault(p, FeedRow(p, row[1].upper(), row[2].upper(), row[3]))
    return out, bad


def parse_pops(text: str) -> tuple[dict[str, tuple[str, str]], int]:
    """pops.csv -> {prefix: (popcode, iata)}, and the count of rows skipped."""
    out: dict[str, tuple[str, str]] = {}
    bad = 0
    for row in _rows(text):
        net = _net(row[0])
        if net is None or len(row) < 2 or not row[1]:
            bad += 1
            continue
        out.setdefault(str(net), (row[1].lower(), (row[2] if len(row) > 2 else "").lower()))
    return out, bad


def prefix_key(p: str):
    n = ipaddress.ip_network(p)
    return (n.version, int(n.network_address), n.prefixlen)


# --------------------------------------------------------------------------
# OurAirports: airports by IATA code, and points for cities, regions, countries


@dataclass
class Point:
    lat: float
    lon: float


def _centroid(vecs: list[tuple[float, float, float]]) -> Point | None:
    """Mean of unit vectors, back to lat/lon (safe across the antimeridian)."""
    if not vecs:
        return None
    x = sum(v[0] for v in vecs)
    y = sum(v[1] for v in vecs)
    z = sum(v[2] for v in vecs)
    r = math.sqrt(x * x + y * y + z * z)
    if r < 1e-9:
        return None
    return Point(math.degrees(math.asin(z / r)), math.degrees(math.atan2(y, x)))


def _unit(lat: float, lon: float):
    la, lo = math.radians(lat), math.radians(lon)
    return (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))


@dataclass
class Airports:
    by_iata: dict[str, dict] = field(default_factory=dict)
    by_city: dict[tuple, dict] = field(default_factory=dict)  # (cc, region, city), (cc, city), (city,)
    region_point: dict[str, Point] = field(default_factory=dict)
    country_point: dict[str, Point] = field(default_factory=dict)
    region_name: dict[str, str] = field(default_factory=dict)
    country_name: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_csv(cls, airports: str, regions: str = "", countries: str = "") -> "Airports":
        a = cls()
        rows = []
        for r in csv.DictReader(io.StringIO(airports)):
            try:
                r["_lat"], r["_lon"] = float(r["latitude_deg"]), float(r["longitude_deg"])
            except (KeyError, TypeError, ValueError):
                continue
            r["_rank"] = (TYPE_RANK.get(r.get("type", ""), 8), r.get("scheduled_service") != "yes")
            rows.append(r)
        rows.sort(key=lambda r: r["_rank"])  # best first, so setdefault keeps the best
        rvec, cvec, cany = defaultdict(list), defaultdict(list), defaultdict(list)
        for r in rows:
            code = (r.get("iata_code") or "").strip().lower()
            if len(code) == 3:
                a.by_iata.setdefault(code, r)
            cc, reg = r.get("iso_country", ""), r.get("iso_region", "")
            names = [r.get("municipality", "")]
            if r.get("type") in ("large_airport", "medium_airport"):  # "Saigon", "New York City"
                names += (r.get("keywords") or "").split(",")
            for city in filter(None, map(_fold, names)):
                a.by_city.setdefault((cc, reg, city), r)
                a.by_city.setdefault((cc, city), r)
                a.by_city.setdefault((city,), r)
            u = _unit(r["_lat"], r["_lon"])
            cany[cc].append(u)
            if r.get("type") in CENTROID_TYPES:
                rvec[reg].append(u)
                cvec[cc].append(u)
        a.region_point = {k: p for k, v in rvec.items() if (p := _centroid(v))}
        # A country with only heliports (Andorra, Monaco) is placed by those.
        a.country_point = {k: p for k, v in (cany | cvec).items() if (p := _centroid(v))}
        for r in csv.DictReader(io.StringIO(regions)) if regions else ():
            a.region_name[r["code"]] = r.get("name", "")
        for r in csv.DictReader(io.StringIO(countries)) if countries else ():
            a.country_name[r["code"]] = r.get("name", "")
        return a

    def airport(self, iata: str) -> tuple[dict | None, str | None]:
        """Airport for a published IATA code, and how it was found.

        Codes are matched without trailing digits (``atl2`` -> ATL, a second
        Atlanta PoP); metro-area codes go to the area's main airport
        (``jkt`` -> CGK).
        """
        code = re.sub(r"\d+$", "", (iata or "").lower())
        if len(code) != 3:
            return None, None
        if code in self.by_iata:
            return self.by_iata[code], "iata"
        if code in METRO and METRO[code] in self.by_iata:
            return self.by_iata[METRO[code]], "metro"
        return None, None

    def place(self, country: str, region: str, city: str) -> tuple[Point | None, str | None]:
        """Point for a feed location, and its precision: city, region or country."""
        c = _fold(city)
        if c:
            r = self.by_city.get((country, region, c)) or self.by_city.get((country, c))
            if r:
                return Point(r["_lat"], r["_lon"]), "city"
        if region in self.region_point:
            return self.region_point[region], "region"
        if country in self.country_point:
            return self.country_point[country], "country"
        # No airport at all under this country code (OurAirports files Åland
        # under FI): the city anywhere.
        r = self.by_city.get((c,)) if c else None
        if r:
            return Point(r["_lat"], r["_lon"]), "city"
        return None, None


# --------------------------------------------------------------------------
# Join


def _addrs(p: str) -> int:
    n = ipaddress.ip_network(p)
    return n.num_addresses if n.version == 4 else 0


def _r(x: float | None, nd: int = 4):
    return None if x is None else round(float(x), nd)


def build(feed: dict[str, FeedRow], pops: dict[str, tuple[str, str]], airports: Airports) -> dict:
    """Join the feeds: {pops, regions, prefixes, counts, unmatched}."""
    prefixes = sorted(set(feed) | set(pops), key=prefix_key)
    codes = sorted({c for c, _ in pops.values()})
    pop_ix = {c: i for i, c in enumerate(codes)}
    locs = sorted({(f.country, f.region, f.city) for f in feed.values()})
    loc_ix = {l: i for i, l in enumerate(locs)}

    col_pop, col_loc = [], []
    pstat = {c: {"v4": 0, "v6": 0, "addrs": 0, "iata": Counter(), "loc": Counter()} for c in codes}
    lstat = [{"v4": 0, "v6": 0, "addrs": 0, "pops": Counter(), "none": 0} for _ in locs]
    for p in prefixes:
        f = feed.get(p)
        code = pops.get(p, (None, ""))[0]
        li = loc_ix[(f.country, f.region, f.city)] if f else -1
        col_pop.append(pop_ix[code] if code else -1)
        col_loc.append(li)
        v = "v6" if ":" in p else "v4"
        a = _addrs(p)
        if code:
            s = pstat[code]
            s[v] += 1
            s["addrs"] += a
            s["iata"][pops[p][1]] += 1
            if li >= 0:
                s["loc"][li] += 1
        if li >= 0:
            s = lstat[li]
            s[v] += 1
            s["addrs"] += a
            if code:
                s["pops"][pop_ix[code]] += 1
            else:
                s["none"] += 1

    pop_list, unmatched = [], []
    for c in codes:
        s = pstat[c]
        iata = s["iata"].most_common(1)[0][0]
        ap, how = airports.airport(iata)
        n = s["v4"] + s["v6"]
        if ap is None:
            unmatched.append({"code": c, "iata": iata, "prefixes": n})
        pop_list.append({
            "code": c,
            "iata": iata,
            "airport": ap["iata_code"].upper() if ap else None,
            "located": how,
            "name": ap["name"] if ap else None,
            "city": (ap.get("municipality") or None) if ap else None,
            "country": ap["iso_country"] if ap else None,
            "lat": _r(ap["_lat"]) if ap else None,
            "lon": _r(ap["_lon"]) if ap else None,
            "v4_prefixes": s["v4"],
            "v6_prefixes": s["v6"],
            "v4_addresses": s["addrs"],
            "regions": [{"id": li, "country": locs[li][0], "region": locs[li][1], "city": locs[li][2],
                         "prefixes": k}
                        for li, k in sorted(s["loc"].items(), key=lambda kv: (-kv[1], kv[0]))],
        })

    region_list, unlocated = [], []
    for li, (cc, reg, city) in enumerate(locs):
        s = lstat[li]
        pt, prec = airports.place(cc, reg, city)
        if pt is None:
            unlocated.append({"country": cc, "region": reg, "city": city})
        region_list.append({
            "id": li, "country": cc, "country_name": airports.country_name.get(cc) or None,
            "region": reg, "region_name": airports.region_name.get(reg) or None, "city": city,
            "lat": _r(pt.lat if pt else None), "lon": _r(pt.lon if pt else None), "precision": prec,
            "v4_prefixes": s["v4"], "v6_prefixes": s["v6"], "v4_addresses": s["addrs"],
            "pops": [{"pop": pi, "code": codes[pi], "prefixes": k}
                     for pi, k in sorted(s["pops"].items(), key=lambda kv: (-kv[1], kv[0]))],
            "no_pop_prefixes": s["none"],
        })

    n_v6 = sum(":" in p for p in prefixes)
    prec = Counter(r["precision"] for r in region_list)
    counts = {
        "pops": len(codes),
        "pops_located": len(codes) - len(unmatched),
        "prefixes": len(prefixes),
        "v4_prefixes": len(prefixes) - n_v6,
        "v6_prefixes": n_v6,
        "feed_prefixes": len(feed),
        "prefixes_with_pop": sum(i >= 0 for i in col_pop),
        "feed_prefixes_without_pop": sum(1 for p in feed if p not in pops),
        "pop_prefixes_not_in_feed": sum(1 for p in pops if p not in feed),
        "v4_addresses": sum(_addrs(p) for p in prefixes),
        "v4_addresses_with_pop": sum(s["addrs"] for s in pstat.values()),
        "regions": len(locs),
        "regions_by_precision": {k or "none": v for k, v in sorted(prec.items(), key=lambda kv: str(kv[0]))},
        "countries": len({l[0] for l in locs}),
    }
    return {
        "pops": pop_list,
        "regions": region_list,
        "prefixes": {"schema": SCHEMA, "pops": codes, "regions": [list(l) for l in locs],
                     "prefix": prefixes, "pop": col_pop, "region": col_loc},
        "counts": counts,
        "unmatched": {"iata": unmatched, "regions": unlocated},
    }


# --------------------------------------------------------------------------
# Diff against an older snapshot


def diff(prev_pops: dict, cur_pops: dict, prev_feed: dict | None = None,
         cur_feed: dict | None = None, max_moved: int = 1000) -> dict:
    """PoPs added/removed and prefixes moved between PoPs (and feed changes)."""
    pc = Counter(c for c, _ in prev_pops.values())
    cc = Counter(c for c, _ in cur_pops.values())
    moved = sorted(((p, prev_pops[p][0], cur_pops[p][0]) for p in set(prev_pops) & set(cur_pops)
                    if prev_pops[p][0] != cur_pops[p][0]), key=lambda m: prefix_key(m[0]))
    pairs = Counter((f, t) for _, f, t in moved)
    out = {
        "pops_added": sorted(set(cc) - set(pc)),
        "pops_removed": sorted(set(pc) - set(cc)),
        "pop_prefix_counts": [{"code": c, "before": pc.get(c, 0), "after": cc.get(c, 0)}
                              for c in sorted(set(pc) | set(cc)) if pc.get(c, 0) != cc.get(c, 0)],
        "prefixes_assigned": len(set(cur_pops) - set(prev_pops)),
        "prefixes_unassigned": len(set(prev_pops) - set(cur_pops)),
        "prefixes_moved": len(moved),
        "moves": [{"from": f, "to": t, "prefixes": n}
                  for (f, t), n in sorted(pairs.items(), key=lambda kv: (-kv[1], kv[0]))],
        "moved": [list(m) for m in moved[:max_moved]],
        "moved_truncated": len(moved) > max_moved,
    }
    if prev_feed is not None and cur_feed is not None:
        both = set(prev_feed) & set(cur_feed)
        out["feed"] = {
            "prefixes_added": len(set(cur_feed) - set(prev_feed)),
            "prefixes_removed": len(set(prev_feed) - set(cur_feed)),
            "prefixes_relocated": sum(1 for p in both if prev_feed[p] != cur_feed[p]),
        }
    return out


_SNAP = re.compile(r"pops-(\d{8})-(\d{4})\.csv$")


def _snapshot_time(name: str) -> datetime | None:
    m = _SNAP.search(name)
    return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M").replace(tzinfo=timezone.utc) if m else None


def list_history(months: list[str]) -> list[str]:
    """Paths of clarkzjw's PoP snapshots (``pop/YYYYMM/pops-*.csv``) in these months.

    Uses the GitHub contents API (with ``GITHUB_TOKEN`` if set), falling back
    to a tree-only git clone where the API isn't reachable.
    """
    names: list[str] = []
    try:
        tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        hdr = {"Accept": "application/vnd.github+json", **({"Authorization": f"Bearer {tok}"} if tok else {})}
        for m in months:
            try:
                items = json.loads(_http_get(f"{HISTORY_API}/pop/{m}", hdr, timeout=60))
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    continue
                raise
            names += [f"pop/{m}/{it['name']}" for it in items if _SNAP.search(it.get("name", ""))]
        return sorted(names)
    except Exception as exc:  # API blocked or rate-limited
        print(f"  history listing via API failed ({exc}); trying git", file=sys.stderr)
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--no-checkout",
                        f"https://github.com/{HISTORY_REPO}.git", d], check=True, timeout=300)
        ls = subprocess.run(["git", "-C", d, "ls-tree", "-r", "--name-only", "HEAD", "pop/"],
                            check=True, capture_output=True, text=True).stdout.split()
    return sorted(n for n in ls if any(n.startswith(f"pop/{m}/") for m in months) and _SNAP.search(n))


def find_previous(now: datetime, days: int) -> tuple[str, datetime] | None:
    """Newest archived PoP snapshot at least ``days`` older than ``now``."""
    target = now - timedelta(days=days)
    months, t = [], target
    for _ in range(3):
        months.append(t.strftime("%Y%m"))
        t = t.replace(day=1) - timedelta(days=1)
    best = None
    for n in list_history(months):
        ts = _snapshot_time(n)
        if ts and ts <= target and (best is None or ts > best[1]):
            best = (n, ts)
    return best


# --------------------------------------------------------------------------
# Writing


def _dump(path: Path, obj, pretty: bool = False) -> int:
    s = json.dumps(obj, indent=1) if pretty else json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(s + "\n", encoding="utf-8")
    return path.stat().st_size


def write(out: Path, result: dict, meta: dict) -> dict[str, int]:
    out.mkdir(parents=True, exist_ok=True)
    return {
        "pops.json": _dump(out / "pops.json", result["pops"]),
        "prefixes.json": _dump(out / "prefixes.json", result["prefixes"]),
        "regions.json": _dump(out / "regions.json", result["regions"]),
        "meta.json": _dump(out / "meta.json", meta, pretty=True),
    }


def as_sites(pops: list[dict]) -> list[tuple[float, float, float, str, str]]:
    """(lat, lon, v4 addresses, city, country) per located PoP, for geo.resite."""
    return [(p["lat"], p["lon"], float(p["v4_addresses"]), p.get("city") or p.get("name") or p["code"],
             p.get("country") or "")
            for p in pops if p.get("lat") is not None and p.get("v4_addresses", 0) > 0]


ATTRIBUTION = [
    'Starlink geofeed and PoP list: <a href="https://geoip.starlinkisp.net/feed.csv">geoip.starlinkisp.net</a>',
    'Airports, regions and countries: <a href="https://ourairports.com/data/">OurAirports</a> (public domain)',
]
ATTRIBUTION_HISTORY = ('Previous snapshot: <a href="https://github.com/clarkzjw/starlink-geoip-data">'
                       'clarkzjw/starlink-geoip-data</a> (CC BY-SA 4.0)')


def run(out: Path, cache: Path, *, feed: str = FEED_URL, pops: str = POPS_URL,
        ourairports: str = OURAIRPORTS, previous: str = "auto", previous_feed: str | None = None,
        previous_days: int = 30, refresh: bool = False, log=print) -> dict:
    """Fetch (or read) the sources, join, diff and write ``out``. Returns meta."""
    now = _now()
    day = now.strftime("%Y%m%d")
    sc = cache / "starlink"
    s_feed = load_source(feed, sc / f"feed-{day}.csv", refresh, prune="feed-*.csv")
    s_pops = load_source(pops, sc / f"pops-{day}.csv", refresh, prune="pops-*.csv")
    oa = {}
    for name in ("airports", "regions", "countries"):
        src = f"{ourairports}/{name}.csv" if _is_url(ourairports) else str(Path(ourairports) / f"{name}.csv")
        if name != "airports" and not _is_url(src) and not Path(src).exists():
            continue  # names are optional for local fixtures
        oa[name] = load_source(src, cache / "ourairports" / f"{name}.csv", refresh)
    airports = Airports.from_csv(oa["airports"].text, oa.get("regions") and oa["regions"].text or "",
                                 oa.get("countries") and oa["countries"].text or "")

    fd, bad_f = parse_feed(s_feed.text)
    pp, bad_p = parse_pops(s_pops.text)
    res = build(fd, pp, airports)
    log(f"  {res['counts']['pops']} PoPs ({res['counts']['pops_located']} located), "
        f"{res['counts']['prefixes']} prefixes, {res['counts']['regions']} regions")

    srcs = {"feed": s_feed.describe(rows=len(fd), skipped=bad_f),
            "pops": s_pops.describe(rows=len(pp), skipped=bad_p),
            **{f"ourairports_{k}": v.describe() for k, v in oa.items()}}
    attribution = list(ATTRIBUTION)
    dif, dif_err = None, None
    if previous and previous != "none":
        try:
            if previous == "auto":
                found = find_previous(now, previous_days)
                if not found:
                    raise RuntimeError(f"no snapshot {previous_days}+ days old in {HISTORY_REPO}")
                path, ts = found
                hist = sc / "history"
                prev_p = load_source(f"{HISTORY_RAW}/{path}", hist / Path(path).name, prune="pops-*.csv")
                fpath = path.replace("pop/", "feed/", 1).replace("/pops-", "/feed-")
                try:
                    prev_f = load_source(f"{HISTORY_RAW}/{fpath}", hist / Path(fpath).name, prune="feed-*.csv")
                except Exception:
                    prev_f = None
            else:
                ts = _snapshot_time(previous)
                prev_p = load_source(previous, None)
                prev_f = load_source(previous_feed, None) if previous_feed else None
            dif = diff(parse_pops(prev_p.text)[0], pp,
                       parse_feed(prev_f.text)[0] if prev_f else None, fd if prev_f else None)
            dif = {"previous": {"snapshot": _iso(ts) if ts else None, "pops": prev_p.describe(),
                                "feed": prev_f.describe() if prev_f else None}, **dif}
            if _is_url(prev_p.url) and HISTORY_REPO in prev_p.url:
                attribution.append(ATTRIBUTION_HISTORY)
            log(f"  vs {dif['previous']['snapshot'] or previous}: +{len(dif['pops_added'])} "
                f"-{len(dif['pops_removed'])} PoPs, {dif['prefixes_moved']} prefixes moved")
        except Exception as exc:
            dif_err = f"{type(exc).__name__}: {exc}"
            log(f"  no diff: {dif_err}")

    meta = {
        "schema": SCHEMA,
        "kind": "starlink",
        "name": "Starlink (AS14593)",
        "asn": ASN,
        "fetched_at": _iso(s_feed.fetched_at),
        "generated": _iso(now),
        "sources": srcs,
        "counts": res["counts"],
        "unmatched": res["unmatched"],
        "diff": dif,
        "diff_error": dif_err,
        "files": {},
        "attribution": attribution,
        "caveats": CAVEATS,
    }
    sizes = write(out, res, meta)
    meta["files"] = {k: v for k, v in sizes.items() if k != "meta.json"}
    _dump(out / "meta.json", meta, pretty=True)
    return meta
