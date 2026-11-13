// src/test/a11y.test.jsx — the two assertions of src/test/a11y.js on inline fixtures, never on real components (each
// component's own test file checks it). expectNoAxeViolations: a select with no name fails with its rule, impact, help, node
// count, selector, first reason and HTML (clipped at 160 characters); the same select with a label passes; skipped
// heading levels fail only with bestPractices; low contrast passes because the rule is off under jsdom (the comment
// there says why that is not a pass); disable skips a rule; a focusable button inside aria-hidden fails, which axe
// cannot judge under jsdom without the helper's elementFromPoint stand-in; a container that is not an attached Element,
// and fake timers that do not advance by themselves, are refused by name, while this repo's shouldAdvanceTime recipe
// runs. expectLabelledControls: seven ways to have no real label throw, each saying what the control has instead; a
// wrapping label, htmlFor, aria-label, aria-labelledby and a hidden input pass.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { expectLabelledControls, expectNoAxeViolations } from './a11y.js';

/** The rejection's message, or '' when the promise resolved. */
const failureOf = (promise) => promise.then(() => '', (error) => error.message);

describe('expectNoAxeViolations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects for a select with no name, naming select-name and the node', async () => {
    const { container } = render(<select className="ticker-pick"><option>AVGO</option></select>);
    const message = await failureOf(expectNoAxeViolations(container));
    expect(message).toContain('1 rule violated, on 1 node');
    expect(message).toContain('select-name [critical] Select element must have an accessible name (1 node)');
    expect(message).toMatch(/^ {2}- \S*select\S*$/m); // the node's selector
    expect(message).toMatch(/^ {4}Fix any of the following: Element does not have an implicit \(wrapped\) <label> \(\+\d+ more\)$/m);
    expect(message).toContain('    <select class="ticker-pick"><option>AVGO</option></select>');
  });

  it('resolves for the same select with a label', async () => {
    const { container } = render(<label>Model <select className="ticker-pick"><option>AVGO</option></select></label>);
    await expect(expectNoAxeViolations(container)).resolves.toBeUndefined();
  });

  it("clips a node's HTML to 160 characters", async () => {
    // About 220 characters: axe hands HTML up to 300 over whole, so the clip is the helper's.
    const { container } = render(<select className={'w-full '.repeat(25)}><option>AVGO</option></select>);
    const html = (await failureOf(expectNoAxeViolations(container))).split('\n').find((line) => line.startsWith('    <select'));
    expect(html.trim()).toHaveLength(160);
    expect(html.endsWith('…')).toBe(true);
  });

  it('rejects for skipped heading levels only with bestPractices', async () => {
    const { container } = render(<div><h1>Dashboard</h1><h3>Gamma exposure by strike</h3></div>);
    await expect(expectNoAxeViolations(container)).resolves.toBeUndefined();
    const message = await failureOf(expectNoAxeViolations(container, { bestPractices: true }));
    expect(message).toContain('heading-order [moderate] Heading levels should only increase by one (1 node)');
  });

  it('resolves for text whose contrast fails in a browser: the rule is off under jsdom', async () => {
    // Not a pass: jsdom has no computed colours and no layout, so color-contrast is switched off here (left on, it
    // would error into an "incomplete" result, which never fails a test either). Grey on grey, about 1.3:1, is for the
    // lead's real-browser table to catch.
    const { container } = render(<p style={{ color: '#777777', backgroundColor: '#888888' }}>Net premium</p>);
    await expect(expectNoAxeViolations(container)).resolves.toBeUndefined();
  });

  it('skips a rule named in disable', async () => {
    const { container } = render(<select><option>AVGO</option></select>);
    // The fixture's one violation is select-name: disabling it is what this test is about.
    await expect(expectNoAxeViolations(container, { disable: ['select-name'] })).resolves.toBeUndefined();
  });

  // axe looks for an overlay through document.elementFromPoint before it judges aria-hidden-focus; jsdom has none, so
  // without the helper's stand-in for it the rule errors into "incomplete" and this resolves.
  it('rejects for a focusable button inside aria-hidden (aria-hidden-focus)', async () => {
    const { container } = render(<div aria-hidden="true"><button type="button">Clear chat</button></div>);
    const message = await failureOf(expectNoAxeViolations(container));
    expect(message).toContain('aria-hidden-focus [serious]');
    expect(document.elementFromPoint).toBeUndefined(); // the stand-in lives for the run only
  });

  it('refuses a container that is not an attached Element, by name', async () => {
    const detached = document.createElement('div');
    detached.append(document.createElement('select'));
    expect(await failureOf(expectNoAxeViolations(detached))).toMatch(/not attached to the document, and axe needs a connected node/);
    const view = render(<select><option>AVGO</option></select>);
    expect(await failureOf(expectNoAxeViolations(view))).toMatch(/expected an Element/); // the render result, not its container
  });

  it('refuses fake timers that do not advance by themselves, and runs under shouldAdvanceTime', async () => {
    const { container } = render(<button type="button">Refresh</button>);
    vi.useFakeTimers();
    expect(await failureOf(expectNoAxeViolations(container))).toMatch(/fake timers .* do not advance by themselves/);
    expect(vi.getTimerCount()).toBe(0); // the probe's timer is not left behind
    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await expect(expectNoAxeViolations(container)).resolves.toBeUndefined();
  });
});

describe('expectLabelledControls', () => {
  it.each([
    ['an input with only a placeholder', <input placeholder="Avg cost" />, /has placeholder "Avg cost", not a label/],
    ['an input with only a title', <input title="Shares" />, /has title "Shares", not a label/],
    ['a <label> with no text', <label><input /></label>, /has 1 <label> with no text/],
    ['a <label> whose only content is an icon hidden from the tree',
      <><label htmlFor="key"><svg aria-hidden="true" /></label><input id="key" /></>, /has 1 <label> with no text/],
    ['an aria-labelledby naming a missing id', <input aria-labelledby="nowhere" />, /aria-labelledby="nowhere", which resolves to no text/],
    ['a <label> beside the input that neither wraps it nor points at it',
      <div><label>Shares</label><input /></div>, /has no <label>, aria-label or aria-labelledby/],
    ['a <label> around a select whose only text is its options',
      <label><select><option>AVGO</option></select></label>, /has 1 <label> with no text/],
    ['a textarea with only a placeholder', <textarea placeholder="Ask about this ticker…" />, /<textarea placeholder=/],
  ])('throws for %s', (_, ui, reason) => {
    const { container } = render(ui);
    expect(() => expectLabelledControls(container)).toThrow(/^expectLabelledControls: 1 control without a programmatic label/);
    expect(() => expectLabelledControls(container)).toThrow(reason);
  });

  it.each([
    ['a wrapping label', <label>Shares <input /></label>],
    ['htmlFor', <><label htmlFor="cost">Avg cost</label><input id="cost" placeholder="Avg cost" /></>],
    ['aria-label', <input aria-label="Stock ticker symbol" placeholder="Ticker" />],
    ['aria-labelledby resolving to text', <><span id="cost-label">Cost basis</span><input aria-labelledby="cost-label" /></>],
    ['an <input type="hidden"> with nothing', <input type="hidden" name="nonce" />],
  ])('passes for %s', (_, ui) => {
    const { container } = render(ui);
    expect(() => expectLabelledControls(container)).not.toThrow();
  });

  it('lists every unlabelled control, and checks submit-like inputs not at all', () => {
    const { container } = render(
      <form>
        <input placeholder="Ticker" />
        <select><option>AVGO</option></select>
        <input type="submit" value="Go" />
        <input type="image" alt="Search" src="search.svg" />
      </form>,
    );
    expect(() => expectLabelledControls(container)).toThrow(/^expectLabelledControls: 2 controls without/);
  });
});
