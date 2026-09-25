// scripts/verify/helpers.mjs — browser-global stand-ins shared by the client-side check
// modules (clientLib, saver, store, sync). Not loaded by the runner's module loop.

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
