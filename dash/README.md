# netmap's dashboard

netmap's bizdev dashboard, at
[pablo-mayrgundter.github.io/netmap/dash/](https://pablo-mayrgundter.github.io/netmap/dash/)
(`?demo=1` for synthetic data, no sign-in): who uses the map, how they found
it, and how far they get, from netmap's Google Analytics 4 property. It is a
deployment of [bizdash](https://github.com/pablo-mayrgundter/bizdash): this
directory holds only netmap's config and cards, built on a pinned bizdash
release by netmap's own Pages workflow.

```
dash/site/bizdash.config.json   property, OAuth client, netmap's events, tiles, funnel, demo data
dash/site/plugins/              netmap's cards (below)
dash/tests/                     pytest (config, page) and node:test (plugins)
```

`pages.yml` builds it into the site at `dash/` next to the viewer, and
`preview.yml` into each PR preview; `ci.yml`'s `dash` job checks the config
and runs the tests.

It reads netmap's GA4 property (`563081056`, web stream `G-3PWPNFW02J`):
each viewer signs in with their own Google account, which needs access to the
property. `?demo=1` shows synthetic, netmap-shaped traffic with no sign-in.

**GA only sees viewers who opted in.** netmap's analytics are off until a
viewer clicks *Allow analytics*, and browsers with Do Not Track or Global
Privacy Control are never asked (netmap's README, "Analytics"). Every count
here is a lower bound on real use; compare shapes and trends rather than
totals. The dashboard says so in a note above the tiles and under the chart.

## What it shows

- **Tiles:** users, sessions, map loads (events, the chart's right axis),
  and people who *loaded a map*, *selected an AS*, *traced a route* and
  *opened an app*.
- **Chart:** active users per hour with spike detection, and `dataset_load`
  on the right axis.
- **Breakdowns:** users by source, and map loads + users by country.
- **Funnel by first channel:** visit → loaded a map (`dataset_load`) →
  changed mode, globe or orbits (`mode_change` / `globe_toggle` /
  `orbits_toggle`) → found an AS (`search` with `result=hit`, or
  `as_select`) → traced a route or opened an app (`route_trace` /
  `app_open`). Until the `result` dimension is registered, the "found" step
  counts `as_select` only and says so.
- **Cards** (`dash/site/plugins/`):
  - *Apps*: `app_open` by `app_id`, opens and people.
  - *Datasets and modes*: `dataset_load` by `dataset_id`, `mode_change` by
    `mode`.
  - *Top ASes selected*: `as_select` by `asn`, top 20, each linking to
    netmap with that AS selected (`#sel=<asn>`).
  - A note on opt-in consent.

  The cards follow the traffic filter, and a card whose custom dimension
  isn't registered yet says which one to register instead of failing.
- **Realtime, detected spikes, non-standard traffic** (hits on any host but
  `pablo-mayrgundter.github.io`, such as a local build with `?ga_debug=1`).

A breakdown by page is left out on purpose: netmap sends its page as origin
and path only (the hash holds the view), so it would be one bar. Breakdowns
by `customEvent:app_id`, `mode` or `dataset_id` are also left out of the core
breakdowns: those count people across *all* events, so "(not set)" would
top every list. The cards above count each one on its own event.

## Setting the property and client IDs

Both go in `dash/site/bizdash.config.json` (`propertyId` is `563081056`;
`clientId` is `632925268159-urtgf3usptbtik25k9d2ub4a8eg7vtbf.apps.googleusercontent.com`). Neither is a secret: the client ID is public by design, and data
access is whatever GA grants each viewer's own Google account.

1. **GA4 property.** Done: netmap's property is `563081056`, and its web
   stream `G-3PWPNFW02J` is the one netmap's Pages build tags the site with.
   (For another property, copy its numeric **property ID** from *Admin →
   Property details*.)
2. **Google Cloud project** (any): *APIs & Services → Library* → enable the
   **Google Analytics Data API**.
3. **OAuth client:** *APIs & Services → Credentials → Create credentials →
   OAuth client ID → Web application*. Authorized JavaScript origins:
   `https://pablo-mayrgundter.github.io` and `http://localhost:8080`. No
   redirect URIs.
4. **Consent screen:** *Internal* on Workspace; otherwise *External*, with
   the people who will use the dashboard as test users. Scope:
   `.../auth/analytics.readonly`.
5. Put both in the config, and give each viewer (at least) *Viewer* access to
   the property in GA.

To try IDs without committing them: `?property=…&client_id=…` (remembered in
that browser). Once data flows, set each event's `since` (YYYY-MM-DD, the day
netmap started sending it) in `events`, so the hours before read as unknown
rather than zero.

## Custom dimensions to register in GA

GA reports an event parameter only after it is registered: *Admin → Custom
definitions → Create custom dimension*, scope **Event**, the parameter name
as the dimension name. It counts from registration on, not retroactively, so
register early. From netmap's README, "Analytics":

| needed by this dashboard | event |
|---|---|
| `app_id` | `app_open`, `app_close` (Apps card) |
| `dataset_id` | `dataset_load`, `permalink_open` (Datasets and modes) |
| `mode` | `mode_change` (Datasets and modes) |
| `asn` | `as_select` (Top ASes selected) |
| `result` | `search` (funnel: search hits) |

Worth registering for exploring in GA: `view` (on every event:
`mode:view:dataset`), `kind`, `nodes`, `trigger`, `from`, `via`, `to`, `how`,
`role`, `source`, `found`, `layer`, `on`, `has_route`, `has_sel`,
`has_camera`, `basemap`, `renderer`, `control`. The numeric ones (`load_ms`,
`q_len`, `results`, `rank`, `waypoints`, `hops`) are custom **metrics**
(*Create custom metric*, scope Event; `load_ms` in milliseconds). A standard
property allows 50 event-scoped custom dimensions and 50 custom metrics.

## Bumping bizdash

bizdash is pinned by one ref, `BIZDASH_REF`, in netmap's `pages.yml`,
`preview.yml` and `ci.yml`, now `v0.1.1`. To move to a newer release
(or a release candidate's commit SHA), change it in all three:

```sh
sed -i 's/BIZDASH_REF: v0.1.1/BIZDASH_REF: v0.2.0/' .github/workflows/*.yml
```

Read bizdash's CHANGELOG for config or plugin API changes, run the tests
locally against the new release, and open a PR: its preview shows the result.

## Local development

From the repository root:

```sh
python -m venv .venv && . .venv/bin/activate
pip install "git+https://github.com/pablo-mayrgundter/bizdash@v0.1.1"
python -m bizdash serve --demo --site dash/site          # http://127.0.0.1:5077, synthetic data
```

Or build the static site exactly as the deploy does and serve it:

```sh
python -m bizdash build --site dash/site --out _site
python -m http.server -d _site 8080                 # http://localhost:8080/?demo=1
```

The demo data comes from the config's `demo` section: netmap's events at
plausible rates, with `requires` chains that follow the funnel (a map load
before any view change, a mode change before a search or selection, a
selection before a route or an app), and parameters (datasets, modes, ASNs,
`app_id`) shaped like netmap's.

**Tests:**

```sh
pip install pytest playwright && python -m playwright install chromium
python -m bizdash check --site dash/site     # the config, with bizdash's rules
python -m pytest dash                     # config, plugin units (node), the page in Chromium
```

`node --test dash/tests/js/*.test.mjs` runs the plugin unit tests alone (Node 20
or later).

**A new card** is an ES module in `dash/site/plugins/`, listed in `plugins` in
the config; bizdash's README, "Plugins", has the API. `dash/site/plugins/lib.js`
holds the event-by-parameter query the netmap cards share.
