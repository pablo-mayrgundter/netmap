"""Router-level maps from traceroutes: CAIDA's ITDK.

The Macroscopic Internet Topology Data Kit is built from CAIDA Ark
traceroutes: interfaces are merged into routers (alias resolution), each
router gets an owner AS (bdrmapIT) and a city (Hoiho hostname rules, IXP
locations, GeoLite), and IP links connect routers. That is tens of millions
of routers, so we aggregate:

* a **PoP** is (owner AS, city): every geolocated router of that AS there,
* a PoP link joins two PoPs that have at least one router-level link between
  them; its **weight** is the number of such links,
* links inside one AS between cities are that network's backbone, measured
  rather than inferred; links between ASes take transit/peering from CAIDA's
  AS relationships when available.

The result is a regular map bundle (same viewer), with edge weights driving
line brightness and fiber widths.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from .sources import _download

ITDK = "https://publicdata.caida.org/datasets/topology/ark/ipv4/itdk"
TOPOLOGY = "midar-iff-snmp"  # IPv4, MIDAR + iffinder + SNMP alias resolution
FILES = ["nodes.as", "nodes.geo", "links"]
MAX_CLIQUE = 8  # IP links shared by more routers (IXP LANs) become stars

INTRA = 1  # edge_rel for links inside one AS (between its cities)


def latest_release() -> str:
    import re
    import urllib.request

    from .sources import UA

    req = urllib.request.Request(f"{ITDK}/", headers={"User-Agent": UA})
    html = urllib.request.urlopen(req, timeout=60).read().decode()
    rel = sorted(set(re.findall(r'href="(\d{4}-\d{2})/"', html)))
    if not rel:
        raise RuntimeError("no ITDK releases listed")
    return rel[-1]


def fetch(cache: Path, release: str | None = None) -> tuple[str, dict[str, Path]]:
    release = release or latest_release()
    out = {}
    for f in FILES:
        name = f"{TOPOLOGY}.{f}.bz2"
        out[f] = _download(f"{ITDK}/{release}/{name}", cache / f"itdk-{release}" / name)
    return release, out


# awk programs turning each file into tab-separated integers/fields
AWK_AS = r'$1=="node.AS"{print substr($2,2)"\t"$3}'
AWK_GEO = r'/^node.geo/{id=substr($1,11); sub(":","",id); print id"\t"$6"\t"$7"\t"$3"|"$4"|"$5}'
AWK_LINKS = (
    r'/^link/{n=0; for(i=3;i<=NF;i++){t=$i; sub(/:.*/,"",t); a[++n]=substr(t,2)} '
    r'if(n>=2 && n<=%d){for(i=1;i<n;i++)for(j=i+1;j<=n;j++)print a[i]"\t"a[j]} '
    r'else if(n>%d){for(j=2;j<=n;j++)print a[1]"\t"a[j]} }' % (MAX_CLIQUE, MAX_CLIQUE)
)


def _stream(path: Path, awk: str, sep: str, **read_kw):
    """bzip2 -dc | awk | pandas, without temporary files."""
    import pandas as pd

    bz = shutil.which("lbzip2") or shutil.which("pbzip2") or "bzip2"
    p1 = subprocess.Popen([bz, "-dc", str(path)], stdout=subprocess.PIPE)
    awk_cmd = ["awk", "-F", sep, awk] if sep else ["awk", awk]
    p2 = subprocess.Popen(awk_cmd, stdin=p1.stdout, stdout=subprocess.PIPE)
    p1.stdout.close()
    try:
        return pd.read_csv(p2.stdout, sep="\t", header=None, engine="c", **read_kw)
    finally:
        p2.wait()
        p1.wait()


def aggregate(files: dict[str, Path], cache: Path) -> dict:
    """Routers -> (AS, city) PoPs and weighted PoP links. Cached as npz."""
    npz = cache / "pops.npz"
    if npz.exists():
        z = np.load(npz, allow_pickle=True)
        return {k: z[k] for k in z.files}
    import tempfile

    import pandas as pd

    t0 = time.time()
    # Peak memory matters (GitHub runners have 16 GB): the 190M router pairs
    # are decompressed to a temp file while the node files parse, then read
    # in chunks and folded into PoP pairs as they go.
    tmpdir = tempfile.TemporaryDirectory(dir=cache.parent if cache.parent.exists() else None)
    pairs_path = Path(tmpdir.name) / "pairs.tsv"
    bz = shutil.which("lbzip2") or shutil.which("pbzip2") or "bzip2"
    with open(pairs_path, "wb") as out:
        p1 = subprocess.Popen([bz, "-dc", str(files["links"])], stdout=subprocess.PIPE)
        p2 = subprocess.Popen(["awk", AWK_LINKS], stdin=p1.stdout, stdout=out)
        p1.stdout.close()
        with ThreadPoolExecutor(2) as ex:
            # int64: unknown owners are written as non-positive ASNs
            f_as = ex.submit(_stream, files["nodes.as"], AWK_AS, "\t", names=["id", "asn"],
                             dtype={"id": np.int32, "asn": np.int64})
            f_geo = ex.submit(_stream, files["nodes.geo"], AWK_GEO, "\t",
                              names=["id", "lat", "lon", "place"], keep_default_na=False,
                              dtype={"id": np.int32, "lat": np.float32, "lon": np.float32,
                                     "place": "category"})
            a = f_as.result()
            as_id = a.id.to_numpy()
            as_asn = np.clip(a.asn.to_numpy(), 0, 2**32 - 1).astype(np.uint32)  # unknown -> 0
            del a
            g = f_geo.result()
            geo_id = g.id.to_numpy()
            glat, glon = g.lat.to_numpy(), g.lon.to_numpy()
            pcode = g.place.cat.codes.to_numpy().astype(np.int32)
            places = list(g.place.cat.categories)
            del g
        print(f"  parsed {len(as_id)} AS rows, {len(geo_id)} geo rows ({time.time() - t0:.0f}s)",
              file=sys.stderr)

        maxid = int(max(as_id.max(), geo_id.max())) + 1
        asn = np.zeros(maxid, np.uint32)
        asn[as_id] = as_asn
        del as_id, as_asn
        place = np.full(maxid, -1, np.int32)
        place[geo_id] = pcode
        n_place = np.bincount(pcode, minlength=len(places))
        plat = np.bincount(pcode, weights=glat, minlength=len(places)) / np.maximum(n_place, 1)
        plon = np.bincount(pcode, weights=glon, minlength=len(places)) / np.maximum(n_place, 1)
        del geo_id, glat, glon, pcode

        ok = (asn > 0) & (place >= 0)
        keys = (asn[ok].astype(np.int64) << 24) | place[ok]
        ukeys, inv = np.unique(keys, return_inverse=True)
        del keys, asn, place
        pop = np.full(maxid, -1, np.int32)
        pop[np.flatnonzero(ok)] = inv
        routers = np.bincount(inv, minlength=len(ukeys))
        n_routers = int(ok.sum())
        del ok, inv
        p2.wait()
        p1.wait()
        if p2.returncode or p1.returncode:
            raise RuntimeError(f"decompressing {files['links']} failed")

    npop = len(ukeys)
    parts_k, parts_c, n_pairs = [], [], 0
    for chunk in pd.read_csv(pairs_path, sep="\t", header=None, names=["a", "b"], engine="c",
                             dtype={"a": np.int32, "b": np.int32}, chunksize=20_000_000):
        la, lb = chunk.a.to_numpy(), chunk.b.to_numpy()
        n_pairs += len(la)
        inside = (la < maxid) & (lb < maxid)
        pa = np.where(inside, pop[np.minimum(la, maxid - 1)], -1)
        pb = np.where(inside, pop[np.minimum(lb, maxid - 1)], -1)
        m = (pa >= 0) & (pb >= 0) & (pa != pb)
        lo = np.minimum(pa[m], pb[m]).astype(np.int64)
        hi = np.maximum(pa[m], pb[m]).astype(np.int64)
        k, c = np.unique(lo * npop + hi, return_counts=True)
        parts_k.append(k)
        parts_c.append(c)
    tmpdir.cleanup()
    allk = np.concatenate(parts_k)
    ek, kinv = np.unique(allk, return_inverse=True)
    weight = np.bincount(kinv, weights=np.concatenate(parts_c)).astype(np.int64)
    del allk, kinv, parts_k, parts_c, pop
    print(f"  folded {n_pairs} router pairs ({time.time() - t0:.0f}s)", file=sys.stderr)
    res = {
        "pop_asn": (ukeys >> 24).astype(np.int64),
        "pop_place": (ukeys & ((1 << 24) - 1)).astype(np.int32),
        "routers": routers.astype(np.int64),
        "src": (ek // len(ukeys)).astype(np.int32),
        "dst": (ek % len(ukeys)).astype(np.int32),
        "weight": weight.astype(np.int64),
        "places": np.asarray(places, dtype=object),
        "place_lat": plat, "place_lon": plon,
    }
    npz.parent.mkdir(parents=True, exist_ok=True)
    np.savez(npz, **res)
    print(f"  {len(ukeys)} PoPs, {len(ek)} PoP links from {n_routers} routers "
          f"({time.time() - t0:.0f}s)", file=sys.stderr)
    return res


def prune(agg: dict, min_routers: int) -> dict:
    """Drop PoPs with fewer routers (and their links), and isolated PoPs."""
    keep = agg["routers"] >= min_routers
    ke = keep[agg["src"]] & keep[agg["dst"]]
    deg = np.bincount(np.concatenate([agg["src"][ke], agg["dst"][ke]]), minlength=len(keep))
    keep &= deg > 0
    ke = keep[agg["src"]] & keep[agg["dst"]]
    new = np.full(len(keep), -1, np.int32)
    new[keep] = np.arange(int(keep.sum()))
    out = dict(agg)
    for k in ("pop_asn", "pop_place", "routers"):
        out[k] = agg[k][keep]
    out["src"] = new[agg["src"][ke]]
    out["dst"] = new[agg["dst"][ke]]
    out["weight"] = agg["weight"][ke]
    return out


def max_spanning_forest(n: int, src, dst, weight) -> np.ndarray:
    """Mask of links in a maximum-weight spanning forest: the heaviest
    connections, which give the router map its tree-like cyber layout."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import minimum_spanning_tree

    w = 1.0 / (1.0 + np.asarray(weight, np.float64))  # heavier = cheaper
    t = minimum_spanning_tree(coo_matrix((w, (src, dst)), shape=(n, n))).tocoo()
    key = np.minimum(t.row, t.col).astype(np.int64) * n + np.maximum(t.row, t.col)
    ekey = np.minimum(src, dst).astype(np.int64) * n + np.maximum(src, dst)
    return np.isin(ekey, key)
