"""Geo hints from router hostnames (reverse DNS in traceroute data).

Backbone operators embed locations in interface names, usually as IATA
airport codes or city names::

    be3037.ccr21.dfw01.atlas.cogentco.com      -> DFW (Dallas)
    ae-1-3502.edge4.Frankfurt1.Level3.net       -> Frankfurt
    ae2.cs1.ams17.nl.eth.zayo.com               -> AMS (Amsterdam)
    lhr25s34-in-f14.1e100.net                   -> LHR (London)

These hints are what lets router-level (CAIDA Ark / ITDK) links be pinned
to cities and long-haul hops be drawn as arcs between airports in the 3D
hybrid view. The parser is deliberately conservative: a token must look like
``<code><digits>`` or be a known city name, and router-role words are ignored.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

# Tokens that look like IATA codes but are router roles, media, or TLD-ish.
STOP = set(
    """
    net com org edu gov mil int biz info gin ntt bbr ccr agr rtr bdr cor core dsl cpe pop
    ipv dyn ptr res mpr hsd fbr cus srv gig ten eth vla vlan lag lan wan sfp mgt mgmt
    oob bgp isp tel pts asr mxs csr ers acc agg dis bng lns cmt olt hub dia cdn web dns
    ftp ssl tls ptp p2p atm pos ser loo tun gre lo0 xe0 ge0 et0 ae0 the and ixp nap
    """.split()
)
TOKEN = re.compile(r"^([a-z]{3})(\d{1,3}(?:[a-z]{1,2}\d{0,3})?)?$")
SPLIT = re.compile(r"[.\-_]")


@dataclass(frozen=True)
class Place:
    code: str
    name: str
    lat: float
    lon: float


@dataclass(frozen=True)
class Hint:
    token: str
    place: Place
    kind: str  # "iata" | "city"
    position: int  # token index from the left


class Gazetteer:
    def __init__(self, places_by_code: dict[str, Place], places_by_city: dict[str, Place]):
        self.by_code = places_by_code
        self.by_city = places_by_city

    @classmethod
    def from_openflights(cls, path: Path) -> "Gazetteer":
        """Load ``@nwpr/airport-codes`` dist/airports.json (OpenFlights)."""
        rows = json.loads(Path(path).read_text())
        by_code: dict[str, Place] = {}
        by_city: dict[str, Place] = {}
        for r in rows:
            code = (r.get("iata") or "").strip().lower()
            if len(code) != 3 or not code.isalpha():
                continue
            try:
                p = Place(code.upper(), r.get("city") or r.get("name") or "",
                          float(r["latitude"]), float(r["longitude"]))
            except (KeyError, TypeError, ValueError):
                continue
            by_code.setdefault(code, p)
            city = re.sub(r"[^a-z]", "", (r.get("city") or "").lower())
            if len(city) >= 5:
                by_city.setdefault(city, p)
        return cls(by_code, by_city)

    def hints(self, hostname: str) -> list[Hint]:
        tokens = [t for t in SPLIT.split(hostname.lower()) if t]
        # The last two labels are the operator's domain; never geo.
        labels = hostname.lower().split(".")
        domain_tokens = set(SPLIT.split(".".join(labels[-2:]))) if len(labels) >= 2 else set()
        out: list[Hint] = []
        for i, tok in enumerate(tokens):
            if tok in domain_tokens:
                continue
            m = TOKEN.match(tok)
            if m and m.group(1) not in STOP and m.group(1) in self.by_code:
                # Bare 3-letter tokens are ambiguous; require digits unless the
                # code is the whole token and sits in the middle of the name.
                if m.group(2) or 0 < i < len(tokens) - 2:
                    out.append(Hint(tok, self.by_code[m.group(1)], "iata", i))
                    continue
            city = re.sub(r"\d+$", "", tok)
            if len(city) >= 5 and city in self.by_city:
                out.append(Hint(tok, self.by_city[city], "city", i))
        return out

    def locate(self, hostname: str) -> Place | None:
        """Best single guess: prefer city names, then IATA codes with digits."""
        hs = self.hints(hostname)
        if not hs:
            return None
        hs.sort(key=lambda h: (h.kind != "city", not TOKEN.match(h.token).group(2) if h.kind == "iata" else False))
        return hs[0].place
