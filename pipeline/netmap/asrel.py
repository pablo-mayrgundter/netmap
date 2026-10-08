"""Parsers for CAIDA AS relationship and AS-to-organisation files."""

from __future__ import annotations

import bz2
import gzip
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

P2C = -1  # provider -> customer
P2P = 0  # peer <-> peer


def _open(path: Path):
    s = str(path)
    if s.endswith(".bz2"):
        return bz2.open(path, "rt", encoding="utf-8", errors="replace")
    if s.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "rt", encoding="utf-8", errors="replace")


@dataclass
class Topology:
    """AS graph. Edges are (a, b, rel) with rel P2C meaning a is b's provider."""

    asns: np.ndarray  # uint32 [N]
    src: np.ndarray  # int32 [E] node index
    dst: np.ndarray  # int32 [E] node index
    rel: np.ndarray  # int8 [E]
    source: str = "unknown"
    synthetic: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def n(self) -> int:
        return len(self.asns)

    @property
    def e(self) -> int:
        return len(self.src)


def parse_asrel(path: Path) -> Topology:
    """Parse ``<a>|<b>|<rel>[|<source>]`` lines (serial-1 and serial-2)."""
    a_list: list[int] = []
    b_list: list[int] = []
    r_list: list[int] = []
    with _open(path) as f:
        for line in f:
            if not line or line[0] == "#":
                continue
            parts = line.rstrip("\n").split("|")
            if len(parts) < 3:
                continue
            try:
                a, b, r = int(parts[0]), int(parts[1]), int(parts[2])
            except ValueError:
                continue
            a_list.append(a)
            b_list.append(b)
            r_list.append(r)
    a = np.asarray(a_list, dtype=np.uint32)
    b = np.asarray(b_list, dtype=np.uint32)
    asns, inv = np.unique(np.concatenate([a, b]), return_inverse=True)
    m = len(a)
    return Topology(
        asns=asns,
        src=inv[:m].astype(np.int32),
        dst=inv[m:].astype(np.int32),
        rel=np.asarray(r_list, dtype=np.int8),
        source=f"CAIDA AS relationships ({Path(path).name})",
    )


@dataclass
class OrgInfo:
    name: str
    org: str
    country: str


def parse_as2org(path: Path) -> dict[int, OrgInfo]:
    """Parse CAIDA as-org2info (two '# format:' sections)."""
    orgs: dict[str, tuple[str, str]] = {}
    auts: list[tuple[int, str, str]] = []
    mode = None
    with _open(path) as f:
        for line in f:
            if line.startswith("# format:"):
                mode = "org" if line.startswith("# format:org_id") else "aut"
                continue
            if not line or line[0] == "#":
                continue
            p = line.rstrip("\n").split("|")
            if mode == "org" and len(p) >= 4:
                orgs[p[0]] = (p[2], p[3])
            elif mode == "aut" and len(p) >= 4:
                try:
                    auts.append((int(p[0]), p[2], p[3]))
                except ValueError:
                    pass
    out: dict[int, OrgInfo] = {}
    for asn, name, org_id in auts:
        org_name, cc = orgs.get(org_id, ("", ""))
        out[asn] = OrgInfo(name=name, org=org_name, country=cc)
    return out
