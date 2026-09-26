// src/components/CollapsibleSection.test.jsx — the collapsible panel around the position, research and chart
// sections: open or collapsed, the choice it remembers per section (preference `section_<id>`, stored as JSON
// `true`/`false`), and the re-read on `store-changed`. Phase 5 moves the preference to useSyncExternalStore; these
// tests assert only what the user and the storage see, so they should pass unchanged across that rewrite.
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CollapsibleSection from './CollapsibleSection.jsx';

// getPreference('section_test'): not a PREF_MAP name, so the localStorage key is the name itself.
const KEY = 'section_test';
const TITLE = 'Test section';
const BODY = 'Section body';

function renderSection(props = {}) {
  return render(
    <CollapsibleSection id="test" title={TITLE} {...props}>
      <p>{BODY}</p>
    </CollapsibleSection>,
  );
}

const header = () => screen.getByRole('button', { name: TITLE });

function expectExpanded() {
  expect(header()).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText(BODY)).toBeInTheDocument();
}

function expectCollapsed() {
  expect(header()).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText(BODY)).not.toBeInTheDocument();
}

/** What an import, a cloud pull or another tab does after rewriting storage. */
function emitStoreChanged() {
  act(() => {
    window.dispatchEvent(new Event('store-changed'));
  });
}

describe('CollapsibleSection', () => {
  it('is open by default, with the title as its toggle button', () => {
    renderSection();
    expectExpanded();
  });

  it('starts collapsed when the stored preference is false', () => {
    localStorage.setItem(KEY, 'false');
    renderSection();
    expectCollapsed();
  });

  it('starts collapsed with defaultOpen={false} and nothing stored', () => {
    renderSection({ defaultOpen: false });
    expectCollapsed();
  });

  it('lets a stored preference win over defaultOpen', () => {
    localStorage.setItem(KEY, 'true');
    renderSection({ defaultOpen: false });
    expectExpanded();
  });

  it('toggles on click and stores each choice', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(header());
    expectCollapsed();
    expect(localStorage.getItem(KEY)).toBe('false');

    await user.click(header());
    expectExpanded();
    expect(localStorage.getItem(KEY)).toBe('true');
  });

  it('re-reads the stored preference on store-changed', () => {
    localStorage.setItem(KEY, 'false');
    renderSection();
    expectCollapsed();

    localStorage.setItem(KEY, 'true');
    emitStoreChanged();
    expectExpanded();
  });

  it('keeps its state on store-changed when nothing is stored', () => {
    renderSection();
    emitStoreChanged();
    expectExpanded();
  });

  it('wraps the children in a padded body', () => {
    renderSection();
    expect(screen.getByText(BODY).parentElement).toHaveClass('px-4', 'pb-4');
  });

  it('puts the children straight under the section, beside the header, with noPadding', () => {
    renderSection({ noPadding: true });
    expect(screen.getByText(BODY).parentElement).toBe(header().parentElement);
  });

  it('writes the preference once per click under StrictMode (D12)', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(
      <StrictMode>
        <CollapsibleSection id="test" title={TITLE}>
          <p>{BODY}</p>
        </CollapsibleSection>
      </StrictMode>,
    );
    expect(setItem).not.toHaveBeenCalled(); // rendering (twice, under StrictMode) never writes

    await user.click(header());
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenLastCalledWith(KEY, 'false');

    await user.click(header());
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(setItem).toHaveBeenLastCalledWith(KEY, 'true');
  });
});
