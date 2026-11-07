// src/lib/lazyWithPreload.test.jsx — lazyWithPreload under React 19 in jsdom: a lazy suspends until its module is in,
// then renders it directly, in the same render, wherever it mounts next (React.lazy alone suspends on every new type's
// first render); an instance that mounted through the pending import keeps that type; one import however many
// instances, renders, retries and preload() calls; a failed import is a ChunkLoadError, shown once per import rather
// than retried in a loop, and not final; preload() never rejects; preloadAll(), which the setup runs before this
// file's first test, and resetLazies(), which it runs between the tests of a file that opted out; scheduleIdlePreload()
// on an injected host. The lazies live in this file (each test makes its own, on a loader it settles by hand), with
// plain Suspense and a minimal boundary around them: ChunkBoundary has its own file. Every import is driven by a
// deferred inside act, except where a test says why it runs on React's scheduler.
import { Component, StrictMode, Suspense, createRef, startTransition, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChunkLoadError, isChunkLoadError, lazyWithPreload, preloadAll, resetLazies, scheduleIdlePreload,
} from './lazyWithPreload.js';
import { deferred } from '../test/lazy.js';

// Created at import, like a component module's lazy: the setup loads it before the first test.
const DataSourceNote = lazyWithPreload(() => import('../components/dashboard/DataSourceNote.js'));

function Hello({ name = 'world' }) {
  return <p>hello {name}</p>;
}

function Released() {
  return <p>released</p>;
}

/** Every importer's release, run after each test, so no lazy of this file waits on an import nobody will settle. */
const releases = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

/**
 * A loader settled by hand: each call is one import, `imports[i]` the i-th, settled with resolve({ default }) or
 * reject(error). After its test, what is still pending resolves, and later imports resolve at once: preloadAll() and
 * the idle preload, which reach every lazy made so far, never wait on another test's import.
 */
function importer() {
  const imports = [];
  let released = false;
  const load = vi.fn(() => {
    if (released) return Promise.resolve({ default: Released });
    const d = deferred();
    imports.push(d);
    return d.promise;
  });
  releases.push(() => {
    released = true;
    for (const d of imports) d.resolve({ default: Released });
  });
  return { load, imports };
}

/** Catches what its children throw and names it: a stand-in for the boundary above a lazy part. */
class Catch extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    return error ? <p role="alert">{error.name}: {error.message}</p> : this.props.children;
  }
}

/** A child with state of its own and a count of its mounts, to see whether a re-render remounted it. */
function counter() {
  const mounts = { count: 0 };
  function Counter({ label }) {
    const [clicks, setClicks] = useState(0);
    useEffect(() => {
      mounts.count += 1;
    }, []);
    return <button type="button" onClick={() => setClicks((n) => n + 1)}>{label} {clicks}</button>;
  }
  return { Counter, mounts };
}

const resolveWith = (d, component) => act(async () => d.resolve({ default: component }));

describe('the setup preload', () => {
  it('has loaded a lazy created at import before the first test: it renders in the same act as render()', () => {
    render(
      <Suspense fallback={<p>loading</p>}>
        <DataSourceNote usingMock provider={undefined} />
      </Suspense>,
    );

    expect(screen.getByText(/Currently showing simulated demo data/)).toBeInTheDocument();
    expect(screen.queryByText('loading')).toBeNull();
  });
});

describe('before the module is in', () => {
  it('suspends to the nearest Suspense fallback, then renders the component once its import resolves', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);

    render(
      <>
        <p>beside</p>
        <Suspense fallback={<p>loading</p>}><Lazy name="lazy" /></Suspense>
      </>,
    );
    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(screen.getByText('beside')).toBeVisible();
    expect(load).toHaveBeenCalledTimes(1);

    await resolveWith(imports[0], Hello);
    expect(screen.getByText('hello lazy')).toBeInTheDocument();
    expect(screen.queryByText('loading')).toBeNull();
  });

  it('imports once for every instance, render and preload() while the import is pending', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);

    const view = render(
      <Suspense fallback={<p>loading</p>}>
        <Lazy name="one" />
        <Lazy name="two" />
      </Suspense>,
    );
    void Lazy.preload();
    void Lazy.preload();
    view.rerender(
      <Suspense fallback={<p>loading</p>}>
        <Lazy name="one" />
        <Lazy name="two" />
        <Lazy name="three" />
      </Suspense>,
    );
    expect(load).toHaveBeenCalledTimes(1);

    await resolveWith(imports[0], Hello);
    expect(screen.getAllByText(/^hello /).map((p) => p.textContent)).toEqual(['hello one', 'hello two', 'hello three']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  // React keeps nothing of an instance that suspended before its first commit: each retry mounts it again and runs its
  // state initializer again. The import has to belong to the lazy, or every retry would start one.
  it('imports once however many times React retries the suspended mount', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);
    const tree = (n) => (
      <Suspense fallback={<p>loading</p>}>
        <p>render {n}</p>
        <Lazy name="retried" />
      </Suspense>
    );

    const view = render(tree(0));
    for (let n = 1; n <= 3; n += 1) view.rerender(tree(n));
    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);

    await resolveWith(imports[0], Hello);
    expect(screen.getByText('hello retried')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('StrictMode renders it twice over and still imports once', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);

    render(
      <StrictMode>
        <Suspense fallback={<p>loading</p>}><Lazy name="strict" /></Suspense>
      </StrictMode>,
    );
    expect(load).toHaveBeenCalledTimes(1);

    await resolveWith(imports[0], Hello);
    expect(screen.getByText('hello strict')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('an instance mounted while the import was pending mounts the component once and keeps its state', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);
    const { Counter, mounts } = counter();
    const tree = (label) => <Suspense fallback={<p>loading</p>}><Lazy label={label} /></Suspense>;

    const view = render(tree('a'));
    await resolveWith(imports[0], Counter);
    fireEvent.click(screen.getByRole('button', { name: 'a 0' }));
    view.rerender(tree('b'));

    expect(screen.getByRole('button')).toHaveTextContent('b 1');
    expect(mounts.count).toBe(1);
  });

  // The render that mounts an instance can also wait for the import and pick up where it suspended, keeping what it
  // had rendered above the lazy, the instance included: React does it for a transition (and a retry) whose import
  // arrives while it yields. act flushes React's work synchronously and never lets that render wait, so this test
  // runs on React's own scheduler, outside act, turning the event loop until the page shows what it expects.
  it('an instance that rendered through the pending import keeps that type once the import is in', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    const { Counter, mounts } = counter();
    const Lazy = lazyWithPreload(() => Promise.resolve({ default: Counter }));
    const controls = {};
    function Host() {
      const [shown, setShown] = useState(false);
      const [label, setLabel] = useState('a');
      Object.assign(controls, { setShown, setLabel });
      return <Suspense fallback={<p>loading</p>}>{shown ? <Lazy label={label} /> : <p>hidden</p>}</Suspense>;
    }
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    const until = async (expected) => {
      for (let turns = 0; turns < 100 && container.textContent !== expected; turns += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(container.textContent).toBe(expected);
    };
    try {
      root.render(<Host />);
      await until('hidden');
      startTransition(() => controls.setShown(true));
      await until('a 0');
      container.querySelector('button').click();
      await until('a 1');
      controls.setLabel('b');
      await until('b 1');
      expect(mounts.count).toBe(1);
    } finally {
      root.unmount();
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

describe('once the module is in', () => {
  it('preload() before the first render: the instance renders in the same act as render(), no fallback', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);

    const preloaded = Lazy.preload();
    imports[0].resolve({ default: Hello });
    await expect(preloaded).resolves.toBeUndefined();
    render(<Suspense fallback={<p>loading</p>}><Lazy name="early" /></Suspense>);

    expect(screen.getByText('hello early')).toBeInTheDocument();
    expect(screen.queryByText('loading')).toBeNull();
  });

  it('a module an earlier render loaded: an instance mounted after renders directly', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);
    const view = render(<Suspense fallback={<p>loading</p>}><Lazy name="first" /></Suspense>);
    await resolveWith(imports[0], Hello);

    view.rerender(
      <Suspense fallback={<p>loading</p>}>
        <Lazy name="first" />
        <Lazy name="second" />
      </Suspense>,
    );

    expect(screen.getByText('hello second')).toBeInTheDocument();
    expect(screen.queryByText('loading')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('preload() imports once, however many times it is called, before or after the module is in', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);

    const first = Lazy.preload();
    const second = Lazy.preload();
    imports[0].resolve({ default: Hello });
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(Lazy.preload()).resolves.toBeUndefined();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('passes every prop through, a ref included', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);
    function Field({ ref, label }) {
      return <input ref={ref} aria-label={label} />;
    }
    const preloaded = Lazy.preload();
    imports[0].resolve({ default: Field });
    await preloaded;
    const ref = createRef();

    render(<Suspense fallback={<p>loading</p>}><Lazy ref={ref} label="Ticker" /></Suspense>);

    expect(ref.current).toBe(screen.getByRole('textbox', { name: 'Ticker' }));
  });
});

describe('a failed import', () => {
  it('throws a ChunkLoadError carrying the import error: the retried render finds it, imports nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);
    const offline = new TypeError('Failed to fetch dynamically imported module: /assets/Part-1a2b3c.js');
    render(<Catch><Suspense fallback={<p>loading</p>}><Lazy /></Suspense></Catch>);

    await act(async () => imports[0].reject(offline));

    expect(screen.getByRole('alert')).toHaveTextContent(`ChunkLoadError: ${offline.message}`);
    expect(load).toHaveBeenCalledTimes(1);
    // React reports what the boundary caught: the ChunkLoadError, with the import's own error as its cause.
    const caught = error.mock.calls.flat().find((arg) => arg instanceof ChunkLoadError);
    expect(caught.cause).toBe(offline);
    expect(isChunkLoadError(caught)).toBe(true);
  });

  it('is not final: a later preload() imports again, and the part renders directly once that one is in', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);
    const tree = (key) => <Catch key={key}><Suspense fallback={<p>loading</p>}><Lazy name="again" /></Suspense></Catch>;
    const view = render(tree('before'));
    await act(async () => imports[0].reject(new Error('offline')));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    const preloaded = Lazy.preload();
    expect(load).toHaveBeenCalledTimes(2);
    imports[1].resolve({ default: Hello });
    await expect(preloaded).resolves.toBeUndefined();
    view.rerender(tree('after'));

    expect(screen.getByText('hello again')).toBeInTheDocument();
    expect(screen.queryByText('loading')).toBeNull();
  });

  it('a failure nothing rendered (a preload) does not stand: the next render imports again', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);
    const preloaded = Lazy.preload();
    imports[0].reject(new Error('offline'));
    await expect(preloaded).resolves.toBeUndefined();

    render(<Suspense fallback={<p>loading</p>}><Lazy name="later" /></Suspense>);
    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);

    await resolveWith(imports[1], Hello);
    expect(screen.getByText('hello later')).toBeInTheDocument();
  });

  it('preload() resolves anyway, and nothing is left rejecting unhandled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { load, imports } = importer();
      const Lazy = lazyWithPreload(load);
      const preloaded = Lazy.preload();
      imports[0].reject(new Error('offline'));

      await expect(preloaded).resolves.toBeUndefined();
      // Node reports a rejection nobody handled once the microtasks it ran with are done: give it a turn.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('counts a module that cannot hand over its component (a mock without a default throws) as one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);
    const noDefault = new Error('No "default" export is defined on the mock');
    const mock = {
      get default() {
        throw noDefault;
      },
    };

    const preloaded = Lazy.preload();
    imports[0].resolve(mock);
    await expect(preloaded).resolves.toBeUndefined();
    render(<Catch><Suspense fallback={<p>loading</p>}><Lazy /></Suspense></Catch>);
    await act(async () => imports[1].resolve(mock));

    expect(screen.getByRole('alert')).toHaveTextContent(`ChunkLoadError: ${noDefault.message}`);
  });

  it('isChunkLoadError tells a failed import from anything else a render throws', () => {
    expect(isChunkLoadError(new ChunkLoadError(new Error('offline')))).toBe(true);
    expect(isChunkLoadError(new Error('render bug'))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module'))).toBe(false);
    expect(isChunkLoadError('ChunkLoadError')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe('preloadAll', () => {
  it('resolves once every lazy made so far is in or has failed, with the failures', async () => {
    const a = importer();
    const b = importer();
    const A = lazyWithPreload(a.load);
    lazyWithPreload(b.load);

    const all = preloadAll();
    expect(a.load).toHaveBeenCalledTimes(1);
    expect(b.load).toHaveBeenCalledTimes(1);
    const offline = new Error('offline');
    a.imports[0].resolve({ default: Hello });
    b.imports[0].reject(offline);
    const failures = await all;

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(ChunkLoadError);
    expect(failures[0].cause).toBe(offline);
    render(<Suspense fallback={<p>loading</p>}><A name="a" /></Suspense>);
    expect(screen.getByText('hello a')).toBeInTheDocument();
  });

  it('also loads the lazies that the modules it loads create', async () => {
    const innerLoad = vi.fn(async () => ({ default: Hello }));
    let Inner;
    const Outer = lazyWithPreload(async () => {
      Inner = lazyWithPreload(innerLoad);
      return { default: Hello };
    });

    await expect(preloadAll()).resolves.toEqual([]);
    expect(innerLoad).toHaveBeenCalledTimes(1);

    render(
      <Suspense fallback={<p>loading</p>}>
        <Outer name="outer" />
        <Inner name="inner" />
      </Suspense>,
    );
    expect(screen.getByText('hello inner')).toBeInTheDocument();
    expect(screen.queryByText('loading')).toBeNull();
  });
});

describe('scheduleIdlePreload', () => {
  /** A window as scheduleIdlePreload uses it: requestIdleCallback unless `idle` is false, and a connection. */
  const host = ({ idle = true, saveData } = {}) => ({
    ...(idle ? { requestIdleCallback: vi.fn(() => 7), cancelIdleCallback: vi.fn() } : {}),
    setTimeout: vi.fn(() => 9),
    clearTimeout: vi.fn(),
    navigator: saveData === undefined ? {} : { connection: { saveData } },
  });

  it('preloads the lazies made with { idle: true }, and only those, once the browser is idle', () => {
    const idle = importer();
    const other = importer();
    lazyWithPreload(idle.load, { idle: true });
    lazyWithPreload(other.load);
    const win = host();

    scheduleIdlePreload(win);
    expect(win.requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(win.setTimeout).not.toHaveBeenCalled();
    expect(idle.load).not.toHaveBeenCalled();

    win.requestIdleCallback.mock.calls[0][0]();
    expect(idle.load).toHaveBeenCalledTimes(1);
    expect(other.load).not.toHaveBeenCalled();
  });

  it('waits on a timeout instead where requestIdleCallback is missing (Safari)', () => {
    const idle = importer();
    lazyWithPreload(idle.load, { idle: true });
    const win = host({ idle: false });

    scheduleIdlePreload(win);
    expect(win.setTimeout).toHaveBeenCalledTimes(1);
    const [run, ms] = win.setTimeout.mock.calls[0];
    expect(ms).toBeGreaterThan(0);
    expect(idle.load).not.toHaveBeenCalled();

    run();
    expect(idle.load).toHaveBeenCalledTimes(1);
  });

  it('returns a cancel that drops the preload it scheduled', () => {
    const idleWin = host();
    scheduleIdlePreload(idleWin)();
    expect(idleWin.cancelIdleCallback).toHaveBeenCalledWith(7);

    const timeoutWin = host({ idle: false });
    scheduleIdlePreload(timeoutWin)();
    expect(timeoutWin.clearTimeout).toHaveBeenCalledWith(9);
  });

  it('schedules nothing on a connection that asks to save data', () => {
    const win = host({ saveData: true });

    const cancel = scheduleIdlePreload(win);
    cancel();

    expect(win.requestIdleCallback).not.toHaveBeenCalled();
    expect(win.setTimeout).not.toHaveBeenCalled();
    expect(win.cancelIdleCallback).not.toHaveBeenCalled();
  });

  it('schedules nothing without a window', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal('window', undefined);
    try {
      scheduleIdlePreload()();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(timeout).not.toHaveBeenCalled();
  });
});

// Last: it resets every lazy of the file, the one the setup preloaded included.
describe('resetLazies', () => {
  it('returns every lazy to its first render, and an import under way as it ran no longer counts', async () => {
    const { load, imports } = importer();
    const Lazy = lazyWithPreload(load);
    render(<Suspense fallback={<p>loading</p>}><Lazy name="reset" /></Suspense>).unmount();

    resetLazies();
    await act(async () => imports[0].resolve({ default: Hello }));
    render(<Suspense fallback={<p>loading</p>}><Lazy name="reset" /></Suspense>);

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
    await resolveWith(imports[1], Hello);
    expect(screen.getByText('hello reset')).toBeInTheDocument();
  });
});
