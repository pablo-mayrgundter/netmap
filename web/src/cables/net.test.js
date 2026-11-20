import test from 'node:test';
import assert from 'node:assert/strict';
import { CITIES, CABLES } from './data.js';
import { buildCableNet, routeFibers, layoutLanes, maxLanesAt, minCountAt, nearestNode, gcKm, lineColour, LINE_COLOURS } from './net.js';

const net = buildCableNet();
const at = (key) => {
  const c = CITIES[key];
  return [c[1], c[2], 0];
};
const fiber = (a, b, count = 1) => ({ source: at(a), target: at(b), count });
const corridor = (a, b) => {
  const i = net.nodeIndex.get(a), j = net.nodeIndex.get(b);
  return net.corridors.find((c) => (c.a === i && c.b === j) || (c.a === j && c.b === i));
};

test('every cable names known cities, and the network is one piece', () => {
  for (const c of CABLES) for (const br of c.paths || [c.path]) for (const w of br) if (typeof w === 'string') assert.ok(CITIES[w], `${c.name}: ${w}`);
  const seen = new Uint8Array(net.nodes.length);
  const stack = [0];
  seen[0] = 1;
  while (stack.length) {
    const u = stack.pop();
    for (const c of net.adj[u]) {
      const v = net.corridors[c].a === u ? net.corridors[c].b : net.corridors[c].a;
      if (!seen[v]) seen[v] = 1, stack.push(v);
    }
  }
  assert.deepEqual(net.nodes.filter((_, i) => !seen[i]).map((n) => n.key), []);
});

test('cables between the same two stations share one corridor', () => {
  const c = corridor('shirley', 'bude');
  assert.ok(c);
  for (const name of ['Grace Hopper', 'AC-2 (Yellow)', 'Apollo']) assert.ok(c.cables.includes(name), name);
  assert.equal(c.kind, 'sub');
});

test('a branch that splits off at sea runs from the trunk station before the split', () => {
  // Grace Hopper: New York (Shirley) -> Bude, with a branch to Bilbao off the trunk at sea
  const c = corridor('shirley', 'bio');
  assert.ok(c?.cables.includes('Grace Hopper'));
  // and one that rejoins a trunk at sea goes on to its next station (FASTER: Shima -> Pacific City)
  assert.ok(corridor('shima', 'pcity')?.cables.includes('FASTER'));
});

test('corridor paths start and end at their stations, with no jump across the antimeridian', () => {
  for (const c of net.corridors) {
    const a = net.nodes[c.a], b = net.nodes[c.b];
    const p0 = c.path[0], p1 = c.path[c.path.length - 1];
    assert.ok(gcKm(p0, [a.lon, a.lat]) < 1, `${c.cables} start`);
    assert.ok(gcKm(p1, [b.lon, b.lat]) < 1, `${c.cables} end`);
    for (let i = 1; i < c.path.length; i++) assert.ok(Math.abs(c.path[i][0] - c.path[i - 1][0]) < 10, `${c.cables} lon step`);
  }
});

test('nearestNode snaps to the closest station', () => {
  const { node, km } = nearestNode(net, -74.1, 40.7);
  assert.equal(net.nodes[node].key, 'nyc');
  assert.ok(km < 20);
});

test('fibers are routed over the cables, and implausible ones are not', () => {
  const fibers = [fiber('nyc', 'lon', 5), fiber('la', 'tyo', 3), fiber('fra', 'fra'), { source: [-140, -50, 0], target: [0, 0, 0], count: 1 }];
  const r = routeFibers(net, fibers);
  assert.equal(net.nodes[r[0].from].key, 'nyc');
  assert.equal(net.nodes[r[0].to].key, 'lon');
  assert.ok(r[0].steps.some((s) => net.corridors[s.c].kind === 'sub'), 'crosses the Atlantic on a submarine cable');
  // steps chain from source to target
  for (const route of [r[0], r[1]]) {
    for (let k = 0; k < route.steps.length; k++) {
      const c = net.corridors[route.steps[k].c];
      const [u, v] = route.steps[k].fwd ? [c.a, c.b] : [c.b, c.a];
      assert.equal(u, route.nodes[k]);
      assert.equal(v, route.nodes[k + 1]);
    }
  }
  assert.equal(r[2], null, 'both ends at one station');
  assert.equal(r[3], null, 'an end far from any station');
});

test('lanes: biggest fibers first, each drawn end to end or not at all, within the lane limit', () => {
  const pairs = [['nyc', 'lon'], ['ash', 'lon'], ['bos', 'par'], ['nyc', 'ams'], ['shirley', 'bude'], ['nyc', 'fra'], ['wall', 'lon']];
  const fibers = pairs.map(([a, b], i) => fiber(a, b, 100 - i));
  const routes = routeFibers(net, fibers);
  const L = layoutLanes(net, fibers, routes, 3);
  const trunk = corridor('shirley', 'bude').id;
  assert.ok(L.lanes[trunk].length <= 3);
  assert.ok(L.overflow[trunk] > 0);
  assert.equal(L.width[trunk], L.lanes[trunk].length);
  assert.equal(L.drawn[0], 1, 'the biggest fiber is drawn');
  for (let i = 0; i < fibers.length; i++) {
    if (!routes[i]) continue;
    for (const s of routes[i].steps) {
      const has = L.lanes[s.c].some((l) => l.fiber === i);
      assert.equal(has, !!L.drawn[i], `fiber ${i} on corridor ${s.c}`);
    }
  }
  // offsets are centred: lanes plus the grey one span -(n-1)/2 .. (n-1)/2
  const offs = L.lanes[trunk].map((l) => l.offset);
  assert.equal(offs[0], -(L.width[trunk] - 1) / 2);
  assert.ok(L.nodeWidth[net.nodeIndex.get('bude')] >= L.width[trunk]);
});

test('lanes are ordered by the side a fiber comes from and goes to', () => {
  // Two fibers out of London that share trunks and part ways in France.
  const fibers = [fiber('lon', 'bcn', 2), fiber('lon', 'gen', 1)];
  const routes = routeFibers(net, fibers);
  const L = layoutLanes(net, fibers, routes, 8);
  for (const lanes of L.lanes) {
    const offs = lanes.map((l) => l.offset);
    assert.deepEqual(offs, offs.slice().sort((x, y) => x - y));
  }
});

test('small fibers stay off the cables until you zoom in', () => {
  const fibers = [fiber('nyc', 'lon', 500), fiber('nyc', 'ams', 20), fiber('ash', 'par', 3)];
  const routes = routeFibers(net, fibers);
  const far = layoutLanes(net, fibers, routes, 48, minCountAt(1.6, 500));
  assert.deepEqual([...far.drawn], [1, 0, 0]);
  const near = layoutLanes(net, fibers, routes, 48, minCountAt(5, 500));
  assert.deepEqual([...near.drawn], [1, 1, 1]);
  assert.ok(minCountAt(2.5, 500) < minCountAt(1.6, 500));
  assert.equal(minCountAt(10, 500), 2);
});

test('more lanes as you zoom in, from a CWDM link to a subway trunk', () => {
  assert.equal(maxLanesAt(0), 4);
  assert.ok(maxLanesAt(1.6) >= 6 && maxLanesAt(1.6) <= 8);
  assert.ok(maxLanesAt(5) > maxLanesAt(3));
  assert.equal(maxLanesAt(20), 48);
});

test('a fiber keeps its colour', () => {
  const f = fiber('nyc', 'lon');
  assert.deepEqual(lineColour(f), lineColour({ ...f, count: 9 }));
  assert.ok(LINE_COLOURS.includes(lineColour(f)));
});
