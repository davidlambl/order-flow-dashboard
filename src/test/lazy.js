// src/test/lazy.js — lazily loaded components (src/lib/lazyWithPreload.ts) in dom tests. By default nothing here is
// needed: the setup (src/test/setup.js) loads every lazy that a test file's imports created before its first test, so a
// lazy part renders inside render()'s act, as it did when it was imported eagerly.
//
// A file whose tests drive a lazy's pending, failed and retried paths opts out with one top-level line,
// skipLazyPreload(): the setup then preloads nothing in that file, and after each test returns every lazy to where it
// started, nothing loaded, so every test's first render suspends. To hold the import itself, mock the lazy's module in
// each test with an importGate:
//
//   import { importGate, skipLazyPreload } from '../test/lazy.js';
//
//   skipLazyPreload();
//
//   let dialog;
//   beforeEach(() => {
//     dialog = importGate();
//     vi.doMock('./settings/SettingsDialog.js', dialog.factory); // the path as seen from the test file
//   });
//
//   it('shows the placeholder until the dialog is in', async () => {
//     render(<AppSettings isOpen onClose={() => {}} />);
//     // … the boundary's fallback: the import is held …
//     await act(() => dialog.resolve()); // the real module; dialog.reject(new Error('…')) fails the import instead
//     // … the dialog …
//   });
//
// vi.doMock in a beforeEach, not a hoisted vi.mock: registering the mock again drops the module the previous test
// loaded, so each test's first import reaches its own gate, whereas vi.mock's factory runs once per file. Gate only a
// module the code imports through the lazy: a static import was resolved before the gate existed, and the gate would
// wait for an import that never comes. Everything else a gated file renders lazily is not preloaded either: its first
// render suspends and its real module loads on its own (await screen.findBy…, or gate it too). React reports what a
// boundary catches with console.error, so a test that fails an import silences it in that test:
// vi.spyOn(console, 'error').mockImplementation(() => {}).
//
// Three things the files that gate imports ran into (App.lazy.test.jsx's gateFor shows all three handled):
// - vi.doMock registers its mocks at the next import, and of two imports racing at that moment the second can read the
//   registry first and get the previous test's gate. Code that starts two imports at once (App's preloads) needs the
//   beforeEach to end with one awaited import, `await import('./test/lazy.js')`, so the mocks are registered before it.
// - An import still held when its test ends is joined by the next test's import of that module, which then never
//   reaches its own gate. Answer every import a test started before it ends (onTestFinished, or an afterEach).
// - `await act(() => gate.resolve())` for an import that never arrives leaves the act open, and every later test in
//   the file fails with it. Wait for the import outside act (waitFor on gate.imports), then settle it inside act.

let preloadSkipped = false;

/** The opt-out: call once at the top level of a test file (not in a hook, which runs after the setup's preload). */
export function skipLazyPreload() {
  preloadSkipped = true;
}

/** For src/test/setup.js: whether this file opted out. */
export function lazyPreloadSkipped() {
  return preloadSkipped;
}

/** A promise with its resolve and reject, to settle by hand (inside act when React is waiting on it). */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A vi.doMock factory that holds every import of the module until the test settles it. Settles answer imports in
 * order, the first settle the first import, whether that import has arrived yet or not (a mocked import reaches its
 * factory a macrotask after the code asks for it):
 * - resolve(module) answers with `module`, or with the real module when called without one;
 * - reject(error) fails the import, as a chunk that cannot be fetched does;
 * - each returns a promise that settles once the import has been answered, so `await act(() => gate.resolve())`
 *   covers the whole hand-off, React's retry included;
 * - `imports` counts the imports so far: one per attempt, so Try again's import is the second.
 */
export function importGate() {
  const held = [];
  const answered = [];
  let imports = 0;
  let settles = 0;
  const heldAt = (i) => {
    if (!held[i]) {
      held[i] = deferred();
      // Settled before its import arrives, a rejection would otherwise count as unhandled until the factory runs.
      held[i].promise.catch(() => {});
    }
    return held[i];
  };
  const answeredAt = (i) => (answered[i] ??= deferred());
  return {
    factory(importOriginal) {
      const i = imports++;
      const answer = heldAt(i).promise.then((module) => module ?? importOriginal());
      answer.then(() => answeredAt(i).resolve(), () => answeredAt(i).resolve());
      return answer;
    },
    get imports() {
      return imports;
    },
    resolve(module) {
      const i = settles++;
      heldAt(i).resolve(module);
      return answeredAt(i).promise;
    },
    reject(error) {
      const i = settles++;
      heldAt(i).reject(error);
      return answeredAt(i).promise;
    },
  };
}
