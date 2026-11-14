// src/hooks/useResizableSidebar.moves.test.jsx — what a drag costs when the pointer moves but the width does not, and
// the handle's value in words.
// - A pointermove that leaves the width where it is (a vertical move, any move past the 280 or 640 px bound, a
//   sub-pixel move rounded away) renders nothing: App and every child it does not memoise would otherwise render once
//   per move. React may render the host once more before its eager bailout takes over, as it did when the dragged
//   width was a plain number, so the bound is at most one render per run of unchanged moves.
// - aria-valuetext carries the width in words ("384 pixels"), so a screen reader does not read a bare number; it
//   follows the width as aria-valuenow does.
// The host renders the handle as App does, outside StrictMode so that each render is counted once; src/test/setup.js
// clears localStorage after each test and installs the pointer-capture stand-in, which retargets nothing (the tests
// fire a drag's events on the handle, where a browser sends them).
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useResizableSidebar } from './useResizableSidebar.js';

/** One entry per render of the host. */
const renderLog = [];
const renders = () => renderLog.length;

/** The handle as App wires it; counts its renders. */
function Host() {
  const { handleProps } = useResizableSidebar();
  renderLog.push(1);
  return <div data-testid="handle" tabIndex={0} {...handleProps} />;
}

const handle = () => screen.getByTestId('handle');

describe('useResizableSidebar: unchanged moves and the value in words', () => {
  beforeEach(() => {
    renderLog.length = 0;
  });

  it('a drag renders at most once for a run of pointermoves that change no width: vertical, past a bound, sub-pixel', () => {
    render(<Host />);
    fireEvent.pointerDown(handle(), { clientX: 1000, clientY: 100 });
    fireEvent.pointerMove(handle(), { clientX: 900, clientY: 100 });
    expect(handle()).toHaveAttribute('aria-valuenow', '484');

    let before = renders();
    for (let i = 0; i < 10; i += 1) fireEvent.pointerMove(handle(), { clientX: 900, clientY: 101 + i }); // vertical only
    expect(renders() - before).toBeLessThanOrEqual(1);

    fireEvent.pointerMove(handle(), { clientX: 0 }); // to the maximum
    expect(handle()).toHaveAttribute('aria-valuenow', '640');
    before = renders();
    for (let i = 0; i < 10; i += 1) fireEvent.pointerMove(handle(), { clientX: -10 - i }); // still past it
    expect(renders() - before).toBeLessThanOrEqual(1);

    fireEvent.pointerMove(handle(), { clientX: 900 });
    expect(handle()).toHaveAttribute('aria-valuenow', '484');
    before = renders();
    for (let i = 1; i <= 4; i += 1) fireEvent.pointerMove(handle(), { clientX: 900 + i / 10 }); // rounded to 484
    expect(renders() - before).toBeLessThanOrEqual(1);

    fireEvent.pointerMove(handle(), { clientX: 950 }); // a move that does change the width still renders it
    expect(handle()).toHaveAttribute('aria-valuenow', '434');
    fireEvent.pointerUp(handle());
    expect(localStorage.getItem('chat_sidebar_w')).toBe('434');
  });

  it('gives the handle its value in words: aria-valuetext is "<width> pixels", following a drag and the keys', () => {
    localStorage.setItem('chat_sidebar_w', '384');
    render(<Host />);
    expect(handle()).toHaveAttribute('aria-valuetext', '384 pixels');

    fireEvent.pointerDown(handle(), { clientX: 1000 });
    fireEvent.pointerMove(handle(), { clientX: 900 });
    expect(handle()).toHaveAttribute('aria-valuetext', '484 pixels');
    fireEvent.pointerUp(handle());
    expect(handle()).toHaveAttribute('aria-valuetext', '484 pixels');

    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(handle()).toHaveAttribute('aria-valuetext', '280 pixels');
    fireEvent.keyUp(handle(), { key: 'Home' });
    expect(handle()).toHaveAttribute('aria-valuetext', '280 pixels');
  });
});
