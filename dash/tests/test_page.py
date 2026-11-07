"""The built site in Chromium with ?demo=1 (bizdash's synthetic Data API, shaped
by the config's demo section): no credentials and no network."""

import copy
import re

import pytest

pytestmark = pytest.mark.browser

CORE = ["users", "sessions", "secondary", "chart", "realtime", "breakdown:sources", "breakdown:countries",
        "funnel", "spikes", "traffic"]
TILES = ["tile:dataset_load", "tile:as_select", "tile:route_trace", "tile:app_open"]
PLUGINS = ["netmap-consent-note", "netmap-apps", "netmap-datasets-modes", "netmap-top-ases"]


def card(page, cid):
    return page.locator("#card-" + re.sub(r"[^a-z0-9_-]", "-", cid, flags=re.I))   # as bizdash names frames


def test_the_dashboard_shows_netmaps_events_funnel_and_cards(open_page, site_url):
    page = open_page(f"{site_url}/index.html?demo=1")
    assert page.text_content("#title") == "netmap"
    order = page.evaluate("bizdash.dash.ordered()")
    assert set(CORE + TILES + PLUGINS) <= set(order)
    assert order[0] == "netmap-consent-note"
    assert order[order.index("funnel") + 1:order.index("funnel") + 4] == PLUGINS[1:]
    assert page.locator(".card-error").count() == 0
    assert page.text_content("#notice").strip() == ""

    assert "Map loads" in card(page, "secondary").text_content()
    for tid, label in zip(TILES, ["Loaded a map", "Selected an AS", "Traced a route", "Opened an app"]):
        text = card(page, tid).text_content()
        assert label in text and re.search(r"\d", text), tid

    funnel = card(page, "funnel").text_content()
    for label in ["Visitors", "Loaded a map", "Changed mode, globe or orbits",
                  "Found an AS (search hit or selection)", "Traced a route or opened an app"]:
        assert label in funnel
    totals = page.evaluate("""() => {
      const d = bizdash.dash.cards.get('funnel').data;
      return (d.segments ? d.segments.all : d).stages.map(s => s.total);
    }""")
    assert all(isinstance(t, (int, float)) and t > 0 for t in totals), totals
    # The demo's requires chains nest each step in the one before it.
    assert totals[0] >= totals[1] >= totals[2] >= totals[3] >= totals[4] and totals[1] > totals[4]

    assert "starlink" in card(page, "netmap-apps").text_content()
    dm = card(page, "netmap-datasets-modes").text_content()
    assert "internet" in dm and "routers" in dm and "cyber" in dm and "geo" in dm
    links = page.eval_on_selector_all("#card-netmap-top-ases a.asn", "as => as.map(a => [a.textContent, a.href])")
    assert len(links) == 20
    for text, href in links:
        asn = text.removeprefix("AS")
        assert href == f"https://pablo-mayrgundter.github.io/netmap/#sel={asn}"
    assert "lower bound" in card(page, "netmap-consent-note").text_content()

    snap = page.evaluate("bizdash.dash.snapshot()")
    assert "## Top ASes selected" in snap and "opt-in" in snap


def test_the_segment_control_switches_plugin_cards_without_a_request(open_page, site_url):
    page = open_page(f"{site_url}/index.html?demo=1")
    before = page.evaluate("bizdash.ga.stats.requests")
    page.click("#segmentToggle button[data-segment='all']")
    assert page.evaluate("bizdash.ga.stats.requests") == before
    for cid in PLUGINS[1:]:
        assert card(page, cid).locator(".seg-sub").text_content() == "Traffic filter: All"


def test_phone_width_has_no_horizontal_scroll(open_page, site_url):
    page = open_page(f"{site_url}/index.html?demo=1", width=390)
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    assert card(page, "netmap-top-ases").locator(".hbar-row").count() == 20


def test_unregistered_dimensions_are_explained_and_the_funnel_falls_back(open_page, build, raw_config):
    # As in GA before the custom dimensions are registered: drop the params the
    # page queries from the demo, so asking for them is a 400.
    cfg = copy.deepcopy(raw_config)
    for e in cfg["demo"]["events"]:
        for k in ("app_id", "asn", "mode", "dataset_id", "result"):
            (e.get("params") or {}).pop(k, None)
    page = open_page(f"{build(cfg)}/index.html?demo=1")
    assert "no custom dimension app_id yet" in card(page, "netmap-apps").text_content()
    assert "no custom dimension asn yet" in card(page, "netmap-top-ases").text_content()
    assert "Register it" in card(page, "netmap-datasets-modes").text_content()
    assert "register the custom dimension result" in card(page, "funnel").text_content()
    page.errors.clear()   # the refused requests are logged by design


def test_the_live_page_asks_viewers_to_sign_in(browser, site_url):
    """With the property and client IDs set, the live page (no ?demo=1) waits
    for each viewer's own Google sign-in instead of saying it's unconfigured."""
    ctx = browser.new_context()
    page = ctx.new_page()
    page.goto(f"{site_url}/index.html")
    page.wait_for_function("document.getElementById('liveNote').textContent.includes('sign in')")
    assert page.locator("#signin").is_visible()
    assert "no Google OAuth client ID" not in page.locator("#notice").inner_text()
    ctx.close()
