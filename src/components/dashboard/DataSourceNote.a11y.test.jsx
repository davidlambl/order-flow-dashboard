// src/components/dashboard/DataSourceNote.a11y.test.jsx — the note under the charts under axe, in each of its four
// sentences (demo data, Tradier, the Tradier sandbox, CBOE). A pin: the note is plain text, and none of it changed;
// DataSourceNote.test.jsx holds the sentences themselves.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import DataSourceNote from './DataSourceNote.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

describe('DataSourceNote', () => {
  it('Pin: each of its four sentences, under axe', async () => {
    const { container } = render(
      <div>
        <DataSourceNote usingMock provider="mock" />
        <DataSourceNote usingMock={false} provider="tradier" />
        <DataSourceNote usingMock={false} provider="tradier-sandbox" />
        <DataSourceNote usingMock={false} provider="cboe" />
      </div>,
    );
    expect(container.firstChild.children).toHaveLength(4);
    await expectNoAxeViolations(container);
  });
});
