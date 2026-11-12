// src/components/CollapsibleSection.a11y.test.jsx — a collapsible section for a screen reader: the title is a level-2
// heading that holds the toggle (the accordion pattern), so moving by headings lands on the toggle, and a chart's h3
// inside the section follows an h2 instead of the page's h1. While the section is open, the toggle's aria-controls
// names its content, a region labelled by the toggle; collapsed, the content is not rendered, so there is neither.
// axe finds nothing open, from the page's h1 to an h3 inside (heading-order among the best practices), nor collapsed,
// nor open with noPadding and a badge. The stored choice and the padding are CollapsibleSection.test.jsx's.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChartNoAxesColumn } from 'lucide-react';
import CollapsibleSection from './CollapsibleSection.jsx';
import { expectNoAxeViolations } from '../test/a11y.js';

const TITLE = 'Charts';
const BODY = 'Section body';
// The preference `section_a11y`: the setup clears localStorage after every test.
const ID = 'a11y';

function renderSection(props = {}, body = <p>{BODY}</p>) {
  return render(
    <CollapsibleSection id={ID} title={TITLE} icon={ChartNoAxesColumn} {...props}>
      {body}
    </CollapsibleSection>,
  );
}

describe('CollapsibleSection: the heading', () => {
  it('is a level-2 heading named by the title, holding the toggle alone', () => {
    renderSection();
    const heading = screen.getByRole('heading', { level: 2, name: TITLE });
    const toggle = within(heading).getByRole('button', { name: TITLE });
    expect([...heading.children]).toEqual([toggle]);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('CollapsibleSection: the content', () => {
  it('while open is a region labelled by the toggle, which names it in aria-controls; collapsed, neither', async () => {
    const user = userEvent.setup();
    renderSection();
    const toggle = screen.getByRole('button', { name: TITLE });
    const region = screen.getByRole('region', { name: TITLE });
    expect(region).toHaveAttribute('aria-labelledby', toggle.id);
    expect(document.getElementById(toggle.getAttribute('aria-controls'))).toBe(region);
    expect(within(region).getByText(BODY)).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('region')).toBeNull();

    await user.click(toggle);
    expect(document.getElementById(toggle.getAttribute('aria-controls')))
      .toBe(screen.getByRole('region', { name: TITLE }));
  });
});

describe('CollapsibleSection: axe', () => {
  it('finds nothing open, heading-order included, from the page h1 through the section to an h3 inside', async () => {
    const { container } = render(
      <div>
        <h1>Order Flow</h1>
        <CollapsibleSection id={ID} title={TITLE}>
          <h3>Gamma Exposure by Strike</h3>
        </CollapsibleSection>
      </div>,
    );
    await expectNoAxeViolations(container, { bestPractices: true });
  });

  it('Pin: finds nothing collapsed', async () => {
    const { container } = renderSection({ defaultOpen: false });
    expect(screen.getByRole('button', { name: TITLE })).toHaveAttribute('aria-expanded', 'false');
    await expectNoAxeViolations(container, { bestPractices: true });
  });

  it('Pin: finds nothing open with noPadding and a badge', async () => {
    const { container } = renderSection({ noPadding: true, badge: <span>Loading...</span> });
    await expectNoAxeViolations(container, { bestPractices: true });
  });
});
