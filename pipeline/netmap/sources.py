"""Where the raw data comes from, and a small download cache.

Everything lands in ``<cache>/`` (default ``data/raw``) and is reused on later
runs. All sources are public; see the README for licences and attribution.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

CAIDA = "https://publicdata.caida.org/datasets"
AS_REL2_DIR = f"{CAIDA}/as-relationships/serial-2/"
AS_REL1_DIR = f"{CAIDA}/as-relationships/serial-1/"
AS_ORG_DIR = f"{CAIDA}/as-organizations/"

NPM = "https://registry.npmjs.org"
# ip-location-db repackages RouteViews prefix->AS and DB-IP lite geolocation
# (both CC BY 4.0) as CSV. Pulled from the npm registry because it is mirrored
# everywhere, including sandboxes that cannot reach the upstream hosts.
NPM_PACKAGES = {
    "asn": ("@ip-location-db/asn", ["asn-ipv4-num.csv"]),
    "dbip-city": ("@ip-location-db/dbip-city", ["dbip-city-ipv4-num.csv.gz"]),
    "geolite2-city": ("@ip-location-db/geolite2-city", ["geolite2-city-ipv4-num.csv.gz"]),
    "airports": ("@nwpr/airport-codes", ["dist/airports.json"]),
}

UA = "netmap/0.1 (+https://github.com/pablo-mayrgundter/netmap)"


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def _download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetching {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    os.replace(tmp, dest)
    return dest


def _latest_in_listing(dir_url: str, pattern: str, date: str | None) -> str:
    html = _get(dir_url).decode("utf-8", "replace")
    names = sorted(set(re.findall(pattern, html)))
    if date:
        names = [n for n in names if n.startswith(date)]
    if not names:
        raise RuntimeError(f"no files matching {pattern!r} (date={date}) in {dir_url}")
    return names[-1]


def fetch_caida_asrel(cache: Path, date: str | None = None, serial: int = 2) -> Path:
    """Latest (or given YYYYMMDD) CAIDA AS relationship file."""
    if serial == 2:
        d, pat = AS_REL2_DIR, r"(\d{8}\.as-rel2\.txt\.bz2)"
    else:
        d, pat = AS_REL1_DIR, r"(\d{8}\.as-rel\.txt\.bz2)"
    name = _latest_in_listing(d, pat, date)
    return _download(d + name, cache / "caida" / name)


def fetch_caida_as2org(cache: Path, date: str | None = None) -> Path:
    name = _latest_in_listing(AS_ORG_DIR, r"(\d{8}\.as-org2info\.txt\.gz)", date)
    return _download(AS_ORG_DIR + name, cache / "caida" / name)


def fetch_npm(cache: Path, key: str) -> dict[str, Path]:
    """Download an npm tarball and extract only the files we need."""
    pkg, files = NPM_PACKAGES[key]
    outdir = cache / key
    want = {f: outdir / Path(f).name for f in files}
    if all(p.exists() for p in want.values()):
        return want
    meta = json.loads(_get(f"{NPM}/{pkg}/latest"))
    url = meta["dist"]["tarball"]
    print(f"  fetching {pkg}@{meta['version']}", file=sys.stderr)
    blob = _get(url)
    outdir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for f, dest in want.items():
            member = tar.getmember(f"package/{f}")
            src = tar.extractfile(member)
            assert src is not None
            with open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
    (outdir / "VERSION").write_text(f"{pkg}@{meta['version']}\n")
    return want
