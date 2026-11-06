// src/components/ChunkBoundary.test.jsx — ChunkBoundary around a real lazy part, the data-source note behind a
// dynamic import, as the dashboard's parts are: the fallback in the part's place while the import is held, nothing
// outside the boundary hidden; a failed import's card (Try again imports again, Reload reloads, `failed` replaces the
// card); a render bug passed on to the root ErrorBoundary as before. This file opts out of the setup's preload and
// holds each test's import with an importGate (src/test/lazy.js), which is how a test drives a lazy part's pending,
// failed and retried paths: every test starts with nothing loaded.
import { Suspense } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChunkBoundary from './ChunkBoundary.js';
import ErrorBoundary from './ErrorBoundary.jsx';
import { isChunkLoadError, lazyWithPreload } from '../lib/lazyWithPreload.js';
import { importGate, skipLazyPreload } from '../test/lazy.js';

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
