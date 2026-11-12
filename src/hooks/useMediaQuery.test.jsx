// src/hooks/useMediaQuery.test.jsx — useMediaQuery over the matchMedia stand-in that src/test/setup.js installs
// (src/test/viewport.js: a desktop width at the start of every test, setViewportWidth() to move it). The hook answers
// a query at the width it mounts at, from its first render, and follows every change across the query's edge; it
// follows a new query and leaves the old one; it removes its listener when it unmounts; and where matchMedia is
// missing it answers false and throws nothing. App reads Tailwind's `md` through it, so these use that query.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DESKTOP_WIDTH, PHONE_WIDTH, setViewportWidth } from '../test/viewport.js';
import { useMediaQuery } from './useMediaQuery.js';

/** Tailwind's `md` breakpoint as App asks for it. */
const MD = '(min-width: 48rem)';

/**
 * Every MediaQueryList matchMedia hands out from now on, with its addEventListener and removeEventListener spied on.
 * restoreMocks (vitest.config.js) puts matchMedia back after the test.
 */
function recordLists() {
  const lists = [];
  const realMatchMedia = window.matchMedia;
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const list = realMatchMedia(query);
    vi.spyOn(list, 'addEventListener');
    vi.spyOn(list, 'removeEventListener');
    lists.push(list);
    return list;
  });
  return lists;
}

/** Every [list, type, listener] added to the recorded lists so far. */
const listenersAdded = (lists) => lists.flatMap(
  (list) => list.addEventListener.mock.calls.map(([type, listener]) => [list, type, listener]),
);

describe('useMediaQuery', () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('answers the query at the current width and follows every change across its edge', () => {
    const { result } = renderHook(() => useMediaQuery(MD));
    expect(result.current).toBe(true); // a desktop, as every test starts

    act(() => { setViewportWidth(PHONE_WIDTH); });
    expect(result.current).toBe(false);
    act(() => { setViewportWidth(768); }); // 48rem exactly: md starts here
    expect(result.current).toBe(true);
    act(() => { setViewportWidth(767); });
    expect(result.current).toBe(false);
    act(() => { setViewportWidth(DESKTOP_WIDTH); });
    expect(result.current).toBe(true);
  });

  it('answers from its first render: mounted at a phone width, it never says true on the way', () => {
    setViewportWidth(PHONE_WIDTH);
    const answers = [];
    renderHook(() => { answers.push(useMediaQuery(MD)); });
    expect(answers.length).toBeGreaterThan(0);
    expect(answers).toEqual(answers.map(() => false));
  });

  it('follows a new query, and a change that matters only to the old one renders nothing', () => {
    const lists = recordLists();
    const answers = [];
    const { rerender } = renderHook(({ query }) => {
      const matches = useMediaQuery(query);
      answers.push(matches);
      return matches;
    }, { initialProps: { query: MD } });
    expect(answers.at(-1)).toBe(true);
    const mdListeners = listenersAdded(lists);

    rerender({ query: '(max-width: 30rem)' });
    expect(answers.at(-1)).toBe(false); // 1280 px is wider than 30rem
    // The md list's listener is gone, so md's edge is no longer heard...
    for (const [list, type, listener] of mdListeners) expect(list.removeEventListener).toHaveBeenCalledWith(type, listener);
    const before = answers.length;
    act(() => { setViewportWidth(600); }); // md flips, 30rem does not
    expect(answers).toHaveLength(before);
    // ...and the new query's is.
    act(() => { setViewportWidth(400); });
    expect(answers.at(-1)).toBe(true);
  });

  it('removes its listener when it unmounts', () => {
    const lists = recordLists();
    const { unmount } = renderHook(() => useMediaQuery(MD));
    const added = listenersAdded(lists);
    expect(added.map(([, type]) => type)).toContain('change');

    unmount();
    for (const [list, type, listener] of added) expect(list.removeEventListener).toHaveBeenCalledWith(type, listener);
  });

  it('answers false, and throws nothing, where matchMedia is missing', () => {
    delete window.matchMedia; // what jsdom has without the stand-in; afterEach puts it back
    expect(window.matchMedia).toBeUndefined();
    const { result, unmount } = renderHook(() => useMediaQuery(MD));
    expect(result.current).toBe(false);
    unmount();
  });
});
