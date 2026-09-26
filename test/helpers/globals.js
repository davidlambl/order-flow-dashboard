// test/helpers/globals.js — browser-global stand-ins (storage, window, timers) for the client-side tests that
// run without a DOM (the node project's src/**/*.node.test.js).

/** A Map-backed Storage stand-in; with `full`, every setItem throws the browser's quota error. */
export function memoryStorage({ full = false } = {}) {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => {
      if (full) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError', code: 22 });
      map.set(String(k), String(v));
    },
    removeItem: (k) => { map.delete(String(k)); },
  };
}

/**
 * Runs fn with the named globals replaced (a value of undefined removes the global) and console.warn
 * captured into the array fn receives. Globals and console.warn are restored afterwards, pass or fail.
 */
export async function withGlobals(overrides, fn) {
  const saved = Object.keys(overrides).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    return await fn(warnings);
  } finally {
    console.warn = originalWarn;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/**
 * A minimal `window` stand-in: addEventListener/removeEventListener/dispatchEvent with the
 * dispatched events recorded in `events`. `CustomEvent` is Node's global.
 */
export function fakeWindow() {
  const listeners = new Map();
  const events = [];
  return {
    events,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) {
      events.push(event);
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      return true;
    },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
  };
}

/** Wait for queued microtasks and one macrotask, so async write queues settle. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A fake clock for injectable timers and `now`. setTimeout / setInterval queue callbacks, the clear functions
 * remove them, and advance(ms) runs what falls due in time order (an interval re-arms before it runs) and
 * moves the clock on. A callback that starts async work needs an `await settle()` before its effects show.
 * `pending()` lists the live timers soonest first as { in: ms until due, every: the interval's period or 0 }.
 * @param {number} [start=0] the initial `now()` in ms since the epoch
 */
export function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = [];
  const add = (fn, ms, every) => {
    const id = nextId++;
    timers.push({ id, fn, at: now + Math.max(0, Number(ms) || 0), every });
    return id;
  };
  const clear = (id) => {
    const i = timers.findIndex((timer) => timer.id === id);
    if (i !== -1) timers.splice(i, 1);
  };
  const byDue = (a, b) => a.at - b.at || a.id - b.id;
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: clear,
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 0)),
    clearInterval: clear,
    advance(ms) {
      const until = now + ms;
      for (;;) {
        timers.sort(byDue);
        const timer = timers[0];
        if (!timer || timer.at > until) break;
        now = timer.at;
        if (timer.every) timer.at += timer.every;
        else timers.shift();
        timer.fn();
      }
      now = until;
    },
    pending: () => [...timers].sort(byDue).map((timer) => ({ in: timer.at - now, every: timer.every })),
    get queued() { return timers.length; },
  };
}
