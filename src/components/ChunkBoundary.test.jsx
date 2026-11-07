// src/components/ChunkBoundary.test.jsx — ChunkBoundary around a real lazy part, the data-source note behind a
// dynamic import, as the dashboard's parts are: the fallback in the part's place while the import is held, nothing
// outside the boundary hidden; a failed import's card (Try again imports again, Reload reloads, `failed` replaces the
// card); a render bug passed on to the root ErrorBoundary as before; a boundary that unmounts while its part loads,
// which leaves the part's next mount to import again, at the price of one more import for a boundary still waiting on
// it, and leaves an import under way, or one started after it, running as it was; StrictMode's remount, which releases
// nothing; one import per Try again, never one on its own; a card that forgets its own part's failure only; and every
// lazy part in the source inside a ChunkBoundary. This file opts out of the setup's preload and holds each test's
// import with an importGate (src/test/lazy.js), which is how a test drives a lazy part's pending, failed and retried
// paths: every test starts with nothing loaded.
import { StrictMode, Suspense, useState } from 'react';
import { flushSync } from 'react-dom';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChunkBoundary from './ChunkBoundary.js';
import ErrorBoundary from './ErrorBoundary.jsx';
import { isChunkLoadError, lazyWithPreload } from '../lib/lazyWithPreload.js';
import { deferred, importGate, skipLazyPreload } from '../test/lazy.js';

skipLazyPreload();

const Note = lazyWithPreload(() => import('./dashboard/DataSourceNote.js'));
// Made at import too, on an import that never settles: had the setup preloaded this file, it would wait on it for good.
const neverLoad = vi.fn(() => new Promise(() => {}));
lazyWithPreload(neverLoad);

const NOTE = /Currently showing simulated demo data/;
const OFFLINE = 'Failed to fetch dynamically imported module: /assets/DataSourceNote-1a2b3c.js';

let note;
beforeEach(() => {
  note = importGate();
  vi.doMock('./dashboard/DataSourceNote.js', note.factory);
});

/** The note in its own boundary, next to a paragraph outside it. */
const part = (props = {}) => (
  <>
    <p>beside</p>
    <ChunkBoundary fallback={<p>note loading</p>} {...props}>
      <Note usingMock provider={undefined} />
    </ChunkBoundary>
  </>
);

/** React reports every error a boundary catches; these tests throw on purpose. */
const silenceCaughtErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});

/** What the root ErrorBoundary logs for a render bug it caught. */
const rootCaughtRenderBug = ['ErrorBoundary caught:', expect.objectContaining({ message: 'render bug' }), expect.any(String)];

describe('while the import is held', () => {
  it('suspends in a file that opted out of the preload, and shows the part once its import resolves', async () => {
    expect(neverLoad).not.toHaveBeenCalled();

    render(part());
    expect(screen.getByText('note loading')).toBeInTheDocument();

    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByText('note loading')).toBeNull();
    expect(note.imports).toBe(1);
  });

  it('shows the fallback in the part\'s place only: what is outside the boundary stays as it is', async () => {
    const page = (withNote) => (
      <Suspense fallback={<p>page loading</p>}>
        {withNote ? part() : <p>beside</p>}
      </Suspense>
    );
    const view = render(page(false));

    view.rerender(page(true));
    expect(screen.getByText('note loading')).toBeInTheDocument();
    expect(screen.getByText('beside')).toBeVisible();
    expect(screen.queryByText('page loading')).toBeNull();

    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeVisible();
    expect(screen.getByText('beside')).toBeVisible();
  });
});

describe('a failed import', () => {
  it('shows the card in the part\'s place; Try again imports again and shows the part', async () => {
    const error = silenceCaughtErrors();
    render(part());

    await act(() => note.reject(new TypeError(OFFLINE)));
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('This part of the dashboard could not load.');
    expect(within(card).getAllByRole('button').map((button) => button.textContent)).toEqual(['Try again', 'Reload']);
    expect(screen.getByText('beside')).toBeVisible();
    expect(note.imports).toBe(1);
    expect(error.mock.calls.flat().some(isChunkLoadError)).toBe(true);

    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('note loading')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(note.imports).toBe(2);
  });

  it('shows the card again when the second import fails too, and the third can still load', async () => {
    silenceCaughtErrors();
    render(part());
    await act(() => note.reject(new TypeError(OFFLINE)));

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(() => note.reject(new TypeError(OFFLINE)));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(note.imports).toBe(3);
  });

  it('lets the part import again wherever it mounts next, once the card has shown the failure', async () => {
    silenceCaughtErrors();
    const view = render(part());
    await act(() => note.reject(new TypeError(OFFLINE)));
    view.unmount();

    render(part());
    expect(screen.getByText('note loading')).toBeInTheDocument();
    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(note.imports).toBe(2);
  });

  it('Reload reloads the page, for a tab whose old files a deploy removed', async () => {
    silenceCaughtErrors();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(part());
    await act(() => note.reject(new TypeError(OFFLINE)));

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(note.imports).toBe(1);
  });

  it('shows what `failed` renders instead of the card, and its retry imports again', async () => {
    silenceCaughtErrors();
    render(part({
      failed: ({ retry }) => <button type="button" onClick={retry}>The note did not load</button>,
    }));

    await act(() => note.reject(new TypeError(OFFLINE)));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'The note did not load' }));
    expect(screen.getByText('note loading')).toBeInTheDocument();

    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(note.imports).toBe(2);
  });
});

describe('any other error', () => {
  function Bug() {
    throw new Error('render bug');
  }

  it('reaches the root ErrorBoundary, as it did before the part was lazy', () => {
    const error = silenceCaughtErrors();

    render(
      <ErrorBoundary>
        <ChunkBoundary fallback={<p>loading</p>}><Bug /></ChunkBoundary>
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(error).toHaveBeenCalledWith(...rootCaughtRenderBug);
  });

  it('thrown by the loaded part reaches it too', async () => {
    const error = silenceCaughtErrors();
    render(
      <ErrorBoundary>
        <p>beside</p>
        <ChunkBoundary fallback={<p>note loading</p>}><Note usingMock /></ChunkBoundary>
      </ErrorBoundary>,
    );

    await act(() => note.resolve({ default: Bug }));

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith(...rootCaughtRenderBug);
  });
});

/** Real time for an import asked for to reach the gate (a few event-loop turns), so that an absence shows after it. */
const quiet = () => act(() => new Promise((resolve) => { setTimeout(resolve, 100); }));

/** Real time for an import's settling to reach the lazy and React, inside an act that holds React's retries back. */
const settleTurn = () => new Promise((resolve) => { setTimeout(resolve, 20); });

/** The note in a boundary of its own, labelled, so that two of them can stand side by side. */
const noteIn = (label) => (
  <ChunkBoundary fallback={<p>{label} loading</p>}>
    <Note usingMock provider={undefined} />
  </ChunkBoundary>
);

/** A second lazy part, on a loader settled by hand: `loads` holds one deferred per import. */
function heldPart() {
  const loads = [];
  const Part = lazyWithPreload(() => {
    const load = deferred();
    loads.push(load);
    return load.promise;
  });
  return { Part, loads };
}

// A boundary that unmounts was perhaps the one a part's import was rendering for: Settings closed while its chunk
// loads, the chat closed while the markdown renderer loads, a reply deleted. Whatever then becomes of that import, the
// part's next mount must import again rather than meet a failure nobody was shown.
describe('a boundary that unmounts while its part loads', () => {
  it('leaves nothing behind: once that import has failed, the part imports again where it mounts next', async () => {
    silenceCaughtErrors();
    const view = render(part());
    expect(screen.getByText('note loading')).toBeInTheDocument();
    view.unmount();
    await act(() => note.reject(new TypeError(OFFLINE)));

    render(part());
    expect(screen.getByText('note loading')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(note.imports).toBe(2);
  });

  it('nor when the import failed first and the boundary went before its card could show', async () => {
    silenceCaughtErrors();
    let close;
    function Host() {
      const [open, setOpen] = useState(true);
      close = () => setOpen(false);
      return open ? part() : null;
    }
    render(<Host />);
    await vi.waitFor(() => expect(note.imports).toBe(1));

    // Inside one act, React's retry of the boundary waits until the callback ends; the close renders at once.
    await act(async () => {
      note.reject(new TypeError(OFFLINE));
      await settleTurn();
      expect(screen.getByText('note loading')).toBeInTheDocument();
      flushSync(close);
    });
    expect(screen.queryByText('beside')).toBeNull();

    render(part());
    expect(screen.getByText('note loading')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(note.imports).toBe(2);
  });

  // The cost of a release that cannot tell which part a boundary was waiting for: two replies' bubbles, one deleted
  // while the renderer loads.
  it('costs a boundary still waiting on the same part one import more before its card, never a loop', async () => {
    silenceCaughtErrors();
    const both = (first) => (
      <>
        {first && noteIn('first')}
        {noteIn('second')}
      </>
    );
    const view = render(both(true));
    view.rerender(both(false));
    expect(screen.queryByText('first loading')).toBeNull();

    await act(() => note.reject(new TypeError(OFFLINE)));
    expect(screen.getByText('second loading')).toBeInTheDocument();
    await vi.waitFor(() => expect(note.imports).toBe(2));
    await act(() => note.reject(new TypeError(OFFLINE)));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await quiet();
    expect(note.imports).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(note.imports).toBe(3);
  });

  it('releases what any boundary waits for: one never retried imports once more, then shows its card', async () => {
    silenceCaughtErrors();
    // A boundary around a part that is no lazy at all: its unmount still releases the note's import.
    const page = (other) => (
      <>
        {other && <ChunkBoundary fallback={null}><p>other part</p></ChunkBoundary>}
        {part()}
      </>
    );
    const view = render(page(true));
    view.rerender(page(false));
    expect(screen.queryByText('other part')).toBeNull();

    await act(() => note.reject(new TypeError(OFFLINE)));
    expect(screen.getByText('note loading')).toBeInTheDocument();
    await vi.waitFor(() => expect(note.imports).toBe(2));
    await act(() => note.reject(new TypeError(OFFLINE)));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await quiet();
    expect(note.imports).toBe(2);
  });

  // The part's own loader counts the imports here: a second import() of a module still loading joins the first, so the
  // gate would count one either way.
  it('Pin: leaves an import under way (the idle preload, say) running, and does not start it again', async () => {
    const held = heldPart();
    const heldIn = () => <ChunkBoundary fallback={<p>part loading</p>}><held.Part /></ChunkBoundary>;
    void held.Part.preload();
    const view = render(heldIn());
    expect(screen.getByText('part loading')).toBeInTheDocument();
    view.unmount();
    await quiet();

    render(heldIn());
    expect(screen.getByText('part loading')).toBeInTheDocument();
    await act(async () => held.loads[0].resolve({ default: () => <p>the part</p> }));
    expect(screen.getByText('the part')).toBeInTheDocument();
    expect(held.loads).toHaveLength(1);
  });

  it('Pin: leaves alone an import started after the unmount in the same task (a preload, say)', async () => {
    silenceCaughtErrors();
    const held = heldPart();
    let close;
    function Host() {
      const [open, setOpen] = useState(true);
      close = () => setOpen(false);
      return open ? <ChunkBoundary fallback={<p>part loading</p>}><held.Part /></ChunkBoundary> : null;
    }
    render(<Host />);
    expect(held.loads).toHaveLength(1);

    // The import fails, the boundary goes before its card could show, and a preload imports again at once.
    await act(async () => {
      held.loads[0].reject(new TypeError(OFFLINE));
      await settleTurn();
      flushSync(close);
      void held.Part.preload();
    });
    expect(held.loads).toHaveLength(2);

    render(<ChunkBoundary fallback={<p>part loading</p>}><held.Part /></ChunkBoundary>);
    expect(screen.getByText('part loading')).toBeInTheDocument();
    await act(async () => held.loads[1].resolve({ default: () => <p>the part</p> }));
    expect(screen.getByText('the part')).toBeInTheDocument();
    expect(held.loads).toHaveLength(2);
  });
});

describe('a boundary that stays mounted', () => {
  it('Pin: imports once per Try again however often the import fails, and never on its own', async () => {
    silenceCaughtErrors();
    render(part());
    for (let failures = 1; failures <= 3; failures += 1) {
      await vi.waitFor(() => expect(note.imports).toBe(failures));
      await act(() => note.reject(new TypeError(OFFLINE)));
      expect(screen.getByRole('alert')).toBeInTheDocument();
      await quiet();
      expect(note.imports).toBe(failures);
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    }

    await vi.waitFor(() => expect(note.imports).toBe(4));
    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(note.imports).toBe(4);
  });

  // StrictMode, in development, unmounts every new class component and mounts it again at once to check its cleanup.
  it("Pin: through StrictMode's remount of a new boundary, shows a failed import after one import", async () => {
    silenceCaughtErrors();
    render(<StrictMode>{part()}</StrictMode>);
    expect(screen.getByText('note loading')).toBeInTheDocument();

    await act(() => note.reject(new TypeError(OFFLINE)));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await quiet();
    expect(note.imports).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(() => note.resolve());
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(note.imports).toBe(2);
  });

  // In two roots: a render that throws takes along every retry its root has due, so a boundary that is to be still
  // waiting when the other's card shows waits in a root of its own.
  it("Pin: its card forgets its own part's failure, not another's that a boundary still waits to show", async () => {
    silenceCaughtErrors();
    const other = heldPart();
    let renderAgain;
    function NoteSlot() {
      const [, setRenders] = useState(0);
      renderAgain = () => setRenders((renders) => renders + 1);
      return noteIn('note');
    }
    render(<NoteSlot />);
    render(<ChunkBoundary fallback={<p>other loading</p>}><other.Part /></ChunkBoundary>);
    await vi.waitFor(() => expect(note.imports).toBe(1));
    expect(other.loads).toHaveLength(1);

    // Both imports fail. Inside one act, React's retries of the two boundaries wait until the callback ends, so both
    // failures stand; the note's boundary renders at once on its own, and its card shows while the other still waits.
    await act(async () => {
      note.reject(new TypeError(OFFLINE));
      other.loads[0].reject(new TypeError(OFFLINE));
      await settleTurn();
      flushSync(renderAgain);
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.getByText('other loading')).toBeInTheDocument();
    });

    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(other.loads).toHaveLength(1);
    expect(note.imports).toBe(1);
  });
});

// A lazy part rendered without a boundary of its own would take a failed chunk to the root ErrorBoundary, and the whole
// app with it; the type system cannot see that, so the source is read.
describe('every lazy part in the source', () => {
  const SRC = path.join(import.meta.dirname, '..');
  const DEFINITION = path.join('lib', 'lazyWithPreload.ts');

  /** The modules under src/ that ship: no test, no test helper, and not the module that defines lazyWithPreload. */
  const shipped = () => readdirSync(SRC, { recursive: true })
    .filter((file) => /\.(?:jsx?|tsx?)$/.test(file) && !/\.test\./.test(file))
    .filter((file) => !file.startsWith(`test${path.sep}`) && file !== DEFINITION);

  /** A comment, or a string literal (kept as it is, so that a '//' inside one is not taken for a comment). */
  const COMMENT = /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  const IMPORTS_BOUNDARY = /^import ChunkBoundary from '(?:\.\.?\/)+(?:components\/)?ChunkBoundary\.js';$/m;

  /** A module's code without its comments. */
  const codeOf = (file) => readFileSync(path.join(SRC, file), 'utf8').replace(COMMENT, (_, str) => str ?? '');

  it('Pin: is declared at module level and rendered only inside a ChunkBoundary that its module imports', () => {
    const lazies = [];
    for (const file of shipped()) {
      const code = codeOf(file);
      const calls = code.match(/\blazyWithPreload\(/g)?.length ?? 0;
      if (calls === 0) continue;
      const names = [...code.matchAll(/^(?:export )?const (\w+) = lazyWithPreload\(/gm)].map(([, name]) => name);
      expect(names, `${file}: every lazyWithPreload() is a module-level const`).toHaveLength(calls);
      expect(code, `${file} imports ChunkBoundary`).toMatch(IMPORTS_BOUNDARY);
      for (const name of names) {
        const uses = [...code.matchAll(new RegExp(`<${name}\\b`, 'g'))];
        expect(uses.length, `${file} renders <${name}>`).toBeGreaterThan(0);
        for (const { index } of uses) {
          const before = code.slice(0, index);
          expect(before.lastIndexOf('<ChunkBoundary'), `${file}: <${name}> opens inside a ChunkBoundary`)
            .toBeGreaterThan(before.lastIndexOf('</ChunkBoundary>'));
        }
        lazies.push(name);
      }
    }
    expect(lazies).toEqual(expect.arrayContaining([
      'ChartsPanel', 'LoginForm', 'SyncChoice', 'SettingsDialog', 'StrategicContextDialog', 'ChatMarkdown',
    ]));
  });
});
