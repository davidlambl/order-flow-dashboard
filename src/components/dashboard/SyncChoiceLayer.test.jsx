// src/components/dashboard/SyncChoiceLayer.test.jsx — the layer App shows in the sync choice's place while its module
// loads (a spinner) and after it failed to (the failure card), as a modal dialog that nothing dismisses, like the
// choice itself. Rendered as App renders it, after a button, under StrictMode: loading, it is a modal dialog named "Sync
// your data", busy, holding focus itself (nothing in it can take focus); failed, it holds the failure card and the
// focus, and is no longer busy. Escape (the browser's `cancel`, prevented) and a press outside leave it open, a close
// the browser forces is undone, and axe finds nothing in either state. Red on the layer before it became a native
// modal dialog.
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SyncChoiceLayer from './SyncChoiceLayer.js';
import ChunkFailureCard from '../ChunkFailureCard.js';
import { requestDialogClose } from '../../test/standins.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

/** The layer as App renders it, after a button that had focus behind it. */
function renderLayer(layer) {
  render(<StrictMode><button type="button">Behind</button>{layer}</StrictMode>);
  return screen.getByRole('dialog', { name: 'Sync your data' });
}

/** App's loading layer: a spinner. */
const LOADING = (
  <SyncChoiceLayer loading>
    <div className="mx-auto animate-spin rounded-full h-8 w-8 border-2 border-[var(--color-accent)] border-t-transparent" />
  </SyncChoiceLayer>
);

let showModal;
beforeEach(() => {
  showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
});

describe('SyncChoiceLayer', () => {
  it('loading: a modal dialog named Sync your data, busy, holding focus itself, which nothing dismisses', async () => {
    const layer = renderLayer(LOADING);
    expect(layer).toBeInstanceOf(HTMLDialogElement);
    expect(layer.open).toBe(true);
    expect(showModal.mock.contexts).toContain(layer);
    expect(layer).toHaveAttribute('aria-busy', 'true');
    expect(layer).toHaveFocus();
    expect(layer).toHaveAttribute('closedby', 'none');

    expect(requestDialogClose(layer)).toBe(false);
    fireEvent.pointerDown(layer);
    fireEvent.pointerUp(layer);
    fireEvent.click(layer);
    expect(layer.open).toBe(true);
    expect(requestDialogClose(layer, { cancelable: false })).toBe(true);
    await act(async () => {});
    expect(layer.open).toBe(true);
    expect(layer).toHaveFocus();

    await expectNoAxeViolations(document.body, { bestPractices: true });
  });

  it('failed: the failure card inside a modal dialog holding focus, no longer busy', async () => {
    const layer = renderLayer(<SyncChoiceLayer><ChunkFailureCard retry={vi.fn()} /></SyncChoiceLayer>);
    expect(layer).toBeInstanceOf(HTMLDialogElement);
    expect(layer.open).toBe(true);
    expect(layer).not.toHaveAttribute('aria-busy');
    expect(layer).toContainElement(screen.getByRole('alert'));
    expect(layer).toHaveFocus();

    await expectNoAxeViolations(document.body, { bestPractices: true });
  });
});
