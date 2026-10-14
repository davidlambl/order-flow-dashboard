// src/components/StrategicContextEditor.test.jsx — the strategic context editor that the Backup tab and ChatBot open:
// nothing renders while it is closed, and each opening shows the stored text (a stored non-string reads as empty) and
// focuses the textarea; it saves 1000 ms after the last edit, trimmed, through savePreference, so store-changed names
// { kind: 'pref', id: 'strategic_context' } and any other reader of the preference follows; closing flushes a pending
// edit before onClose runs; the text it loaded is never written back; and Escape stays its own, so the settings
// dialog's window listener under it never sees the key. The tests named "Pin:" passed on the editor this replaced (an
// effect copied the store into state on open, and it saved through the silent setPreference); the other two were red
// there. Every render is under StrictMode, as main.jsx renders the app.
// Fake timers run with shouldAdvanceTime, so the focus frame and waitFor keep moving; "not saved" is asserted only
// synchronously after an edit, the save after advancing 1000 ms.
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StrategicContextEditor from './StrategicContextEditor.jsx';
import { getPreference, setPreference } from '../lib/store.js';

const PLACEHOLDER = /Paste your strategic context/;
const editor = () => screen.getByPlaceholderText(PLACEHOLDER);
const queryEditor = () => screen.queryByPlaceholderText(PLACEHOLDER);
const closeButton = () => screen.getByLabelText('Close strategic context editor');
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** The editor as its parents hold it: open until its onClose, which also tells the test. */
function Host({ onClosed = () => {} }) {
  const [open, setOpen] = useState(true);
  return (
    <StrictMode>
      <StrategicContextEditor isOpen={open} onClose={() => { setOpen(false); onClosed(); }} />
    </StrictMode>
  );
}

const removers = [];

/** A window listener for the rest of the test, in the bubble phase (as the settings dialog listens for Escape). */
function listen(type, listener) {
  window.addEventListener(type, listener);
  removers.push(() => window.removeEventListener(type, listener));
}

/** Every store-changed detail dispatched from now on (null for a whole-store change). */
function recordStoreEvents() {
  const details = [];
  listen('store-changed', (event) => details.push(event.detail));
  return details;
}

describe('StrategicContextEditor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    removers.splice(0).forEach((remove) => remove());
  });

  it('Pin: renders nothing while closed; each opening shows the stored text and focuses the textarea', async () => {
    setPreference('strategic_context', 'Long AVGO into earnings\nTrim above 400');
    const at = (isOpen) => <StrictMode><StrategicContextEditor isOpen={isOpen} onClose={vi.fn()} /></StrictMode>;
    const { rerender } = render(at(false));
    expect(queryEditor()).toBeNull();

    rerender(at(true));
    expect(editor()).toHaveValue('Long AVGO into earnings\nTrim above 400');
    expect(screen.getByText('38 chars · 2 lines')).toBeInTheDocument();
    await waitFor(() => expect(editor()).toHaveFocus());

    rerender(at(false));
    expect(queryEditor()).toBeNull();
    setPreference('strategic_context', 'Rewritten by an import'); // while closed: the next opening reads it
    rerender(at(true));
    expect(editor()).toHaveValue('Rewritten by an import');
  });

  it('saves 1000 ms after the last edit through the store events, and flashes Saved for 1500 ms', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const details = recordStoreEvents();
    render(<Host />);

    await user.type(editor(), 'Hold');
    expect(getPreference('strategic_context')).toBeNull();
    expect(details).toEqual([]);

    await advance(1000);
    expect(getPreference('strategic_context')).toBe('Hold');
    expect(details).toEqual([{ kind: 'pref', id: 'strategic_context' }]);
    expect(screen.getByText('Saved')).toBeInTheDocument();

    await advance(1500);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('Pin: stores the text trimmed, and an emptied document removes the preference', async () => {
    setPreference('strategic_context', 'Old notes');
    render(<Host />);

    fireEvent.change(editor(), { target: { value: '  New notes\n\n' } });
    await advance(1000);
    expect(getPreference('strategic_context')).toBe('New notes');
    expect(editor()).toHaveValue('  New notes\n\n');

    fireEvent.change(editor(), { target: { value: '  ' } });
    await advance(1000);
    expect(localStorage.getItem('strategic_context')).toBeNull();
  });

  it.each([
    ['the close button', () => fireEvent.click(closeButton())],
    ['the backdrop', () => fireEvent.click(document.querySelector('.backdrop-blur-sm'))],
    ['Escape', () => fireEvent.keyDown(editor(), { key: 'Escape' })],
  ])('Pin: closing with %s flushes a pending edit, which onClose already finds in the store', (_, close) => {
    const seen = [];
    render(<Host onClosed={() => seen.push(getPreference('strategic_context'))} />);
    fireEvent.change(editor(), { target: { value: 'Trim 10% above 400' } });
    expect(getPreference('strategic_context')).toBeNull();

    close();
    expect(seen).toEqual(['Trim 10% above 400']);
    expect(queryEditor()).toBeNull();
    expect(getPreference('strategic_context')).toBe('Trim 10% above 400');
  });

  it('Pin: never writes the text it loaded back, even after an edit undone inside the debounce', async () => {
    setPreference('strategic_context', 'Stored notes\n'); // a write-back would store it trimmed
    const details = recordStoreEvents();
    render(<Host />);

    fireEvent.change(editor(), { target: { value: 'Stored notes\nmore' } });
    fireEvent.change(editor(), { target: { value: 'Stored notes\n' } });
    await advance(1000);
    fireEvent.click(closeButton());
    expect(queryEditor()).toBeNull();
    expect(localStorage.getItem('strategic_context')).toBe(JSON.stringify('Stored notes\n'));
    expect(details).toEqual([]);
  });

  it("Pin: Escape closes the editor and stops there: the settings dialog's window listener never sees it", () => {
    const settingsKeydown = vi.fn();
    listen('keydown', settingsKeydown);
    const onClosed = vi.fn();
    render(<Host onClosed={onClosed} />);

    fireEvent.keyDown(editor(), { key: 'a' }); // any other key is not the editor's
    expect(settingsKeydown).toHaveBeenCalledTimes(1);

    expect(fireEvent.keyDown(editor(), { key: 'Escape' })).toBe(false); // its default prevented
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(settingsKeydown).toHaveBeenCalledTimes(1);
    expect(queryEditor()).toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' }); // with the editor gone, the next Escape is the dialog's
    expect(settingsKeydown).toHaveBeenCalledTimes(2);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('a stored non-string reads as an empty document', () => {
    localStorage.setItem('strategic_context', '42'); // a hand-edited import or cloud row: getPreference gives 42
    render(<Host />);
    expect(editor()).toHaveValue('');
    expect(screen.getByText('0 chars · 0 lines')).toBeInTheDocument();
  });
});
