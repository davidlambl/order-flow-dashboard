#!/usr/bin/env node
// scripts/write-headers.js
// The cache policy for the hashed build assets, written into dist/_headers after every build (`npm run build` runs it
// after `vite build`, so Netlify's build and CI's both do):
//
//   node scripts/write-headers.js [dist]
//
// Every file Vite writes under dist/assets/ carries a content hash in its name ([name]-[hash].[ext]), so the bytes at
// such a URL never change: a new build gets new names, and index.html (unhashed, revalidated on every load) points at
// them. That makes a year-long immutable policy safe for those files, and Netlify's default of revalidating every
// static file on every load (`Cache-Control: public, max-age=0, must-revalidate`) costs a conditional request and a 304
// per unchanged chunk per page load instead.
//
// One rule per file, not a `/assets/*` path rule: Netlify matches a header rule on the request path, with no regard
// for the status or the file served (measured on PR #85's deploy preview: a path rule put the same immutable
// Cache-Control on the 404 that a stale or made-up hashed path answers, with or without a rewrite in front). A browser
// may store a 404 that carries explicit freshness, and a Netlify rollback to the deploy that owns that name would then
// serve it the cached 404 for a year. A rule that names each existing file leaves a path that does not exist matching
// nothing, so that 404 keeps Netlify's default.
//
// Exit code: 0 when dist/_headers was written; 1 when a file under dist/assets/ has no hash in its name (an immutable
// policy would be unsafe for it, so nothing is written: hash it or move it out of assets/); 2 when there is no
// dist/assets/ to read.

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What every rule says. */
export const POLICY = 'public, max-age=31536000, immutable';

/** Vite's `[name]-[hash].[ext]`: the hash is eight characters of [A-Za-z0-9_-] before the extension. */
export const HASHED = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

/**
 * The text of a `_headers` file with one rule per asset, in name order so the file changes only when the set of
 * assets does. Paths are site-absolute: Netlify serves dist/ at the site's root.
 * @param {readonly string[]} assets  paths relative to dist/assets/, with `/` separators
 */
export function headerRules(assets) {
  const lines = [
    '# Written by scripts/write-headers.js after vite build: one rule per hashed file under assets/, so a path that',
    '# does not exist matches none and its 404 keeps the default. See netlify.toml.',
  ];
  for (const asset of [...assets].sort()) lines.push(`/assets/${asset}`, `  Cache-Control: ${POLICY}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Every file under `dir`, as paths relative to it with `/` separators.
 * @param {string} dir
 * @returns {string[]}
 */
export function listAssets(dir) {
  const assets = [];
  for (const found of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (found.isFile()) assets.push(relative(dir, join(found.parentPath, found.name)).split(sep).join('/'));
  }
  return assets;
}

/**
 * Writes `<dist>/_headers` for the files under `<dist>/assets/`.
 * @param {string} dist
 * @returns {{ code: 0 | 1 | 2, report: string }}  the exit code and one line saying what happened
 */
export function writeHeaders(dist) {
  const assetsDir = join(dist, 'assets');
  if (!existsSync(assetsDir)) return { code: 2, report: `No ${assetsDir}: build first (npm run build).` };
  const assets = listAssets(assetsDir).sort();
  const unhashed = assets.filter((asset) => !HASHED.test(asset));
  if (unhashed.length > 0) {
    return {
      code: 1,
      report: `Not written: ${unhashed.join(', ')} under dist/assets/ ${unhashed.length === 1 ? 'has' : 'have'} no `
        + `content hash in the name, so an immutable cache policy would be unsafe for ${unhashed.length === 1 ? 'it' : 'them'}. `
        + 'Hash it or move it out of assets/.',
    };
  }
  writeFileSync(join(dist, '_headers'), headerRules(assets));
  return { code: 0, report: `Wrote ${join(dist, '_headers')}: ${assets.length} immutable rule${assets.length === 1 ? '' : 's'}.` };
}

function invokedDirectly() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const { code, report } = writeHeaders(resolve(process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url))));
  (code === 0 ? console.log : console.error)(report);
  process.exitCode = code;
}
