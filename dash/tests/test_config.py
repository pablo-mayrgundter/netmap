"""The config resolves with bizdash's own rules, and its parts agree with each
other and with the demo: every event the page asks about is labelled and has
synthetic data, and the demo's `requires` chains follow the funnel."""

import re
import subprocess
import sys

from bizdash.config import resolve

from conftest import ROOT, SITE

NETMAP_EVENTS = {"dataset_load", "permalink_open", "mode_change", "globe_toggle", "as_select", "search",
                 "route_trace", "orbits_toggle", "basemap_change", "renderer_change", "style_change",
                 "app_open", "app_close"}
# The event-scoped custom dimensions the page queries (plugins and the funnel).
QUERIED_PARAMS = {"app_id", "dataset_id", "mode", "asn", "result"}


def resolved(raw):
    cfg, errors, warnings = resolve(raw)
    assert errors == [] and warnings == [], (errors, warnings)
    return cfg


def test_bizdash_check_accepts_the_site():
    out = subprocess.run([sys.executable, "-m", "bizdash", "check", "--site", str(SITE)],
                         capture_output=True, text=True, cwd=ROOT)
    assert out.returncode == 0 and "config ok" in out.stdout, out.stderr
    assert out.stderr == ""                      # no unknown-key warnings either


def test_ids_are_empty_or_well_formed(raw_config):
    # Empty until the maintainer sets them (README); then the shapes GA and Google Identity expect.
    assert raw_config["propertyId"] == "" or re.fullmatch(r"\d+", raw_config["propertyId"])
    assert raw_config["clientId"] == "" or raw_config["clientId"].endswith(".apps.googleusercontent.com")


def test_every_netmap_event_is_labelled(raw_config):
    cfg = resolved(raw_config)
    assert set(cfg["events"]) == NETMAP_EVENTS
    assert all(e["label"] != name for name, e in cfg["events"].items())


def test_tiles_chart_and_funnel_name_labelled_events(raw_config):
    cfg = resolved(raw_config)
    used = {t["event"] for t in cfg["tiles"]} | {cfg["chart"]["secondary"]["event"]}
    for s in cfg["funnel"]["steps"]:
        used |= set(s["events"]) | set((s.get("fallback") or {}).get("events", []))
    used |= {b["pairEvent"] for b in cfg["breakdowns"] if b.get("pairEvent")}
    assert used <= set(cfg["events"])
    assert [t["event"] for t in cfg["tiles"]] == ["dataset_load", "as_select", "route_trace", "app_open"]
    assert cfg["chart"]["secondary"]["event"] in ("dataset_load", "as_select")


def test_the_funnel_is_netmaps(raw_config):
    steps = resolved(raw_config)["funnel"]["steps"]
    assert [s["events"] for s in steps] == [
        ["dataset_load"],
        ["mode_change", "globe_toggle", "orbits_toggle"],
        ["search", "as_select"],
        ["route_trace", "app_open"],
    ]
    found = steps[2]
    # Search counts only on a hit; until `result` is registered, the fallback counts selections.
    assert "customEvent:result" in str(found["filter"]) and found["fallback"]["events"] == ["as_select"]


def test_demo_covers_every_event_with_requires_in_funnel_order(raw_config):
    demo = raw_config["demo"]["events"]
    names = [e["name"] for e in demo]
    assert set(names) == NETMAP_EVENTS and len(names) == len(set(names))
    for i, e in enumerate(demo):
        assert 0 < e["rate"] <= 1, e
        if e.get("requires"):
            # The demo checks `requires` against events already fired in the session, in list order.
            assert e["requires"] in names[:i], f"{e['name']} requires {e['requires']}, which comes later"
        for k, vals in (e.get("params") or {}).items():
            assert vals and all(isinstance(v, str) for v in vals), (e["name"], k)   # Python/JS parity
    by = {e["name"]: e for e in demo}

    def chain(name):
        out = []
        while name:
            out.append(name)
            name = by[name].get("requires")
        return out
    # Each later funnel step is reached through the earlier ones.
    assert chain("mode_change")[-1] == "dataset_load"
    for n in ("globe_toggle", "orbits_toggle"):
        assert chain(n) == [n, "dataset_load"]
    assert chain("as_select") == ["as_select", "mode_change", "dataset_load"]
    assert chain("search") == ["search", "mode_change", "dataset_load"]
    assert chain("route_trace")[1] == "as_select" and chain("app_open")[1] == "as_select"


def test_demo_registers_every_dimension_the_page_queries(raw_config):
    params = set(raw_config["demo"].get("customDimensions", []))
    for e in raw_config["demo"]["events"]:
        params |= set(e.get("params") or {})
    assert QUERIED_PARAMS <= params


def test_demo_asns_are_numbers_and_more_than_twenty(raw_config):
    asns = next(e for e in raw_config["demo"]["events"] if e["name"] == "as_select")["params"]["asn"]
    assert all(a.isdigit() for a in asns) and len(set(asns)) > 20


def test_plugins_exist_and_links_point_at_netmap(raw_config):
    cfg = resolved(raw_config)
    for p in cfg["plugins"]:
        assert (SITE / p).is_file(), p
    urls = [x["url"] for x in cfg["links"]["extra"]]
    assert "https://pablo-mayrgundter.github.io/netmap/" in urls
    assert "{propertyId}" in cfg["links"]["ga"]
    assert cfg["traffic"]["siteHosts"] == [cfg["demo"]["siteHost"]] == ["pablo-mayrgundter.github.io"]
