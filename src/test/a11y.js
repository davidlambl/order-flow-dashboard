// src/test/a11y.js — the accessibility assertions of the dom tests (Phase 6):
// - expectNoAxeViolations(container, options) runs axe-core's WCAG 2.0 / 2.1 / 2.2 A and AA rules (and its
//   best-practice rules on request) over a rendered container, and rejects with a readable list of what it found;
// - expectLabelledControls(container) throws unless every input, select and textarea has a programmatic label that is
//   not its placeholder: axe's own `label` rule accepts a placeholder, so a clean axe run cannot prove that.
//
// What they see. jsdom has the DOM, the attributes, its user-agent stylesheet, inline styles and focusability, so axe
// judges names, roles and ARIA, labels, headings and landmarks, nesting and focusable content hidden from the tree.
// jsdom has no layout (every box is 0×0, every scroll size 0), no computed colours and no canvas, and the tests load
// no stylesheet. So:
// - Contrast, target sizes, overflow, scrolling, focus order and anything else geometric are NOT checked here: the
//   rules for them are switched off below, each with its reason, and the lead measures them per state in a real
//   browser (the table in .claude/PLAN-phase-6.md, Baseline). A clean run here says nothing about them.
// - Every element counts as rendered: Tailwind's hidden, sr-only, md:… and opacity classes do nothing here. Only the
//   `hidden` attribute, aria-hidden, inert, inline styles and a closed <dialog> hide anything.
// - The context decides what is judged. Testing Library's `container` for a component. For a whole page with
//   `bestPractices`, its `baseElement` (document.body): axe judges `region` (content outside every landmark) only from
//   there. `document.documentElement` adds the page rules (page-has-heading-one, landmark-one-main, bypass) and also
//   document-title and html-has-lang, which jsdom's blank page fails: such a call disables those two, with the comment.
//   A dialog rendered through a portal is outside `container`: pass `baseElement`.
// - The container must be attached to the document (axe needs a connected node): a detached one is refused, by name.
// - One call per rendered state, not one per test: each call is a full axe run (tens of milliseconds over the whole
//   dashboard, plus axe-core's load once per file), and the assertion is about a state, not a step.
// - axe-core waits on setTimeout between rules: under fake timers that do not advance by themselves it would hang until
//   the test times out, so the call refuses them, by name. This repo's recipe, vi.useFakeTimers({ shouldAdvanceTime:
//   true }), and a clock that fakes Date alone both work.
// - Importing axe-core leaves its document.elementsFromPoint polyfill on the test document; it throws if called
//   (jsdom has no elementFromPoint), and nothing in the app or the testing libraries calls it.
import axe from 'axe-core';
import { vi } from 'vitest';

/** The rule tags every call runs: WCAG 2.0, 2.1 and 2.2, levels A and AA. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * The rules jsdom cannot evaluate, off at every call. Each would error (an "incomplete" result, which never fails a
 * test), never apply, or pass whatever the page does.
 */
const JSDOM_CANNOT_EVALUATE = {
  'color-contrast': 'no computed colours and no layout; it also errors, wanting a canvas to measure icon fonts',
  'link-in-text-block': 'no computed colours or pseudo-element styles, and no link counts as on screen: never applies',
  'label-content-name-mismatch': 'it needs a canvas to tell an icon ligature from text, and errors without one',
  'target-size': 'every box is 0×0, so it passes a target of any size',
  'scrollable-region-focusable': 'every scroll size is 0, so no region ever scrolls: never applies',
  'skip-link': 'it applies only to a link placed off-screen, which needs layout: never applies (best-practice)',
};

const OFF = Object.fromEntries(Object.keys(JSDOM_CANNOT_EVALUATE).map((id) => [id, { enabled: false }]));

/** Most nodes listed per violated rule, and most characters of a node's HTML, in a failure message. */
const NODES_SHOWN = 10;
const HTML_CHARS = 160;

// Captured at import, before a test can install fake timers.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Whether a setTimeout callback runs by itself now: real timers, fake ones with shouldAdvanceTime, or Date alone. */
function timersRun() {
  if (!vi.isFakeTimers()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const fake = setTimeout(() => {
      realClearTimeout(real);
      resolve(true);
    }, 0);
    const real = realSetTimeout(() => {
      clearTimeout(fake);
      resolve(false);
    }, 250);
  });
}

/**
 * Runs `run` with document.elementFromPoint answering that nothing is at any point, which is what a page without
 * layout is. Before it judges aria-hidden-focus, page-has-heading-one and landmark-one-main, axe looks for an overlay
 * covering the page through its own elementsFromPoint polyfill, which calls elementFromPoint; jsdom has none, so those
 * rules would error, and aria-hidden-focus could never report a focusable element hidden from the tree. An open
 * <dialog> or [aria-modal] still counts as an overlay: axe finds those first, without the point test.
 */
async function withNothingAtAnyPoint(run) {
  if (typeof document.elementFromPoint === 'function') return run();
  document.elementFromPoint = () => null;
  try {
    return await run();
  } finally {
    delete document.elementFromPoint;
  }
}

const clip = (html) => (html.length > HTML_CHARS ? `${html.slice(0, HTML_CHARS - 1)}…` : html);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The first line of axe's failure summary ("Fix any of the following:") with its first reason, and how many more. */
function firstReason(summary = '') {
  const [head = '', first, ...rest] = summary.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!first) return head;
  const more = rest.filter((line) => !/^Fix (any|all) of the following:$/.test(line)).length;
  return `${head} ${first}${more ? ` (+${more} more)` : ''}`;
}

function describeViolations(violations) {
  const nodes = violations.reduce((sum, rule) => sum + rule.nodes.length, 0);
  const lines = [`expectNoAxeViolations: ${plural(violations.length, 'rule')} violated, on ${plural(nodes, 'node')}:`];
  for (const rule of violations) {
    lines.push('', `${rule.id} [${rule.impact}] ${rule.help} (${plural(rule.nodes.length, 'node')})`);
    for (const node of rule.nodes.slice(0, NODES_SHOWN)) {
      lines.push(`  - ${node.target.flat().join(' ')}`, `    ${firstReason(node.failureSummary)}`, `    ${clip(node.html)}`);
    }
    if (rule.nodes.length > NODES_SHOWN) lines.push(`  … and ${rule.nodes.length - NODES_SHOWN} more`);
  }
  return lines.join('\n');
}

function requireElement(helper, container) {
  if (!(container instanceof Element)) {
    throw new TypeError(`${helper}: expected an Element (Testing Library's container or baseElement), got ${String(container)}`);
  }
}

/**
 * Runs axe-core over a rendered container and fails with a readable list if any rule is violated.
 * @param {Element} container
 * @param {{ bestPractices?: boolean, disable?: string[] }} [options]
 *   bestPractices: also run axe's "best-practice" rules (heading order, landmarks, regions). Off by default: they
 *     judge a whole page, and most tests render one component. A test that renders App turns it on.
 *   disable: rule ids to skip in this call, each needing a comment at the call site saying why.
 * @returns {Promise<void>}
 */
export async function expectNoAxeViolations(container, options) {
  const { bestPractices = false, disable = [] } = options ?? {};
  requireElement('expectNoAxeViolations', container);
  if (!container.isConnected) {
    throw new Error('expectNoAxeViolations: the container is not attached to the document, and axe needs a connected '
      + 'node. Render it with Testing Library (which attaches its container to document.body) or append it first.');
  }
  if (!(await timersRun())) {
    throw new Error('expectNoAxeViolations: fake timers are installed and do not advance by themselves, and axe-core '
      + 'waits on setTimeout, so it would hang. Call it under real timers, or install them with '
      + 'vi.useFakeTimers({ shouldAdvanceTime: true }).');
  }
  const results = await withNothingAtAnyPoint(() => axe.run(container, {
    runOnly: { type: 'tag', values: bestPractices ? [...WCAG_TAGS, 'best-practice'] : WCAG_TAGS },
    rules: { ...OFF, ...Object.fromEntries(disable.map((id) => [id, { enabled: false }])) },
    resultTypes: ['violations'],
  }));
  if (results.violations.length) throw new Error(describeViolations(results.violations));
}

// ── Labels ──

/** Inputs that take no label: they are not shown, or their value or alt is their name. */
const UNLABELLED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/** Whether `el` and its subtree are out of the accessibility tree in a way jsdom can see. */
const hiddenFromTree = (el) => el.hasAttribute('hidden')
  || el.getAttribute('aria-hidden') === 'true'
  || getComputedStyle(el).display === 'none';

/**
 * The text an assistive technology reads from `node`'s subtree, roughly: its text, a descendant's aria-label or an
 * image's alt in place of the descendant's content, nothing hidden from the tree, and nothing of `control` itself (a
 * label wraps its control, and the control's own value or options are not its name).
 */
function textOf(node, control) {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.data;
    else if (child.nodeType === Node.ELEMENT_NODE && child !== control && !hiddenFromTree(child)) {
      const named = child.getAttribute('aria-label')?.trim() || (child.localName === 'img' ? child.getAttribute('alt') : '');
      text += ` ${named || textOf(child, control)} `;
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** The element with id `id` in `control`'s tree, as aria-labelledby resolves it. */
function byId(control, id) {
  const root = control.getRootNode();
  if (typeof root.getElementById === 'function') return root.getElementById(id);
  return [root, ...root.querySelectorAll('[id]')].find((el) => el.id === id) ?? null;
}

const labelledByIds = (control) => (control.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);

/** The control's label text from the three sources that count, '' when none gives any. */
function labelText(control) {
  const ariaLabel = control.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;
  const labelledBy = labelledByIds(control)
    .map((id) => byId(control, id))
    .filter(Boolean)
    .map((el) => el.getAttribute('aria-label')?.trim() || textOf(el, control))
    .join(' ')
    .trim();
  if (labelledBy) return labelledBy;
  for (const label of control.labels ?? []) {
    const text = textOf(label, control);
    if (text) return text;
  }
  return '';
}

/** What the control has instead of a label, for the failure message. */
function whyUnlabelled(control) {
  const found = [];
  const labels = control.labels?.length ?? 0;
  if (labels) found.push(`${plural(labels, '<label>')} with no text`);
  const ids = labelledByIds(control);
  if (ids.length) found.push(`aria-labelledby="${ids.join(' ')}", which resolves to no text`);
  if (control.hasAttribute('aria-label')) found.push('an empty aria-label');
  if (control.getAttribute('placeholder')) found.push(`placeholder "${control.getAttribute('placeholder')}", not a label`);
  if (control.getAttribute('title')) found.push(`title "${control.getAttribute('title')}", not a label`);
  return found.length ? `has ${found.join('; ')}` : 'has no <label>, aria-label or aria-labelledby';
}

/**
 * Fails unless every input, select and textarea in the container has a programmatic label that is not its placeholder:
 * a <label> (wrapping it or pointing at it with htmlFor) with text, aria-labelledby resolving to text, or a non-empty
 * aria-label. A placeholder or a title does not count. Skips input types hidden, submit, button, reset and image.
 * Hidden controls are checked too (a label costs nothing, and the control shows in another state); jsdom cannot see a
 * control hidden by a CSS class anyway.
 * @param {Element} container
 * @returns {void}
 */
export function expectLabelledControls(container) {
  requireElement('expectLabelledControls', container);
  const unlabelled = [...container.querySelectorAll('input, select, textarea')]
    .filter((control) => !(control.localName === 'input' && UNLABELLED_TYPES.has(control.type)))
    .filter((control) => !labelText(control));
  if (unlabelled.length) {
    throw new Error([
      `expectLabelledControls: ${plural(unlabelled.length, 'control')} without a programmatic label (a placeholder or a title is not one):`,
      ...unlabelled.map((control) => `  - ${clip(control.outerHTML)}\n    ${whyUnlabelled(control)}`),
    ].join('\n'));
  }
}
