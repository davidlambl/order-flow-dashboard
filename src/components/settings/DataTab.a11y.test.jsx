// src/components/settings/DataTab.a11y.test.jsx — the Data tab rendered alone under the two app contexts
// (src/test/contexts.jsx; it reads MarketContext's data source), as a screen reader and a pointer meet it: the Tradier
// and Finnhub key fields named by their visible labels, each label focusing its own field, each field described by the
// hint under it, nothing missing for axe; the fields still found by their placeholders (Pin).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withContexts } from '../../test/contexts.jsx';
import { expectLabelledControls, expectNoAxeViolations } from '../../test/a11y.js';
import DataTab from './DataTab.js';

const TRADIER_PLACEHOLDER = 'Paste for real-time data...';
const FINNHUB_PLACEHOLDER = 'Paste for news, earnings, analyst data...';

const renderTab = () => render(withContexts(<DataTab />, { market: { dataSource: 'cboe' } }));

describe('DataTab', () => {
  it('names both key fields with their visible labels and describes each with its hint, with nothing missing for axe', async () => {
    const { container } = renderTab();
    expectLabelledControls(container);
    const tradier = screen.getByLabelText('Tradier API Key');
    const finnhub = screen.getByLabelText('Finnhub API Key');
    expect(tradier).toBe(screen.getByPlaceholderText(TRADIER_PLACEHOLDER));
    expect(finnhub).toBe(screen.getByPlaceholderText(FINNHUB_PLACEHOLDER));
    expect(tradier).toHaveAccessibleDescription('A free sandbox key works for testing — get one at tradier.com.');
    expect(finnhub).toHaveAccessibleDescription(
      'Free API key from finnhub.io. Powers the Research panel and AI Co-Pilot context.',
    );
    await expectNoAxeViolations(container);
  });

  it('focuses each key field when its own label is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByText('Finnhub API Key'));
    expect(screen.getByPlaceholderText(FINNHUB_PLACEHOLDER)).toHaveFocus();
    await user.click(screen.getByText('Tradier API Key'));
    expect(screen.getByPlaceholderText(TRADIER_PLACEHOLDER)).toHaveFocus();
  });

  it('Pin: both key fields are still found by their placeholders', () => {
    renderTab();
    expect(screen.getByPlaceholderText(TRADIER_PLACEHOLDER)).toHaveAttribute('type', 'password');
    expect(screen.getByPlaceholderText(FINNHUB_PLACEHOLDER)).toHaveAttribute('type', 'password');
  });
});
