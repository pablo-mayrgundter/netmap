// The app registry: the apps the sidebar lists (README in this folder).
// DOM-free, so node's tests import it.
//
// An app is { id, title, icon, mount(el, ctx), unmount(), onHash?(params) }.
// A registry entry may instead carry `load: () => import('./x/app.js')`,
// which resolves to a module whose default export (or the module itself)
// has mount, unmount and onHash. The sidebar shows the id, title and icon
// at once, and the code loads when the app is first opened.

// The id names the app in the permalink (app=<id>) and prefixes its own
// hash params (<id>.<key>), so it can't hold a dot or anything a URL
// would escape.
export const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function validateApp(app) {
  if (!app || typeof app !== 'object') throw new TypeError('an app is an object');
  if (typeof app.id !== 'string' || !APP_ID.test(app.id)) throw new TypeError(`app id ${JSON.stringify(app?.id)}: lowercase letters, digits and dashes, starting with a letter`);
  if (typeof app.title !== 'string' || !app.title.trim()) throw new TypeError(`app ${app.id}: a title`);
  if (typeof app.icon !== 'string' || !app.icon.includes('<svg')) throw new TypeError(`app ${app.id}: an icon, as inline SVG markup`);
  const eager = typeof app.mount === 'function';
  if (!eager && typeof app.load !== 'function') throw new TypeError(`app ${app.id}: mount(el, ctx), or load() for its code`);
  if (eager && typeof app.unmount !== 'function') throw new TypeError(`app ${app.id}: unmount()`);
  if (app.onHash !== undefined && typeof app.onHash !== 'function') throw new TypeError(`app ${app.id}: onHash is a function`);
  return app;
}

/** A module from load() as an app's methods: its default export, or itself. */
export function appModule(mod, id) {
  const m = mod && typeof mod.default === 'object' && mod.default ? mod.default : mod;
  if (!m || typeof m.mount !== 'function' || typeof m.unmount !== 'function') throw new TypeError(`app ${id}: its module has no mount and unmount`);
  if (m.onHash !== undefined && typeof m.onHash !== 'function') throw new TypeError(`app ${id}: onHash is a function`);
  return m;
}

export function createRegistry(apps = []) {
  const byId = new Map();
  const resolved = new Map(); // id -> Promise of the full app
  const reg = {
    register(app) {
      validateApp(app);
      if (byId.has(app.id)) throw new Error(`app ${app.id} is registered already`);
      byId.set(app.id, app);
      return reg;
    },
    has: (id) => byId.has(id),
    get: (id) => byId.get(id) ?? null,
    /** Every app, in the order registered: { id, title, icon } and the rest. */
    list: () => [...byId.values()],
    /**
     * The app with its code, loaded once: { id, title, icon, mount, unmount,
     * onHash? }. Rejects for an id that isn't registered, or a module that
     * isn't an app; a failed load is tried again next time.
     */
    resolve(id) {
      const app = byId.get(id);
      if (!app) return Promise.reject(new Error(`no app ${id}`));
      if (!resolved.has(id)) {
        const p = typeof app.mount === 'function'
          ? Promise.resolve(app)
          : Promise.resolve().then(() => app.load()).then((mod) => ({ ...app, ...appModule(mod, id) }));
        p.catch(() => resolved.delete(id));
        resolved.set(id, p);
      }
      return resolved.get(id);
    },
  };
  for (const a of apps) reg.register(a);
  return reg;
}
