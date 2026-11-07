// Test fixtures: a tiny graph (data.js's bundle, as far as apps read it), a
// bridge (main.js's side of the host) that records what it's asked, and
// mount points. Used by host.test.js and starlink's tests.

export function fakeGraph(id = 'tiny') {
  // 0 AS14593 Starlink; 1 AS3356 its provider; 2 AS714 a peer; 3 AS999 its customer; 4 AS1 nobody's
  const asn = [14593, 3356, 714, 999, 1];
  const names = ['Space Exploration Technologies Corporation', 'Level 3', 'Apple', 'Small ISP', 'Lonely'];
  const edges = [1, 0, 0, 2, 0, 3];
  const edge_rel = [-1, 0, -1];
  const n = asn.length;
  const adj = Array.from({ length: n }, () => []);
  for (let k = 0; k < edge_rel.length; k++) {
    adj[edges[2 * k]].push({ node: edges[2 * k + 1], edge: k });
    adj[edges[2 * k + 1]].push({ node: edges[2 * k], edge: k });
  }
  const degree = adj.map((a) => a.length);
  degree[1] = 500; // a big provider
  return {
    id,
    root: `/data/${id}`,
    meta: { name: id, kind: 'as', synthetic: false, counts: { nodes: n, edges: 3 }, generated: '2026-11-01T00:00:00+00:00', regions: [{ name: 'North America' }] },
    n,
    asn,
    names,
    edges,
    edge_rel,
    degree,
    level: [0.7, 0.95, 0.9, 0.2, 0.1],
    region: [0, 0, 0, 0, 0],
    flags: [1, 1, 1, 1, 0],
    byAsn: new Map(asn.map((a, i) => [a, i])),
    neighbours: (i) => adj[i],
    info: async (i) => ({ asn: asn[i], name: names[i], cone: i === 0 ? 2 : 1, coreness: 3, rank: 100 + i, providers: 1, customers: 1, peers: 1, country: 'US' }),
  };
}

export function fakeBridge(over = {}) {
  const calls = [];
  const rec = (name) => (...a) => calls.push([name, ...a]);
  const b = {
    calls,
    G: null,
    sel: { explore: null, selected: null },
    viewState: { view: 'globe', mode: 'geo', morph: 1, geographic: true, camera: { lon: 0, lat: 0, zoom: 2 } },
    graph: () => b.G,
    dataBase: '/data',
    position: (i) => [i, i, 0],
    select: (i) => {
      b.sel.explore = i;
      calls.push(['select', i]);
    },
    flyToNode: rec('flyToNode'),
    flyTo: rec('flyTo'),
    fitBounds: rec('fitBounds'),
    setRoute: rec('setRoute'),
    view: () => b.viewState,
    setView: rec('setView'),
    selection: () => b.sel,
    orbits: () => null,
    clock: () => ({ now: () => 1_700_000_000_000, live: false }),
    redraw: rec('redraw'),
    writeHash: rec('writeHash'),
    notice: rec('notice'),
    track: rec('track'),
    ...over,
  };
  return b;
}

export function mountPoints() {
  const made = [];
  const mountPoint = (app) => {
    const el = { app: app.id, textContent: '', innerHTML: '', removed: false, remove() { this.removed = true; } };
    made.push(el);
    return el;
  };
  return { made, mountPoint };
}
