// The apps sidebar's DOM (#apps in index.html): the rail that lists the apps,
// and the open app's panel, docked at the right on desktop (collapsible and
// resizable) and a bottom drawer on narrow screens (peek, half, full: drag
// the handle, or its buttons). The host (host.js) holds which app is open
// and whether its panel shows (`side`, in the permalink); this file only
// draws that, and tells main.js how much room it takes (CSS variables on
// :root, then onLayout) so the map and the cards reflow around it.

export const NARROW = '(max-width: 720px)'; // as main.js's layoutCards
const W_DEFAULT = 380;
const W_MIN = 280;
const W_MAX = 720;
const PEEK = 64; // px: the drawer's handle and header
const RAIL = 44; // the rail's pill, across
const GAP = 12;
const WIDTH_KEY = 'netmap.apps.width';

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: the width resets next time */
    }
  },
};

/**
 * @param {object} o
 * @param {HTMLElement} o.root #apps
 * @param {ReturnType<import('./host.js').createAppHost>} o.host
 * @param {(o: {raised: boolean}) => void} o.onLayout the room it takes changed
 *   (raised: the drawer just came up over half the screen)
 */
export function createSidebar({ root, host, onLayout }) {
  const $ = (s) => root.querySelector(s);
  const rail = $('.apps-rail');
  const body = $('.apps-body');
  const title = $('#appsTitle');
  const grip = $('.apps-grip');
  const handle = $('.apps-handle');
  const wait = $('.apps-wait');
  const mq = window.matchMedia(NARROW);
  let width = Number(store.get(WIDTH_KEY)) || W_DEFAULT;
  let drawer = 'half'; // the drawer's height while its panel shows: half | full
  let dragH = null; // the drawer's height while it's dragged, px
  let last = ''; // the room taken, as last reported
  let lastDrawer = 'none';

  // leave the map room for the controls card, the search and the details card
  const maxWidth = () => Math.max(W_MIN, Math.min(W_MAX, window.innerWidth - 700));
  const clampW = (w) => Math.max(W_MIN, Math.min(maxWidth(), Math.round(w)));
  const heights = () => {
    const H = window.innerHeight;
    return { peek: PEEK, half: Math.round(H * 0.5), full: Math.max(Math.round(H * 0.5), H - 56) };
  };

  for (const app of host.registry.list()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn apps-app';
    b.dataset.app = app.id;
    b.innerHTML = app.icon;
    b.title = `${app.title} (])`;
    b.setAttribute('aria-label', app.title);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => toggle(app.id, { focus: true }));
    rail.append(b);
  }

  /** The rail's button for an app: open it, or show / collapse its panel if it's open. */
  function toggle(id, { focus = false } = {}) {
    const s = host.state();
    if (s.app === id) host.setSide(!s.side);
    else host.open(id).then(() => focus && title.focus());
    if (focus && s.app === id && !s.side) title.focus();
  }

  function layout() {
    const s = host.state();
    const narrow = mq.matches;
    const hasApp = !!s.app;
    const docked = narrow ? hasApp : hasApp && s.side;
    const mode = !hasApp ? 'none' : !s.side ? 'peek' : drawer;
    root.classList.toggle('narrow', narrow);
    root.classList.toggle('has-app', hasApp);
    root.classList.toggle('docked', docked);
    root.classList.toggle('loading', s.loading);
    root.dataset.drawer = narrow ? mode : '';
    wait.hidden = !s.loading;
    const app = hasApp ? host.registry.get(s.app) : null;
    title.textContent = app ? app.title : '';
    for (const b of rail.children) {
      const on = b.dataset.app === s.app;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('collapsed', on && !s.side);
      b.title = `${host.registry.get(b.dataset.app).title}${on ? (s.side ? ' · collapse' : ' · show') : ''} (])`;
    }
    $('#appsCollapse').hidden = narrow;
    $('#appsUp').hidden = $('#appsDown').hidden = !narrow;
    $('#appsUp').disabled = narrow && mode === 'full';
    $('#appsDown').disabled = narrow && mode === 'peek';

    const H = heights();
    const drawerH = dragH ?? H[mode] ?? 0;
    const vars = narrow
      ? { '--side-w': '0px', '--side-gap': `${GAP}px`, '--apps-bottom': `${hasApp ? drawerH + 8 : GAP + RAIL + 8}px`, '--map-bottom': `${hasApp ? Math.min(H[mode] ?? 0, H.half) : 0}px` }
      : { '--side-w': `${docked ? clampW(width) : 0}px`, '--side-gap': `${docked ? GAP : GAP + RAIL + 8}px`, '--apps-bottom': `${GAP}px`, '--map-bottom': '0px' };
    root.style.height = narrow && hasApp ? `${drawerH}px` : '';
    grip.setAttribute('aria-valuenow', String(clampW(width)));
    grip.setAttribute('aria-valuemin', String(W_MIN));
    grip.setAttribute('aria-valuemax', String(maxWidth()));
    handle.setAttribute('aria-label', `Drawer height: ${mode}`);
    const css = document.documentElement.style;
    const key = JSON.stringify(vars);
    if (dragH !== null) return; // the map reflows once the drawer lands
    for (const [k, v] of Object.entries(vars)) css.setProperty(k, v);
    const raised = narrow && (mode === 'half' || mode === 'full') && !(lastDrawer === 'half' || lastDrawer === 'full');
    lastDrawer = narrow ? mode : 'none';
    if (key !== last || raised) {
      last = key;
      onLayout({ raised });
    }
  }

  // --- desktop: collapse, and resize by the grip -------------------------------
  $('#appsCollapse').addEventListener('click', () => {
    host.setSide(false);
    rail.querySelector(`[data-app="${host.state().app}"]`)?.focus();
  });
  $('#appsClose').addEventListener('click', () => {
    const id = host.state().app;
    host.close();
    rail.querySelector(`[data-app="${id}"]`)?.focus();
  });
  const setWidth = (w, save = false) => {
    width = clampW(w);
    if (save) store.set(WIDTH_KEY, String(width));
    layout();
  };
  let raf = 0;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    const move = (ev) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWidth(window.innerWidth - ev.clientX));
    };
    const up = () => {
      grip.classList.remove('dragging');
      grip.removeEventListener('pointermove', move);
      setWidth(width, true);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
  grip.addEventListener('dblclick', () => setWidth(W_DEFAULT, true));
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 24;
    const to = { ArrowLeft: width + step, ArrowRight: width - step, Home: W_MAX, End: W_MIN }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation(); // not the camera's arrow keys
    setWidth(to, true);
  });

  // --- narrow: the drawer's heights ---------------------------------------------
  const ORDER = ['peek', 'half', 'full'];
  const current = () => {
    const s = host.state();
    return !s.side ? 'peek' : drawer;
  };
  function setDrawer(mode) {
    if (mode === 'peek') {
      host.setSide(false);
    } else {
      drawer = mode;
      if (host.state().side) layout();
      else host.setSide(true);
    }
  }
  const step = (d) => setDrawer(ORDER[Math.max(0, Math.min(2, ORDER.indexOf(current()) + d))]);
  $('#appsUp').addEventListener('click', () => step(1));
  $('#appsDown').addEventListener('click', () => step(-1));
  handle.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    step(d);
  });
  // Drag the handle or the header (not its buttons). A tap on the handle
  // steps through the heights.
  const startDrag = (e) => {
    if (!mq.matches || !host.state().app || e.button > 0) return;
    if (e.target.closest('button') && e.target !== handle) return;
    const y0 = e.clientY;
    const h0 = root.getBoundingClientRect().height;
    let moved = false;
    let lastY = y0;
    let lastT = performance.now();
    let v = 0; // px/ms, up positive
    e.currentTarget.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
    const el = e.currentTarget;
    const move = (ev) => {
      if (Math.abs(ev.clientY - y0) > 4) moved = true;
      if (!moved) return;
      const t = performance.now();
      v = (lastY - ev.clientY) / Math.max(1, t - lastT);
      lastY = ev.clientY;
      lastT = t;
      const H = heights();
      dragH = Math.max(H.peek, Math.min(H.full, h0 + (y0 - ev.clientY)));
      layout();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      root.classList.remove('dragging');
      if (!moved) {
        dragH = null;
        if (el === handle) setDrawer(current() === 'full' ? 'peek' : ORDER[ORDER.indexOf(current()) + 1]);
        return;
      }
      const H = heights();
      const h = dragH + v * 180; // a flick carries on
      dragH = null;
      const near = ORDER.reduce((a, b) => (Math.abs(H[b] - h) < Math.abs(H[a] - h) ? b : a));
      setDrawer(near);
      layout();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  handle.addEventListener('pointerdown', startDrag);
  $('.apps-head').addEventListener('pointerdown', startDrag);

  host.onChange(layout);
  mq.addEventListener('change', layout);
  window.addEventListener('resize', layout);
  layout();

  return {
    layout,
    /** A fresh element for an app to mount into (host.js mountPoint). */
    mountPoint(app) {
      const el = document.createElement('div');
      el.className = `app app-${app.id}`;
      body.append(el);
      return el;
    },
    /** The ] key: show or collapse the open app's panel, or open the first app. */
    toggle() {
      const s = host.state();
      if (s.app) host.setSide(!s.side);
      else {
        const first = host.registry.list()[0];
        if (first) host.open(first.id);
      }
    },
    /** The room it takes now: { right, bottom } px over the map, and narrow. */
    room() {
      const s = getComputedStyle(document.documentElement);
      return { right: parseFloat(s.getPropertyValue('--side-w')) || 0, bottom: parseFloat(s.getPropertyValue('--map-bottom')) || 0, narrow: mq.matches };
    },
  };
}
