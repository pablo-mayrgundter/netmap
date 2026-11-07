"""Starlink's space segment for the app's modelled links: gateways and orbits.

``gateways`` writes ``gateways.json``: Starlink's gateway (ground station)
sites, each with its provenance. ``gp`` writes ``gp.json``: a snapshot of
CelesTrak's general perturbations elements for the Starlink group, which the
browser propagates with SGP4 when CelesTrak itself can't be reached.

Gateways
--------
The sites come from `NodalArc <https://github.com/dotchance/nodalarc>`_'s
catalog (``catalog/nodalarc/sites/earth/<cc>/*.yaml``; Apache-2.0, "facts
are not owned by NodalArc"), pinned to a commit. Only sites whose node is
``starlink-gateway.yaml`` are kept, in two tiers:

* ``filing``: the coordinates are an FCC earth-station licence's (IBFS file
  numbers ``SES-LIC-…``, ``SES-MOD-…``, ``SES-STA-…``; US government records,
  public domain). Each row keeps its file number and a link to it.
* ``reported``: a site the catalog notes as a confirmed operational Starlink
  gateway, outside the US, with no filing: the coordinates are an estimate
  for the named place (a town, ±20 km or so).

Sites the catalog only guesses at (a city centre, "named-facility coordinate
estimate"), its own scenario sites and sites with no source are left out,
and ``meta.excluded`` counts them. Where tlrobinson/satsim's list (BSD-2-Clause,
FCC file numbers from 2019-2020) has the same file number, the coordinates
are cross-checked against it (``cross_check``).
"""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
from collections import Counter
from pathlib import Path

from .starlink import Source, _dump, _is_url, _iso, _now, load_source

SCHEMA = 1
NODALARC_REPO = "https://github.com/dotchance/nodalarc.git"
NODALARC_WEB = "https://github.com/dotchance/nodalarc"
# 2026-11-02. `--ref main` takes the newest.
NODALARC_REF = "8bf6b45ad7b0edd8c1692fb0bf3c2d9674cf4833"
SITES_DIR = "catalog/nodalarc/sites/earth"
SATSIM_URL = "https://raw.githubusercontent.com/tlrobinson/satsim/master/public/starlink_gateways.json"
FCC_FILING_URL = "https://fcc.report/IBFS/{}"
GATEWAY_NODE = "starlink-gateway.yaml"

CELESTRAK_GP = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json"
# The OMM fields SGP4 needs (and the name and designator), in gp.json's order.
GP_FIELDS = ["OBJECT_NAME", "OBJECT_ID", "NORAD_CAT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY",
             "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR",
             "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT", "EPHEMERIS_TYPE", "CLASSIFICATION_TYPE",
             "ELEMENT_SET_NO", "REV_AT_EPOCH"]

COUNTRY = {
    "aq": "AQ", "ar": "AR", "au": "AU", "br": "BR", "ca": "CA", "cl": "CL", "co": "CO", "de": "DE",
    "dj": "DJ", "es": "ES", "fj": "FJ", "fk": "FK", "fr": "FR", "gb": "GB", "gh": "GH", "gu": "GU",
    "id": "ID", "ie": "IE", "in": "IN", "it": "IT", "jp": "JP", "ke": "KE", "mx": "MX", "ng": "NG",
    "nl": "NL", "no": "NO", "nz": "NZ", "om": "OM", "ph": "PH", "pl": "PL", "pr": "PR", "pt": "PT",
    "sg": "SG", "sj": "SJ", "tr": "TR", "us": "US", "za": "ZA",
}

CAVEATS = [
    "Gateway sites are public filings and reports, not SpaceX's list: Starlink runs many more "
    "gateways than are here, above all outside the US.",
    "A licence is not a working site: some licensed gateways were never built or have closed.",
    "Reported sites outside the US are placed at the named town, not at the antennas.",
]


def _haversine_km(lat0, lon0, lat1, lon1) -> float:
    p0, p1 = math.radians(lat0), math.radians(lat1)
    h = math.sin((p1 - p0) / 2) ** 2 + math.cos(p0) * math.cos(p1) * math.sin(math.radians(lon1 - lon0) / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(h)))


def _fold_notes(s: str | None) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _legacy_facts(notes: str) -> dict:
    """'Legacy site fact: antennas=8. … antenna_diameter_m=1.52. … band=Ka.' -> a dict."""
    out = {}
    for k, v in re.findall(r"Legacy site fact: (\w+)=([\w.]+)", notes):
        v = v.rstrip(".")
        try:
            out[k] = int(v) if re.fullmatch(r"\d+", v) else float(v) if re.fullmatch(r"[\d.]+", v) else v
        except ValueError:
            out[k] = v
    return out


def parse_site(text: str, cc: str) -> dict | None:
    """One NodalArc site YAML -> a flat record, or None if it isn't a site."""
    import yaml

    doc = yaml.safe_load(text) or {}
    s = doc.get("site")
    if not isinstance(s, dict):
        return None
    v = s.get("verified") or {}
    loc = s.get("location") or {}
    nodes = s.get("nodes") or []
    return {
        "id": s.get("id"),
        "display_name": s.get("display_name") or "",
        "source": str(v.get("source") or "none"),
        "filing": v.get("filing"),
        "confidence": v.get("confidence"),
        "notes": _fold_notes(v.get("notes")),
        "node": str(nodes[0].get("node") or "") if nodes and isinstance(nodes[0], dict) else "",
        "lat": loc.get("lat_deg"),
        "lon": loc.get("lon_deg"),
        "alt_m": loc.get("alt_m"),
        "cc": cc,
    }


def classify(site: dict) -> str:
    """'filing', 'reported' or why the site is left out."""
    if not site["node"].endswith(GATEWAY_NODE):
        return "not_a_starlink_gateway"
    if site["lat"] is None or site["lon"] is None:
        return "no_location"
    if site["filing"] and site["confidence"] == "filing":
        return "filing"
    if site["notes"].startswith("Confirmed operational Starlink gateway") or site["source"] == "wikipedia":
        return "reported"
    if site["source"] in ("legacy_catalog", "nodalarc_catalog"):
        return "no_source"
    return "city_estimate"


def _name(site: dict) -> str:
    n = re.sub(r"\s*Gateway Site$", "", site["display_name"]).strip() or site["id"]
    return n


def load_satsim(src: Source | None) -> dict[str, tuple[float, float, str]]:
    """satsim's list -> {file number (or its name, if none is cited): (lat, lon, name)}."""
    if src is None:
        return {}
    out = {}
    for g in json.loads(src.text):
        m = re.search(r"(S[A-Z]{2}-[A-Z]{3}-[A-Z0-9]+-\d+)", g.get("description", ""))
        c = g.get("coordinates") or []
        if len(c) >= 2:
            out[m.group(1) if m else g.get("name", "")] = (float(c[1]), float(c[0]), g.get("name", ""))
    return out


def build_gateways(sites: list[dict], satsim: dict) -> tuple[list[dict], Counter]:
    rows, excluded = [], Counter()
    for s in sites:
        tier = classify(s)
        if tier not in ("filing", "reported"):
            excluded[tier] += 1
            continue
        lat, lon = round(float(s["lat"]), 6), round(float(s["lon"]), 6)
        facts = _legacy_facts(s["notes"])
        row = {
            "id": s["id"].removeprefix("earth-"),
            "name": _name(s),
            "country": COUNTRY.get(s["cc"], s["cc"].upper()),
            "lat": lat,
            "lon": lon,
            "alt_m": s["alt_m"] if isinstance(s["alt_m"], (int, float)) else None,
            "tier": tier,
            # Where the point is from: the filing itself, or a geocoded town.
            "located": "filing" if tier == "filing" and s["source"] == "FCC IBFS" else "town",
            "filing": s["filing"] if tier == "filing" else None,
            "filing_url": FCC_FILING_URL.format(s["filing"]) if tier == "filing" else None,
            "source": s["source"],
            "antennas": facts.get("antennas"),
            "cross_check": None,
        }
        if tier == "filing" and s["filing"] in satsim:
            slat, slon, _ = satsim[s["filing"]]
            row["cross_check"] = {"source": "satsim", "by": "filing",
                                  "km": round(_haversine_km(lat, lon, slat, slon), 3)}
        elif tier == "filing" and satsim:
            # A later filing for the same site (a modification): match by place.
            km, name = min((_haversine_km(lat, lon, a, b), n) for a, b, n in satsim.values())
            if km < 2:
                row["cross_check"] = {"source": "satsim", "by": "position", "km": round(km, 3)}
        rows.append(row)
    rows.sort(key=lambda r: (r["tier"] != "filing", r["country"], r["name"]))
    return rows, excluded


def fetch_sites(cache: Path, ref: str, log=print) -> tuple[Path, str]:
    """A sparse, blob-less clone of NodalArc's site catalog at ``ref`` -> (sites dir, commit)."""
    dest = cache / "starlink" / "nodalarc"
    git = shutil.which("git")
    if not git:
        raise RuntimeError("git is needed to fetch NodalArc's catalog (or pass --sites <dir>)")

    def run(*a, cwd=dest):
        return subprocess.run([git, *a], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

    if not (dest / ".git").exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        log(f"  cloning {NODALARC_REPO} (sites only)")
        subprocess.run([git, "clone", "-q", "--filter=blob:none", "--no-checkout", "--depth", "50",
                        NODALARC_REPO, str(dest)], check=True, capture_output=True, text=True)
        run("sparse-checkout", "set", SITES_DIR)
    try:
        run("checkout", "-q", ref)
    except subprocess.CalledProcessError:
        run("fetch", "-q", "--depth", "50", "origin", ref if ref != "main" else "main")
        run("checkout", "-q", "FETCH_HEAD" if ref == "main" else ref)
    if ref == "main":
        run("fetch", "-q", "--depth", "1", "origin", "main")
        run("checkout", "-q", "FETCH_HEAD")
    return dest / SITES_DIR, run("rev-parse", "HEAD")


def read_sites(root: Path) -> list[dict]:
    out = []
    for f in sorted(root.glob("*/*.yaml")):
        s = parse_site(f.read_text(encoding="utf-8"), f.parent.name)
        if s and s["id"]:
            out.append(s)
    return out


def run_gateways(out: Path, cache: Path, *, sites: str | None = None, ref: str = NODALARC_REF,
                 satsim: str = SATSIM_URL, log=print) -> dict:
    """Read NodalArc's catalog (a checkout dir, or cloned at ``ref``) and write gateways.json."""
    now = _now()
    if sites:
        root, commit = Path(sites), None
        if (root / SITES_DIR).exists():
            root = root / SITES_DIR
    else:
        root, commit = fetch_sites(cache, ref, log)
    parsed = read_sites(root)
    s_sat = None
    if satsim and satsim != "none":
        try:
            s_sat = load_source(satsim, cache / "starlink" / "satsim-gateways.json" if _is_url(satsim) else None)
        except Exception as exc:  # a cross-check only: carry on without it
            log(f"  no satsim cross-check: {type(exc).__name__}: {exc}")
    sat = load_satsim(s_sat)
    rows, excluded = build_gateways(parsed, sat)
    tiers = Counter(r["tier"] for r in rows)
    checked = [r for r in rows if r["cross_check"]]
    log(f"  {len(rows)} gateways ({tiers['filing']} from FCC filings, {tiers['reported']} reported), "
        f"{sum(excluded.values())} catalog sites left out; {len(checked)} cross-checked against satsim, "
        f"worst {max((r['cross_check']['km'] for r in checked), default=0):.2f} km")
    doc = {
        "schema": SCHEMA,
        "kind": "starlink-gateways",
        "generated": _iso(now),
        "sources": {
            "nodalarc": {"url": NODALARC_WEB, "commit": commit, "path": SITES_DIR, "licence": "Apache-2.0",
                         "notice": "NodalArc, Copyright 2024-2026 .chance (dotchance)",
                         "sites_read": len(parsed)},
            "satsim": ({**s_sat.describe(), "licence": "BSD-2-Clause", "notice": "Copyright 2020 Tom Robinson",
                        "rows": len(sat)} if s_sat else None),
            "fcc": {"url": "https://licensing.fcc.gov/myibfs/", "mirror": "https://fcc.report/IBFS/",
                    "licence": "public domain (US government records)"},
        },
        "counts": {"gateways": len(rows), "filing": tiers["filing"], "reported": tiers["reported"],
                   "countries": len({r["country"] for r in rows}), "cross_checked": len(checked)},
        "excluded": dict(sorted(excluded.items())),
        "tiers": {
            "filing": "Coordinates from the site's FCC earth-station licence (file number given).",
            "reported": "A confirmed Starlink gateway with no filing here; placed at the named town (±20 km).",
        },
        "attribution": [
            'Gateway sites: <a href="https://github.com/dotchance/nodalarc">NodalArc</a>\'s catalog '
            "(Apache-2.0), from FCC earth-station filings (public domain) and reports",
            'Cross-check: <a href="https://github.com/tlrobinson/satsim">tlrobinson/satsim</a> (BSD-2-Clause)',
        ],
        "caveats": CAVEATS,
        "gateways": rows,
    }
    out.mkdir(parents=True, exist_ok=True)
    size = _dump(out / "gateways.json", doc)
    log(f"  wrote {out / 'gateways.json'} ({size:,} bytes)")
    return doc


# --------------------------------------------------------------------------
# CelesTrak's GP elements, as a fallback snapshot for the browser.


def compact_gp(records: list[dict]) -> dict:
    rows = []
    for r in records:
        if not r.get("NORAD_CAT_ID") or r.get("MEAN_MOTION") is None:
            continue
        rows.append([r.get(f) for f in GP_FIELDS])
    rows.sort(key=lambda r: r[2])
    return {"fields": GP_FIELDS, "rows": rows}


def run_gp(out: Path, cache: Path, *, src: str = CELESTRAK_GP, refresh: bool = False, log=print) -> dict:
    """CelesTrak's Starlink GP elements -> gp.json (columnar)."""
    now = _now()
    hour = now.strftime("%Y%m%dT%H")
    s = load_source(src, cache / "starlink" / f"gp-{hour}.json" if _is_url(src) else None, refresh,
                    prune="gp-*.json")
    recs = json.loads(s.text)
    if not isinstance(recs, list) or not recs:
        raise RuntimeError(f"{src}: no GP records")
    gp = compact_gp(recs)
    epochs = sorted(r[3] for r in gp["rows"] if r[3])
    doc = {
        "schema": SCHEMA,
        "kind": "starlink-gp",
        "generated": _iso(now),
        "source": {**s.describe(), "licence": "CelesTrak GP data (celestrak.org): free to use, please credit"},
        "count": len(gp["rows"]),
        "epochs": {"min": epochs[0] if epochs else None, "max": epochs[-1] if epochs else None},
        **gp,
    }
    out.mkdir(parents=True, exist_ok=True)
    size = _dump(out / "gp.json", doc)
    log(f"  {doc['count']} element sets, epochs {doc['epochs']['min']} .. {doc['epochs']['max']}; "
        f"wrote {out / 'gp.json'} ({size:,} bytes)")
    return doc


__all__ = ["run_gateways", "run_gp", "parse_site", "classify", "build_gateways", "compact_gp", "load_satsim"]
