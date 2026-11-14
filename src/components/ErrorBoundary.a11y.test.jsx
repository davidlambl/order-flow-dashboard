// src/components/ErrorBoundary.a11y.test.jsx — the root boundary's recovery screen, which replaces the whole page, for
// a screen reader: it is the page's main landmark; inside it an alert holds the h1, the sentence and Reload Dashboard
// (its name kept), so the failure is announced as it appears; the warning sign is decoration. axe finds nothing over
// the whole document, the page rules included. A child that throws on render brings the screen up; React and the
// boundary report the error on console.error, silenced here.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary.jsx';
import { expectNoAxeViolations } from '../test/a11y.js';

function Bug() {
  throw new Error('render bug');
}

/** The recovery screen, brought up by a render error. */
function renderFallback() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return render(<ErrorBoundary><Bug /></ErrorBoundary>);
}

describe('ErrorBoundary: the recovery screen', () => {
  it('is announced: an alert holding the heading, the sentence and Reload Dashboard', () => {
    renderFallback();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    expect(alert).toHaveTextContent('An unexpected error occurred. Your data is safe — try reloading.');
    expect(within(alert).getByRole('button', { name: 'Reload Dashboard' })).toBeInTheDocument();
  });

  it("is the page's main landmark, and its warning sign is decoration", () => {
    const { container } = renderFallback();
    const main = screen.getByRole('main');
    expect(main).toBe(container.firstChild);
    expect(within(main).getByRole('alert')).toBeInTheDocument();
    expect(within(main).getByText('⚠️')).toHaveAttribute('aria-hidden', 'true');
  });

  it('axe finds nothing over the whole document, the page rules included', async () => {
    renderFallback();
    // jsdom's blank page has no <title> and no lang on <html>: those two rules judge the document, not the screen.
    await expectNoAxeViolations(document.documentElement, { bestPractices: true, disable: ['document-title', 'html-has-lang'] });
  });
});
