#!/usr/bin/env node
// scripts/check-bundle.js
// The bundle budget, checked on the built dist/ after every build (`npm run check:bundle`, which `npm run check` and CI
// run after `npm run build`):
//
//   node scripts/check-bundle.js [dist]
//
// Code-splitting is easy to undo without anything noticing: one static import of a chart, of the markdown renderer or
// of a package only they use puts its whole library back on the startup path, and the app still builds, renders and
// passes its tests. This measures what the page downloads before its first render, and fails when the entry chunk or
// the startup path as a whole is over budget, or when a library meant to load on demand is on it.
//
// The startup path is the entry chunk and every chunk it imports statically, directly or through another: Vite's build
// manifest (dist/.vite/manifest.json, build.manifest in vite.config.js) records each chunk's static `imports` apart
// from its `dynamicImports`, and dist/index.html loads exactly that set, the entry as its module script and the rest as
// modulepreload links. The two are compared before the numbers are trusted. Every other script in dist/assets loads on
// demand. Sizes are bytes on disk, shown in kB of 1000 bytes cut to two decimals as Vite's build output prints them,
// and each rule compares the figure it shows.
//
// Exit code: 0 within budget; 1 over it, with a line per broken rule saying what to look at; 2 when the build cannot
// be measured (no dist/ or manifest, no entry, a manifest that dist/ or its index.html contradicts).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The entry chunk, index.html's module script: the app's own code and every library outside a vendor group.
const ENTRY_KB = 350;

// Initial JS: everything the page downloads before its first render, the entry included. It measured 654.82 kB once
// the charts and the markdown renderer loaded on demand, React and the Supabase SDK most of it (218.75 and 214.38):
// recharts (385.92) or the markdown graph (153.22) back on the startup path breaks the budget, ordinary growth does not.
const INITIAL_JS_KB = 700;

// Vendor groups (codeSplitting.groups in vite.config.js; a group's chunk carries its name) that only lazily loaded
// parts of the page import, the charts and the chat's replies, so their chunks must never be on the startup path.
const ON_DEMAND_GROUPS = ['recharts', 'markdown'];

/** The limits evaluateBudget applies, in kB of 1000 bytes. */
export const BUDGET = Object.freeze({
  entryKb: ENTRY_KB,
  initialKb: INITIAL_JS_KB,
  onDemandGroups: Object.freeze(ON_DEMAND_GROUPS),
});

/** The build cannot be measured; the message says why and what to do. */
export class BundleCheckError extends Error {
  name = 'BundleCheckError';
}

/**
 * A record of Vite's build manifest, keyed by its source path (an entry, a dynamically imported module) or by
 * `_<file name>` (a chunk of its own, such as a vendor group's).
 * @typedef {object} ManifestChunk
 * @property {string} file  the emitted file, relative to dist/
 * @property {string} [name]  the chunk's name: a vendor group's chunk carries the group's
 * @property {string} [src]  the source module, for an entry or a dynamically imported module
 * @property {boolean} [isEntry]
 * @property {string[]} [imports]  the keys of the chunks it imports statically
 * @property {string[]} [dynamicImports]  the keys of the modules it imports with import()
 */

/** @typedef {Record<string, ManifestChunk>} Manifest */

/**
 * A script of the build, measured.
 * @typedef {object} Chunk
 * @property {string} file  relative to dist/
 * @property {number} bytes
 * @property {string} [name]  its name in the manifest, if it has a record there
 */

/** @typedef {Chunk & { path: string[] }} StartupChunk  with how the entry reaches it, from index.html on */

/**
 * @typedef {object} Measurement
 * @property {Chunk} entry
 * @property {StartupChunk[]} startup  the entry's static closure, largest first
 * @property {number} initialBytes  the entry and its static closure
 * @property {Chunk[]} onDemand  every other script in dist/assets, largest first
 */

const KB = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Bytes as Vite's build output prints them: kB of 1000 bytes, cut (not rounded) to two decimals. */
const kb = (/** @type {number} */ bytes) => KB.format(Math.trunc(bytes / 10) / 100);

/** Whether `bytes` shows as more than `limitKb`. */
const over = (/** @type {number} */ bytes, /** @type {number} */ limitKb) => Math.trunc(bytes / 10) > limitKb * 100;

const fileCount = (/** @type {number} */ count) => `${count} ${count === 1 ? 'file' : 'files'}`;

// A comment, a whole script element (its text is never markup) or a link tag; then one attribute at a time.
const TAG = /<!--[\s\S]*?-->|<script\b([^>]*)>[\s\S]*?<\/script\s*>|<link\b([^>]*)>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** @param {string} source  a tag's attributes, as written */
function attributes(source) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const [, name, double, single, bare] of source.matchAll(ATTRIBUTE)) {
    found[name.toLowerCase()] = double ?? single ?? bare ?? '';
  }
  return found;
}

/**
 * The scripts an HTML page loads before it runs: the src of each module script and the href of each modulepreload
 * link, in document order. Classic and inline scripts, other links and comments load nothing at startup.
 * @param {string} html
 * @returns {{ scripts: string[], preloads: string[] }}
 */
export function parseIndexHtml(html) {
  const scripts = [];
  const preloads = [];
  for (const [, script, link] of html.matchAll(TAG)) {
    if (script !== undefined) {
      const { type, src } = attributes(script);
      if (type?.toLowerCase() === 'module' && src) scripts.push(src);
    } else if (link !== undefined) {
      const { rel, href } = attributes(link);
      if (rel?.toLowerCase().split(/\s+/).includes('modulepreload') && href) preloads.push(href);
    }
  }
  return { scripts, preloads };
}

/**
 * The key of the manifest's one entry record (isEntry): index.html's, in an app.
 * @param {Manifest} manifest
 */
export function findEntry(manifest) {
  const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry === true);
  if (entries.length === 1) return entries[0];
  throw new BundleCheckError(entries.length === 0
    ? 'the manifest has no entry record (isEntry): this check reads the build of an app, whose entry is index.html'
    : `the manifest has ${entries.length} entry records (${entries.join(', ')}): this check measures one page`);
}

/**
 * Every chunk that `from` imports statically, directly or through another, nearest first: the keys of the map, each
 * mapped to the key of the chunk that first imports it. Each chunk counts once, a cycle ends the walk, and `from` is
 * never part of it, even where a chunk imports it back. Dynamic imports are not followed: they load on demand.
 * @param {Manifest} manifest
 * @param {string} from
 * @returns {Map<string, string>}
 */
export function staticClosure(manifest, from) {
  /** @type {Map<string, string>} */
  const importedBy = new Map();
  const queue = [from];
  for (let i = 0; i < queue.length; i += 1) {
    const importer = queue[i];
    if (!Object.hasOwn(manifest, importer)) {
      const by = importedBy.get(importer);
      throw new BundleCheckError(`the manifest has no record of ${importer}${by ? `, which its ${by} imports` : ''}: `
        + 'run npm run build again');
    }
    for (const key of manifest[importer].imports ?? []) {
      if (key === from || importedBy.has(key)) continue;
      importedBy.set(key, importer);
      queue.push(key);
    }
  }
  return importedBy;
}

/** Largest first; by file between equals, so the order never depends on the manifest's. */
const bySize = (/** @type {Chunk} */ a, /** @type {Chunk} */ b) => b.bytes - a.bytes || (a.file < b.file ? -1 : 1);

const SCRIPT = /\.m?js$/;

/**
 * Splits the build into the startup path (the entry and its static closure) and what loads on demand: every other
 * script in dist/assets.
 * @param {Manifest} manifest
 * @param {Map<string, number>} sizes  the bytes of every file in dist/assets, keyed like the manifest's `file`
 * @returns {Measurement}
 */
export function measureBundle(manifest, sizes) {
  const entryKey = findEntry(manifest);
  const closure = staticClosure(manifest, entryKey);
  /**
   * @param {string} key
   * @returns {Chunk}
   */
  const chunk = (key) => {
    const { file, name } = manifest[key];
    const bytes = sizes.get(file);
    if (bytes === undefined) {
      throw new BundleCheckError(`the manifest names ${file}, which dist/ does not have: run npm run build again`);
    }
    return { file, bytes, name };
  };
  /** @param {string} key */
  const label = (key) => manifest[key].src ?? manifest[key].file;
  /** @param {string} key */
  const pathTo = (key) => {
    const path = [label(key)];
    for (let by = closure.get(key); by !== undefined; by = closure.get(by)) path.unshift(label(by));
    return path;
  };

  const entry = chunk(entryKey);
  const startup = [...closure.keys()].map((key) => ({ ...chunk(key), path: pathTo(key) })).sort(bySize);
  const onStartup = new Set([entry.file, ...startup.map(({ file }) => file)]);
  const names = new Map(Object.values(manifest).map(({ file, name }) => [file, name]));
  const onDemand = [...sizes]
    .filter(([file]) => SCRIPT.test(file) && !onStartup.has(file))
    .map(([file, bytes]) => ({ file, bytes, name: names.get(file) }))
    .sort(bySize);
  const initialBytes = startup.reduce((total, { bytes }) => total + bytes, entry.bytes);
  return { entry, startup, initialBytes, onDemand };
}

/**
 * Where dist/index.html and the manifest disagree on the startup path: a script the page loads (its module script
 * and modulepreload links) that is neither the entry nor in its static closure, or one of those that the page does
 * not load. Empty when they agree. The page's URLs carry the build's base (`./` here); a manifest file matches the
 * URL that ends with it.
 * @param {Measurement} measurement
 * @param {{ scripts: string[], preloads: string[] }} page  parseIndexHtml's result
 * @returns {string[]}
 */
export function compareWithPage({ entry, startup }, page) {
  const files = [entry, ...startup].map(({ file }) => file);
  const urls = [...page.scripts, ...page.preloads].map((url) => url.split(/[?#]/)[0]);
  const same = (/** @type {string} */ url, /** @type {string} */ file) => url === file || url.endsWith(`/${file}`);
  return [
    ...urls.filter((url) => !files.some((file) => same(url, file)))
      .map((url) => `index.html loads ${url}, which the manifest does not put on the startup path`),
    ...files.filter((file) => !urls.some((url) => same(url, file)))
      .map((file) => `the manifest puts ${file} on the startup path, which index.html does not load`),
  ];
}

/**
 * The rules the build breaks, one line each saying what to look at; none when it is within budget.
 * @param {Measurement} measurement
 * @param {typeof BUDGET} [budget]
 * @returns {string[]}
 */
export function evaluateBudget({ entry, startup, initialBytes, onDemand }, budget = BUDGET) {
  const broken = [];
  if (over(entry.bytes, budget.entryKb)) {
    broken.push(`the entry chunk ${entry.file} is ${kb(entry.bytes)} kB, over its ${budget.entryKb} kB budget: `
      + 'see what it bundles with ANALYZE=1 npm run build (dist/stats.html), and load what the first render does not '
      + 'need lazily or give a large library the entry needs a vendor group in vite.config.js');
  }
  for (const group of budget.onDemandGroups) {
    const atStartup = startup.filter(({ name }) => name === group);
    for (const { file, path } of atStartup) {
      broken.push(`the ${group} chunk ${file} loads at startup (${path.join(' → ')}): a module on the startup path `
        + `imports a package of the ${group} vendor group (vite.config.js) statically, or one that only that group's `
        + 'packages use; import it from a lazily loaded module instead');
    }
    if (atStartup.length === 0 && !onDemand.some(({ name }) => name === group)) {
      broken.push(`the build has no ${group} chunk: vite.config.js has no vendor group of that name any more, or `
        + 'nothing imports its library, so this check cannot tell where that library went; keep ON_DEMAND_GROUPS in '
        + 'scripts/check-bundle.js in step with the groups');
    }
  }
  if (over(initialBytes, budget.initialKb)) {
    const largest = [...startup, entry].sort(bySize)[0];
    broken.push(`initial JS (${fileCount(startup.length + 1)}: the entry and what it imports statically) is `
      + `${kb(initialBytes)} kB, over its ${budget.initialKb} kB budget; the largest is ${largest.file} `
      + `(${kb(largest.bytes)} kB): load what the first render does not need lazily`);
  }
  return broken;
}

/**
 * The table the check prints: the entry, each chunk on the startup path, the initial total, then what loads on demand.
 * @param {Measurement} measurement
 * @param {typeof BUDGET} [budget]
 */
export function formatTable({ entry, startup, initialBytes, onDemand }, budget = BUDGET) {
  /** @param {Chunk} chunk */
  const note = ({ name }) => (name && budget.onDemandGroups.includes(name) ? `${name}: on demand only` : '');
  const rows = [
    ['entry', entry.file, `${kb(entry.bytes)} kB`, `at most ${budget.entryKb} kB`],
    ...startup.map((chunk) => ['startup', chunk.file, `${kb(chunk.bytes)} kB`, note(chunk)]),
    ['initial JS', fileCount(startup.length + 1), `${kb(initialBytes)} kB`, `at most ${budget.initialKb} kB`],
    ...(onDemand.length > 0
      ? onDemand.map((chunk) => ['on demand', chunk.file, `${kb(chunk.bytes)} kB`, ''])
      : [['on demand', 'none', '', '']]),
  ];
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map(([what, file, size, limit]) => (
      `  ${what.padEnd(widths[0])}  ${file.padEnd(widths[1])}  ${size.padStart(widths[2])}  ${limit}`.trimEnd()
    ))
    .join('\n');
}

/**
 * What the check reads from a built dist/: the manifest, index.html and the size of every file in dist/assets.
 * @param {string} dist
 * @returns {{ manifest: Manifest, html: string, sizes: Map<string, number> }}
 */
export function readDist(dist) {
  /** @param {string} path */
  const shown = (path) => relative(dirname(dist), path).split(sep).join('/');
  const manifestPath = join(dist, '.vite', 'manifest.json');
  const htmlPath = join(dist, 'index.html');
  if (!existsSync(dist)) throw new BundleCheckError(`no ${shown(dist)}/: run npm run build first`);
  if (!existsSync(manifestPath)) {
    throw new BundleCheckError(`no ${shown(manifestPath)}: run npm run build first, and keep build.manifest on in `
      + 'vite.config.js (this check reads the manifest)');
  }
  if (!existsSync(htmlPath)) throw new BundleCheckError(`no ${shown(htmlPath)}: run npm run build first`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = null;
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new BundleCheckError(`${shown(manifestPath)} is not a manifest (a JSON object): run npm run build again`);
  }
  /** @type {Map<string, number>} */
  const sizes = new Map();
  const assets = join(dist, 'assets');
  if (existsSync(assets)) {
    for (const found of readdirSync(assets, { recursive: true, withFileTypes: true })) {
      if (!found.isFile()) continue;
      const path = join(found.parentPath, found.name);
      sizes.set(relative(dist, path).split(sep).join('/'), statSync(path).size);
    }
  }
  return { manifest, html: readFileSync(htmlPath, 'utf8'), sizes };
}

/**
 * Measures the build in `dist` and checks it against the budget.
 * @param {string} dist
 * @param {typeof BUDGET} [budget]
 * @returns {{ code: 0 | 1 | 2, report: string }}  the exit code, and the table with the verdict
 */
export function checkBundle(dist, budget = BUDGET) {
  try {
    const { manifest, html, sizes } = readDist(dist);
    const measurement = measureBundle(manifest, sizes);
    const table = `Bundle budget (kB of 1000 bytes):\n${formatTable(measurement, budget)}`;
    const disagreements = compareWithPage(measurement, parseIndexHtml(html));
    if (disagreements.length > 0) {
      return {
        code: 2,
        report: [
          table,
          'Cannot check the budget: index.html and the manifest disagree on the startup path, so the figures above '
            + 'may not be what the page loads (did build.modulePreload change in vite.config.js?):',
          ...disagreements.map((line) => `  - ${line}`),
        ].join('\n'),
      };
    }
    const broken = evaluateBudget(measurement, budget);
    if (broken.length > 0) {
      return { code: 1, report: [table, 'Over budget:', ...broken.map((line) => `  - ${line}`)].join('\n') };
    }
    return { code: 0, report: `${table}\nWithin budget.` };
  } catch (error) {
    if (error instanceof BundleCheckError) return { code: 2, report: `Cannot check the budget: ${error.message}` };
    throw error;
  }
}

/** Whether Node runs this file itself (`node scripts/check-bundle.js`) rather than importing it. */
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const { code, report } = checkBundle(resolve(process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url))));
  if (code === 0) console.log(report);
  else console.error(report);
  process.exitCode = code;
}
