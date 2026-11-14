// src/test/viewport.js — window.matchMedia for the dom tests, which jsdom 30 lacks, over an emulated viewport width.
// setup.js installs it once per test file and calls resetViewport() after every test, so each test starts on a desktop
// (DESKTOP_WIDTH, the sidebar layout every older test assumes) with no media-query listener left from the one before.
// A test switches to a phone with setViewportWidth(PHONE_WIDTH), inside act() when a rendered component listens.
//
// What it answers: `(min-width: N)` and `(max-width: N)`, N in px, rem or em (16px each, the initial font size that
// media queries use; Tailwind 4's `md` is 48rem), alone or joined by `and`. Anything else does not match: another
// feature (prefers-reduced-motion, hover, …), a media type, `not`, a comma list, a range such as `(width >= 48rem)`.
// Nothing in Phase 6 reads one from JavaScript, and recharts, which asks for prefers-reduced-motion, gets the false it
// got when matchMedia was missing. Only matchMedia sees the width: window.innerWidth stays jsdom's 1024 and no
// `resize` fires, so the code under test reads the viewport through matchMedia.
//
// A MediaQueryList here is an EventTarget with `matches` (live, read against the width at each read), `media`,
// `onchange`, the legacy addListener / removeListener, and a `change` event that carries `matches` and `media`.
// setViewportWidth() fires `change` synchronously, oldest list first, on every list whose `matches` flipped since its
// last event (or its creation), as a browser does at its next rendering step.

import { markStandIn } from './standins.js';

export const DESKTOP_WIDTH = 1280;
export const PHONE_WIDTH = 375;

const PX_PER_REM = 16;
const WIDTH_FEATURE = /^\(\s*(min|max)-width\s*:\s*(\d*\.?\d+)\s*(px|rem|em)?\s*\)$/i;

let viewportWidth = DESKTOP_WIDTH;
/** Every list made since the last reset, oldest first, with the `matches` its last `change` (or its creation) told. */
const live = new Map();

/** Whether `query` matches at `width`: only (min|max)-width features, alone or joined by `and`. */
function evaluate(query, width) {
  return query.trim().split(/\s+and\s+/i).every((part) => {
    const feature = WIDTH_FEATURE.exec(part);
    if (!feature) return false;
    const [, bound, number, unit = ''] = feature;
    const n = Number(number);
    if (!unit && n !== 0) return false; // a length needs a unit, except 0
    const px = unit.toLowerCase() === 'px' ? n : n * PX_PER_REM;
    return bound.toLowerCase() === 'min' ? width >= px : width <= px;
  });
}

class StandInMediaQueryList extends EventTarget {
  #media;
  #onchange = null;
  #handler = null;

  constructor(media) {
    super();
    this.#media = media;
  }

  get media() {
    return this.#media;
  }

  get matches() {
    return evaluate(this.#media, viewportWidth);
  }

  get onchange() {
    return this.#onchange;
  }

  set onchange(handler) {
    if (this.#handler) this.removeEventListener('change', this.#handler);
    this.#onchange = typeof handler === 'function' ? handler : null;
    this.#handler = this.#onchange && ((event) => this.#onchange.call(this, event));
    if (this.#handler) this.addEventListener('change', this.#handler);
  }

  addListener(listener) {
    this.addEventListener('change', listener);
  }

  removeListener(listener) {
    this.removeEventListener('change', listener);
  }
}

const matchMediaStandIn = markStandIn(function matchMedia(query) {
  const list = new StandInMediaQueryList(String(query));
  live.set(list, list.matches);
  return list;
});

/** Installs window.matchMedia when the environment has none (jsdom 30). setup.js calls it. */
export function installMatchMedia() {
  if (typeof window.matchMedia === 'function') return;
  window.matchMedia = matchMediaStandIn;
}

/**
 * Sets the emulated viewport width, re-evaluates every live MediaQueryList and fires `change` on those whose `matches`
 * flipped. A test whose rendered component listens wraps the call in act().
 * @param {number} px
 */
export function setViewportWidth(px) {
  if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) {
    throw new TypeError(`setViewportWidth: a width in px, a positive number; got ${String(px)}`);
  }
  viewportWidth = px;
  for (const [list, told] of live) {
    const matches = list.matches;
    if (matches === told) continue;
    live.set(list, matches);
    const event = new Event('change');
    Object.defineProperties(event, { matches: { value: matches, enumerable: true }, media: { value: list.media, enumerable: true } });
    list.dispatchEvent(event);
  }
}

/** Back to DESKTOP_WIDTH with no listener left. setup.js calls it after every test. */
export function resetViewport() {
  // A list from an earlier test may still be referenced, never notified again: its listeners are as good as gone.
  live.clear();
  viewportWidth = DESKTOP_WIDTH;
}
