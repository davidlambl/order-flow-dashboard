// src/components/chat/ContextInspector.a11y.test.jsx — the model context shown in place of the messages, for a screen
// reader: its Copy button is named by its own text ("Copy", then "Copied"), the context is text in a <pre>, and axe
// finds nothing, before a copy and during the flash. The button's size is measured in a browser.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContextInspector from './ContextInspector.js';
import { expectLabelledControls, expectNoAxeViolations } from '../../test/a11y.js';

const build = () => 'TICKER: AVGO\nSPOT: 101.50\n';

describe('ContextInspector', () => {
  it('Pin: Copy is named by its text, Copied after a click, and the context is text', async () => {
    const user = userEvent.setup();
    const { container } = render(<ContextInspector buildContext={vi.fn(build)} />);
    expect(container.querySelector('pre')).toHaveTextContent('TICKER: AVGO SPOT: 101.50');
    expectLabelledControls(container);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('Pin: axe finds nothing, before a copy and during the flash', async () => {
    const user = userEvent.setup();
    const { container } = render(<ContextInspector buildContext={vi.fn(build)} />);
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await expectNoAxeViolations(container);
  });
});
