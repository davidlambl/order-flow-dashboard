// src/components/settings/BackupTab.a11y.test.jsx — the Backup tab rendered alone under the two app contexts
// (src/test/contexts.jsx; it reads AuthContext): the file input behind the Import button is hidden the way a browser
// hides it (the hidden attribute, which jsdom applies, where a CSS class does nothing here) and still has a name, so
// nothing is missing for axe; a file it cannot import is announced as an alert, never as the status a finished import
// shows (BackupTab.test.jsx pins that status and the import itself).
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { withContexts } from '../../test/contexts.jsx';
import { expectLabelledControls, expectNoAxeViolations } from '../../test/a11y.js';
import BackupTab from './BackupTab.js';

const fileInput = () => document.querySelector('input[type="file"]');

describe('BackupTab', () => {
  it('hides the file input behind Import as a browser does and names it, with nothing missing for axe', async () => {
    const { container } = render(withContexts(<BackupTab />));
    expectLabelledControls(container);
    expect(screen.getByLabelText('Backup file to import')).toBe(fileInput());
    expect(fileInput()).not.toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('announces a file it cannot read as an alert, not as a status', async () => {
    const { container } = render(withContexts(<BackupTab />));
    // Not JSON: the parse fails before the import's confirm, so no window.confirm is asked.
    fireEvent.change(fileInput(), { target: { files: [new File(['not json'], 'notes.txt', { type: 'text/plain' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/is not valid JSON/);
    expect(screen.queryByRole('status')).toBeNull();
    await expectNoAxeViolations(container);
  });
});
