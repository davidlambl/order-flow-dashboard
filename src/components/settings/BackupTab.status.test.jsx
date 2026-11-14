// src/components/settings/BackupTab.status.test.jsx — the Backup tab's status region for an import's report is in the
// tree before the report: a live region announces a change inside it, and one inserted together with its text is not
// read by every screen reader. The tab renders it from its first render, empty and visually hidden (sr-only alone, none
// of the report's classes), and a finished import fills that same node; a "no" to the import's question empties it
// again. Rendered alone under the two app contexts (it reads AuthContext); one axe run per state. Role queries are
// scoped to the tab's container.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { withContexts } from '../../test/contexts.jsx';
import { expectNoAxeViolations } from '../../test/a11y.js';
import BackupTab from './BackupTab.js';

const BACKUP = {
  version: 2,
  exportedAt: '2026-10-01T12:00:00.000Z',
  positions: { NVDA: { costBasis: 100, shares: 5 } },
  chatHistories: {},
  preferences: { ai_provider: 'openai', bogus: 1 },
};
const REPORT = 'Imported 1 position, 0 chats, 1 setting.';
const SKIPPED = 'Not imported: bogus';
/** The classes the report has while it shows. */
const SHOWN = ['flex', 'items-start', 'gap-1.5', 'text-[11px]', 'leading-relaxed'];

const fileInput = () => document.querySelector('input[type="file"]');
const pick = (backup) => fireEvent.change(fileInput(), {
  target: { files: [new File([JSON.stringify(backup)], 'b.json', { type: 'application/json' })] },
});

describe('BackupTab: the status region for an import', () => {
  it('is there, empty and visually hidden, before an import', async () => {
    const { container } = render(withContexts(<BackupTab />));
    const status = within(container).getByRole('status');
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveClass('sr-only', { exact: true });
    await expectNoAxeViolations(container);
  });

  it('holds the report in the same node, with the classes it shows with, and is emptied by a "no"', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(withContexts(<BackupTab />));
    const status = within(container).getByRole('status');

    pick(BACKUP);
    await within(container).findByText(REPORT);
    expect(within(container).getByRole('status')).toBe(status);
    expect(within(status).getByText(REPORT)).toBeInTheDocument();
    expect(within(status).getByText(SKIPPED)).toBeInTheDocument();
    expect(status).toHaveClass(...SHOWN);
    expect(status).not.toHaveClass('sr-only');
    await expectNoAxeViolations(container);

    confirm.mockReturnValue(false);
    pick(BACKUP);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(status).toBeEmptyDOMElement());
    expect(within(container).getByRole('status')).toBe(status);
    expect(status).toHaveClass('sr-only', { exact: true });
  });
});
