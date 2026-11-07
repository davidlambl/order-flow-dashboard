// scripts/write-headers.test.js — the per-file cache policy writer. The hash pattern on the names of a real build and
// on names that must not pass; the rules' text; the writer on a dist/ in a temporary directory (the file, the refusal
// for an unhashed asset, no assets/ at all); the command's exit codes; nothing run on import.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HASHED, POLICY, headerRules, listAssets, writeHeaders } from './write-headers.js';

const SCRIPT = path.join(import.meta.dirname, 'write-headers.js');

// dist/assets of a build of this app (2026-11-06): every name Vite writes, hash alphabet edge cases included.
const BUILD = [
  'ChartsPanel-CAwHUlYV.js', 'ChatMarkdown-Ceu26neL.js', 'LoginForm-dJ7kRel2.js', 'SettingsDialog-4ZSqny2p.js',
  'StrategicContextDialog-Dem7c3JA.js', 'SyncChoice-DmhFS-oO.js', 'index--6IL-wEy.js', 'index-BPajWvEj.css',
  'markdown-CiBvUsbF.js', 'query-C9fSqsos.js', 'react-C1iE8mnY.js', 'recharts-CU_N9K2c.js',
  'rolldown-runtime-XKyaHtl9.js', 'supabase-Bwm3Z89P.js', 'useAutoSave-CPabVC__.js',
];

describe('HASHED', () => {
  it('matches every name of a real build', () => {
    expect(BUILD.filter((name) => !HASHED.test(name))).toEqual([]);
  });

  it('rejects a name with no hash, a short one, and one not before the extension', () => {
    for (const name of ['vite.svg', 'index.html', 'index.js', 'chunk-1234567.js', 'chunk-123456789.js', 'a-12345678', 'a-12345678.js.map.x-']) {
      expect(HASHED.test(name), name).toBe(false);
    }
    expect(HASHED.test('chunk-12345678.js.map')).toBe(false); // the hash must sit right before the last extension
    expect(HASHED.test('font-aB_c-9Zz.woff2')).toBe(true);
  });
});

describe('headerRules', () => {
  it('writes one rule per asset in name order, site-absolute, with the policy', () => {
    const text = headerRules(['b-12345678.js', 'a-abcdefgh.css']);
    expect(text).toBe(
      '# Written by scripts/write-headers.js after vite build: one rule per hashed file under assets/, so a path that\n'
      + '# does not exist matches none and its 404 keeps the default. See netlify.toml.\n'
      + `/assets/a-abcdefgh.css\n  Cache-Control: ${POLICY}\n`
      + `/assets/b-12345678.js\n  Cache-Control: ${POLICY}\n`,
    );
    expect(POLICY).toBe('public, max-age=31536000, immutable');
  });

  it('writes only the comment for no assets', () => {
    expect(headerRules([]).split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([]);
  });
});

describe('writeHeaders', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'write-headers-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const dist = (names, { nested = {} } = {}) => {
    const dir = path.join(root, 'dist');
    mkdirSync(path.join(dir, 'assets'), { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    for (const name of names) writeFileSync(path.join(dir, 'assets', name), name);
    for (const [sub, subNames] of Object.entries(nested)) {
      mkdirSync(path.join(dir, 'assets', sub), { recursive: true });
      for (const name of subNames) writeFileSync(path.join(dir, 'assets', sub, name), name);
    }
    return dir;
  };

  it('writes dist/_headers with a rule per hashed file, subdirectories included, and reports the count', () => {
    const dir = dist(BUILD, { nested: { fonts: ['inter-Ab12Cd34.woff2'] } });
    expect(writeHeaders(dir)).toEqual({ code: 0, report: `Wrote ${path.join(dir, '_headers')}: 16 immutable rules.` });
    expect(listAssets(path.join(dir, 'assets')).sort()).toEqual([...BUILD, 'fonts/inter-Ab12Cd34.woff2'].sort());
    expect(readFileSync(path.join(dir, '_headers'), 'utf8')).toBe(headerRules([...BUILD, 'fonts/inter-Ab12Cd34.woff2']));
  });

  it('refuses an unhashed file under assets/ and writes nothing', () => {
    const dir = dist([...BUILD, 'logo.svg']);
    const result = writeHeaders(dir);
    expect(result.code).toBe(1);
    expect(result.report).toMatch(/^Not written: logo\.svg under dist\/assets\/ has no content hash/);
    expect(existsSync(path.join(dir, '_headers'))).toBe(false);
  });

  it('names every unhashed file', () => {
    const { report } = writeHeaders(dist(['logo.svg', 'a-12345678.js', 'b.js']));
    expect(report).toMatch(/^Not written: b\.js, logo\.svg under dist\/assets\/ have no content hash in the name, so an immutable cache policy would be unsafe for them\./);
  });

  it('exits 2 with no assets/ to read', () => {
    const dir = path.join(root, 'nothing');
    expect(writeHeaders(dir)).toEqual({ code: 2, report: `No ${path.join(dir, 'assets')}: build first (npm run build).` });
  });

  it('is the command, with its exit codes, on a dist/ argument', () => {
    const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
    const ok = node([SCRIPT, dist(BUILD)]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^Wrote .*_headers: 15 immutable rules\.\n$/);
    expect(node([SCRIPT, dist(['plain.js'])]).status).toBe(1);
    expect(node([SCRIPT, path.join(root, 'none')]).status).toBe(2);
  });

  it('runs nothing on import', () => {
    expect(existsSync(path.join(root, '_headers'))).toBe(false);
  });
});
