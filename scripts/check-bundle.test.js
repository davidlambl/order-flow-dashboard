// scripts/check-bundle.test.js — the bundle budget check. Its pure parts on small inputs: which scripts index.html
// loads at startup, the manifest's static closure (each chunk once, cycles ended, dynamic imports left out), each rule
// passing at its limit and failing just past it. Then Vite's own manifest and index.html from two builds of this app
// (__fixtures__/): bundle-static, every vendor group loaded at startup, and bundle-lazy, the charts and the markdown
// renderer imported lazily, with the sizes their files had. And the command on a dist/ written to a temporary
// directory: the table, the exit codes, a missing dist/ or manifest, a manifest with no entry, nothing run on import.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BUDGET, BundleCheckError, checkBundle, compareWithPage, evaluateBudget, findEntry, formatTable, measureBundle,
  parseIndexHtml, readDist, staticClosure,
} from './check-bundle.js';

const SCRIPT = path.join(import.meta.dirname, 'check-bundle.js');

/** Vite's manifest and index.html from a real build of the app, parsed afresh (tests may change them). */
function fixture(shape) {
  const dir = path.join(import.meta.dirname, '__fixtures__', `bundle-${shape}`);
  return {
    manifest: JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
    html: readFileSync(path.join(dir, 'index.html'), 'utf8'),
  };
}

// What those builds wrote to dist/assets, in bytes: the vendor chunks and the stylesheet are the same in both.
const SHARED = {
  'assets/index-CuUgmZiF.css': 40354,
  'assets/rolldown-runtime-XKyaHtl9.js': 726,
  'assets/react-C1iE8mnY.js': 218754,
  'assets/query-C9fSqsos.js': 32753,
  'assets/supabase-Bwm3Z89P.js': 214389,
  'assets/recharts-CU_N9K2c.js': 385927,
  'assets/markdown-CiBvUsbF.js': 153220,
};
const FILES = {
  static: { ...SHARED, 'assets/index-xVlV-wpr.js': 198147 },
  lazy: {
    ...SHARED,
    'assets/index-CBNkpFUK.js': 188207,
    'assets/GexChart-Bt4h7XhI.js': 6313,
    'assets/FlowChart-Ctcmz2hM.js': 4182,
    'assets/ChatMarkdown-Ceu26neL.js': 2253,
  },
};
const sizes = (files) => new Map(Object.entries(files));
const measure = (shape) => measureBundle(fixture(shape).manifest, sizes(FILES[shape]));

/**
 * A manifest shaped like Vite's from { key: [the keys it imports statically] }: the first key is the entry (src
 * index.html), and each chunk's file is assets/<key>.js. `names` names chunks (a vendor group's chunk carries the
 * group's name); `dynamic` gives a chunk its dynamic imports.
 */
function graph(imports, { names = {}, dynamic = {} } = {}) {
  return Object.fromEntries(Object.entries(imports).map(([key, keys], i) => [key, {
    file: `assets/${key}.js`,
    ...(names[key] ? { name: names[key] } : {}),
    ...(i === 0 ? { src: 'index.html', isEntry: true } : {}),
    ...(keys.length > 0 ? { imports: keys } : {}),
    ...(dynamic[key] ? { dynamicImports: dynamic[key] } : {}),
  }]));
}

/** The sizes of a graph()'s files: 1 kB each, unless `bytes` says otherwise. */
const sizesOf = (manifest, bytes = {}) => sizes({
  ...Object.fromEntries(Object.values(manifest).map(({ file }) => [file, 1000])),
  ...bytes,
});

/** The size rules alone: no vendor group expected, so a graph() needs none. */
const SIZES_ONLY = { ...BUDGET, onDemandGroups: [] };

/** What `run` throws, which must be a BundleCheckError: its message. */
function thrown(run) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BundleCheckError);
    return error.message;
  }
  throw new Error('nothing was thrown');
}

describe('parseIndexHtml', () => {
  it('finds the module script and the modulepreload links of Vite\'s index.html, in document order', () => {
    expect(parseIndexHtml(fixture('lazy').html)).toEqual({
      scripts: ['./assets/index-CBNkpFUK.js'],
      preloads: [
        './assets/rolldown-runtime-XKyaHtl9.js',
        './assets/react-C1iE8mnY.js',
        './assets/query-C9fSqsos.js',
        './assets/supabase-Bwm3Z89P.js',
      ],
    });
  });

  it('reads attributes in any order, case and quoting', () => {
    const html = `<SCRIPT src='/a.js' TYPE=Module></SCRIPT>
      <link href=b.js rel="modulepreload"><link crossorigin rel='preload modulepreload' href="./c.js?v=1" />`;

    expect(parseIndexHtml(html)).toEqual({ scripts: ['/a.js'], preloads: ['b.js', './c.js?v=1'] });
  });

  it('leaves out what loads nothing at startup: classic and inline scripts, other links, comments, script text', () => {
    const html = `
      <!-- <script type="module" src="./old.js"></script> <link rel="modulepreload" href="./old-dep.js"> -->
      <script src="./classic.js"></script>
      <script type="module">import('./lazy.js')</script>
      <script>document.head.append('<link rel="modulepreload" href="./written.js">')</script>
      <link rel="stylesheet" href="./index.css">
      <link rel="prefetch" href="./later.js">
      <script type="module" crossorigin src="./index.js"></script>`;

    expect(parseIndexHtml(html)).toEqual({ scripts: ['./index.js'], preloads: [] });
  });
});

describe('findEntry', () => {
  it('is the record with isEntry, index.html\'s, wherever it sits in the manifest', () => {
    const { manifest } = fixture('static');

    expect(Object.keys(manifest)[0]).toBe('_markdown-CiBvUsbF.js');
    expect(findEntry(manifest)).toBe('index.html');
  });

  it('throws when no record is the entry, or more than one is', () => {
    const none = graph({ main: [] });
    delete none.main.isEntry;
    const two = { ...graph({ main: [] }), other: { file: 'assets/other.js', isEntry: true } };

    expect(thrown(() => findEntry(none))).toMatch(/^the manifest has no entry record \(isEntry\)/);
    expect(thrown(() => findEntry(two))).toMatch(/^the manifest has 2 entry records \(main, other\)/);
  });
});

describe('staticClosure', () => {
  it('holds every vendor chunk of the build whose entry imports them all', () => {
    const closure = staticClosure(fixture('static').manifest, 'index.html');

    expect([...closure.keys()]).toEqual([
      '_rolldown-runtime-XKyaHtl9.js', '_react-C1iE8mnY.js', '_query-C9fSqsos.js',
      '_recharts-CU_N9K2c.js', '_markdown-CiBvUsbF.js', '_supabase-Bwm3Z89P.js',
    ]);
    expect(new Set(closure.values())).toEqual(new Set(['index.html']));
  });

  it('leaves out the dynamic imports of the lazy build, and the chunks only they import', () => {
    const closure = staticClosure(fixture('lazy').manifest, 'index.html');

    expect([...closure.keys()]).toEqual([
      '_rolldown-runtime-XKyaHtl9.js', '_react-C1iE8mnY.js', '_query-C9fSqsos.js', '_supabase-Bwm3Z89P.js',
    ]);
  });

  it('follows imports through other chunks, nearest first, each once, with the chunk that first imports it', () => {
    const closure = staticClosure(graph({ main: ['a', 'b'], a: ['c'], b: ['c', 'd'], c: [], d: ['e'], e: [] }), 'main');

    expect([...closure]).toEqual([['a', 'main'], ['b', 'main'], ['c', 'a'], ['d', 'b'], ['e', 'd']]);
  });

  it('ends at a cycle, and leaves the entry out where a chunk imports it back', () => {
    const closure = staticClosure(graph({ main: ['a'], a: ['b'], b: ['a', 'main'] }), 'main');

    expect([...closure.keys()]).toEqual(['a', 'b']);
  });

  it('throws on an import the manifest has no record of', () => {
    const manifest = graph({ main: ['a'], a: ['gone'] });

    expect(thrown(() => staticClosure(manifest, 'main'))).toMatch(/^the manifest has no record of gone, which its a imports/);
  });
});

describe('measureBundle', () => {
  it('puts every chunk of the vendor-groups build on the startup path, largest first, and nothing on demand', () => {
    const { entry, startup, initialBytes, onDemand } = measure('static');

    expect(entry).toEqual({ file: 'assets/index-xVlV-wpr.js', bytes: 198147, name: 'index' });
    expect(startup.map(({ file, bytes, name }) => [file, bytes, name])).toEqual([
      ['assets/recharts-CU_N9K2c.js', 385927, 'recharts'],
      ['assets/react-C1iE8mnY.js', 218754, 'react'],
      ['assets/supabase-Bwm3Z89P.js', 214389, 'supabase'],
      ['assets/markdown-CiBvUsbF.js', 153220, 'markdown'],
      ['assets/query-C9fSqsos.js', 32753, 'query'],
      ['assets/rolldown-runtime-XKyaHtl9.js', 726, 'rolldown-runtime'],
    ]);
    expect(initialBytes).toBe(1_203_916);
    expect(onDemand).toEqual([]);
  });

  it('puts the charts, the markdown renderer and their libraries on demand in the lazy build, not its CSS', () => {
    const { entry, startup, initialBytes, onDemand } = measure('lazy');

    expect(entry).toEqual({ file: 'assets/index-CBNkpFUK.js', bytes: 188207, name: 'index' });
    expect(startup.map(({ file }) => file)).toEqual([
      'assets/react-C1iE8mnY.js', 'assets/supabase-Bwm3Z89P.js', 'assets/query-C9fSqsos.js',
      'assets/rolldown-runtime-XKyaHtl9.js',
    ]);
    expect(initialBytes).toBe(654_829);
    expect(onDemand).toEqual([
      { file: 'assets/recharts-CU_N9K2c.js', bytes: 385927, name: 'recharts' },
      { file: 'assets/markdown-CiBvUsbF.js', bytes: 153220, name: 'markdown' },
      { file: 'assets/GexChart-Bt4h7XhI.js', bytes: 6313, name: 'GexChart' },
      { file: 'assets/FlowChart-Ctcmz2hM.js', bytes: 4182, name: 'FlowChart' },
      { file: 'assets/ChatMarkdown-Ceu26neL.js', bytes: 2253, name: 'ChatMarkdown' },
    ]);
  });

  it('counts a script the manifest does not know (a worker\'s) as on demand', () => {
    const manifest = graph({ main: [] });

    expect(measureBundle(manifest, sizesOf(manifest, { 'assets/worker-1a2b.js': 500 })).onDemand).toEqual([
      { file: 'assets/worker-1a2b.js', bytes: 500, name: undefined },
    ]);
  });

  it('shows how the entry reaches each chunk on the startup path', () => {
    const manifest = graph({ main: ['shared'], shared: ['charts'], charts: [] });
    const { startup } = measureBundle(manifest, sizesOf(manifest, { 'assets/charts.js': 2000 }));

    expect(startup.map((chunk) => chunk.path)).toEqual([
      ['index.html', 'assets/shared.js', 'assets/charts.js'],
      ['index.html', 'assets/shared.js'],
    ]);
    expect(measure('static').startup[0].path).toEqual(['index.html', 'assets/recharts-CU_N9K2c.js']);
  });

  it('throws when a chunk on the startup path is not in dist/', () => {
    const { 'assets/react-C1iE8mnY.js': _gone, ...files } = FILES.lazy;

    expect(thrown(() => measureBundle(fixture('lazy').manifest, sizes(files))))
      .toMatch(/^the manifest names assets\/react-C1iE8mnY\.js, which dist\/ does not have/);
  });
});

describe('compareWithPage', () => {
  it.each(['static', 'lazy'])('finds index.html of the %s build loading the entry and its static closure', (shape) => {
    const { manifest, html } = fixture(shape);

    expect(compareWithPage(measureBundle(manifest, sizes(FILES[shape])), parseIndexHtml(html))).toEqual([]);
  });

  it('names a script only the page loads, and a chunk of the closure the page does not load', () => {
    const page = fixture('static').html
      .replace(/\s*<link rel="modulepreload" crossorigin href="\.\/assets\/markdown-CiBvUsbF\.js">/, '')
      .replace('</head>', '<link rel="modulepreload" href="./assets/extra-1a2b.js"></head>');

    expect(compareWithPage(measure('static'), parseIndexHtml(page))).toEqual([
      'index.html loads ./assets/extra-1a2b.js, which the manifest does not put on the startup path',
      'the manifest puts assets/markdown-CiBvUsbF.js on the startup path, which index.html does not load',
    ]);
  });

  it('matches the page\'s URLs whatever the base, a query or a hash', () => {
    const manifest = graph({ main: ['a', 'b'], a: [], b: [] });
    const page = {
      scripts: ['/app/assets/main.js#x'],
      preloads: ['https://cdn.example.com/x/assets/a.js', 'assets/b.js?v=2'],
    };

    expect(compareWithPage(measureBundle(manifest, sizesOf(manifest)), page)).toEqual([]);
  });
});

describe('evaluateBudget', () => {
  it('passes the lazy build', () => {
    expect(evaluateBudget(measure('lazy'))).toEqual([]);
  });

  it('fails the vendor-groups build on recharts and markdown at startup and on initial JS, not on its entry', () => {
    expect(evaluateBudget(measure('static'))).toEqual([
      expect.stringMatching(/^the recharts chunk assets\/recharts-CU_N9K2c\.js loads at startup \(index\.html → assets\/recharts-CU_N9K2c\.js\): a module on the startup path imports a package of the recharts vendor group/),
      expect.stringMatching(/^the markdown chunk assets\/markdown-CiBvUsbF\.js loads at startup \(index\.html → assets\/markdown-CiBvUsbF\.js\): /),
      expect.stringMatching(/^initial JS \(7 files: the entry and what it imports statically\) is 1,203\.91 kB, over its 700 kB budget; the largest is assets\/recharts-CU_N9K2c\.js \(385\.92 kB\)/),
    ]);
  });

  it('the entry chunk: 350 kB as Vite prints it passes, the next figure up fails', () => {
    const manifest = graph({ main: [] });
    const entryOf = (bytes) => measureBundle(manifest, sizesOf(manifest, { 'assets/main.js': bytes }));

    expect(evaluateBudget(entryOf(350_009), SIZES_ONLY)).toEqual([]);
    expect(evaluateBudget(entryOf(350_010), SIZES_ONLY)).toEqual([
      expect.stringMatching(/^the entry chunk assets\/main\.js is 350\.01 kB, over its 350 kB budget: see what it bundles/),
    ]);
  });

  it('initial JS: the entry and all it imports statically, at most 700 kB; what loads on demand does not count', () => {
    const manifest = graph({ main: ['a'], a: ['b'], b: [], lazy: [] }, { dynamic: { main: ['lazy'] } });
    const startupOf = (bytes) => measureBundle(manifest, sizesOf(manifest, {
      'assets/main.js': 300_000, 'assets/a.js': 200_000, 'assets/b.js': bytes, 'assets/lazy.js': 5_000_000,
    }));

    expect(evaluateBudget(startupOf(200_009), SIZES_ONLY)).toEqual([]);
    expect(evaluateBudget(startupOf(200_010), SIZES_ONLY)).toEqual([
      expect.stringMatching(/^initial JS \(3 files: the entry and what it imports statically\) is 700\.01 kB, over its 700 kB budget; the largest is assets\/main\.js \(300\.00 kB\)/),
    ]);
  });

  it('fails a group\'s chunk wherever it is on the startup path, saying how the entry reaches it', () => {
    const manifest = graph({ main: ['shared'], shared: ['charts'], charts: [] }, { names: { charts: 'recharts' } });

    expect(evaluateBudget(measureBundle(manifest, sizesOf(manifest)), { ...SIZES_ONLY, onDemandGroups: ['recharts'] }))
      .toEqual([
        expect.stringMatching(/^the recharts chunk assets\/charts\.js loads at startup \(index\.html → assets\/shared\.js → assets\/charts\.js\): /),
      ]);
  });

  it('passes a group\'s chunk that only a dynamic import reaches', () => {
    const manifest = graph({ main: [], panel: ['charts'], charts: [] }, {
      names: { charts: 'recharts' },
      dynamic: { main: ['panel'] },
    });

    expect(evaluateBudget(measureBundle(manifest, sizesOf(manifest)), { ...SIZES_ONLY, onDemandGroups: ['recharts'] }))
      .toEqual([]);
  });

  it('fails a group the build has no chunk of: the check would no longer know where its library is', () => {
    const { manifest } = fixture('lazy');
    manifest['_recharts-CU_N9K2c.js'].name = 'charts';

    expect(evaluateBudget(measureBundle(manifest, sizes(FILES.lazy)))).toEqual([
      expect.stringMatching(/^the build has no recharts chunk: vite\.config\.js has no vendor group of that name any more/),
    ]);
  });
});

describe('formatTable', () => {
  it('says so when nothing loads on demand, and counts one file as one', () => {
    const manifest = graph({ main: [] });

    expect(formatTable(measureBundle(manifest, sizesOf(manifest, { 'assets/main.js': 1_205_190 })))).toBe([
      '  entry       assets/main.js  1,205.19 kB  at most 350 kB',
      '  initial JS  1 file          1,205.19 kB  at most 700 kB',
      '  on demand   none',
    ].join('\n'));
  });
});

describe('checkBundle, on a dist/', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'check-bundle-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Writes dist/ in the temporary directory: the manifest (JSON, or text as is), index.html, each file at its size. */
  function writeDist({ manifest, html, files = {} }) {
    const dist = path.join(root, 'dist');
    mkdirSync(path.join(dist, '.vite'), { recursive: true });
    if (manifest !== undefined) {
      const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
      writeFileSync(path.join(dist, '.vite', 'manifest.json'), text);
    }
    if (html !== undefined) writeFileSync(path.join(dist, 'index.html'), html);
    for (const [file, bytes] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
      writeFileSync(path.join(dist, file), Buffer.alloc(bytes));
    }
    return dist;
  }
  const build = (shape) => writeDist({ ...fixture(shape), files: FILES[shape] });

  it('reads Vite\'s manifest and index.html, and the size of every file under dist/assets', () => {
    const { manifest, html } = fixture('lazy');
    const files = { ...FILES.lazy, 'assets/fonts/inter-1a2b.woff2': 30 };

    expect(readDist(writeDist({ manifest, html, files }))).toEqual({ manifest, html, sizes: sizes(files) });
  });

  it('passes the lazy build under its table: the entry, the startup chunks, initial JS, what loads on demand', () => {
    expect(checkBundle(build('lazy'))).toEqual({
      code: 0,
      report: [
        'Bundle budget (kB of 1000 bytes):',
        '  entry       assets/index-CBNkpFUK.js             188.20 kB  at most 350 kB',
        '  startup     assets/react-C1iE8mnY.js             218.75 kB',
        '  startup     assets/supabase-Bwm3Z89P.js          214.38 kB',
        '  startup     assets/query-C9fSqsos.js              32.75 kB',
        '  startup     assets/rolldown-runtime-XKyaHtl9.js    0.72 kB',
        '  initial JS  5 files                              654.82 kB  at most 700 kB',
        '  on demand   assets/recharts-CU_N9K2c.js          385.92 kB',
        '  on demand   assets/markdown-CiBvUsbF.js          153.22 kB',
        '  on demand   assets/GexChart-Bt4h7XhI.js            6.31 kB',
        '  on demand   assets/FlowChart-Ctcmz2hM.js           4.18 kB',
        '  on demand   assets/ChatMarkdown-Ceu26neL.js        2.25 kB',
        'Within budget.',
      ].join('\n'),
    });
  });

  it('fails the vendor-groups build with code 1: the table, then a line per broken rule', () => {
    const { code, report } = checkBundle(build('static'));

    expect(code).toBe(1);
    expect(report.split('\n')).toEqual([
      'Bundle budget (kB of 1000 bytes):',
      '  entry       assets/index-xVlV-wpr.js               198.14 kB  at most 350 kB',
      '  startup     assets/recharts-CU_N9K2c.js            385.92 kB  recharts: on demand only',
      '  startup     assets/react-C1iE8mnY.js               218.75 kB',
      '  startup     assets/supabase-Bwm3Z89P.js            214.38 kB',
      '  startup     assets/markdown-CiBvUsbF.js            153.22 kB  markdown: on demand only',
      '  startup     assets/query-C9fSqsos.js                32.75 kB',
      '  startup     assets/rolldown-runtime-XKyaHtl9.js      0.72 kB',
      '  initial JS  7 files                              1,203.91 kB  at most 700 kB',
      '  on demand   none',
      'Over budget:',
      expect.stringMatching(/^ {2}- the recharts chunk assets\/recharts-CU_N9K2c\.js loads at startup/),
      expect.stringMatching(/^ {2}- the markdown chunk assets\/markdown-CiBvUsbF\.js loads at startup/),
      expect.stringMatching(/^ {2}- initial JS \(7 files: the entry and what it imports statically\) is 1,203\.91 kB/),
    ]);
  });

  it('fails a single-chunk build on its entry and initial JS, and on the vendor groups it lacks', () => {
    const { code, report } = checkBundle(writeDist({
      manifest: { 'index.html': { file: 'assets/index-y0Und0JP.js', name: 'index', src: 'index.html', isEntry: true } },
      html: '<script type="module" crossorigin src="./assets/index-y0Und0JP.js"></script>',
      files: { 'assets/index-y0Und0JP.js': 1_205_190 },
    }));

    expect(code).toBe(1);
    expect(report.split('Over budget:\n')[1].split('\n')).toEqual([
      expect.stringMatching(/^ {2}- the entry chunk assets\/index-y0Und0JP\.js is 1,205\.19 kB, over its 350 kB budget/),
      expect.stringMatching(/^ {2}- the build has no recharts chunk/),
      expect.stringMatching(/^ {2}- the build has no markdown chunk/),
      expect.stringMatching(/^ {2}- initial JS \(1 file: the entry and what it imports statically\) is 1,205\.19 kB/),
    ]);
  });

  it('cannot check without a dist/ (code 2)', () => {
    expect(checkBundle(path.join(root, 'dist'))).toEqual({
      code: 2,
      report: 'Cannot check the budget: no dist/: run npm run build first',
    });
  });

  it('cannot check without the manifest, which build.manifest writes (code 2)', () => {
    expect(checkBundle(writeDist({ html: fixture('lazy').html, files: FILES.lazy }))).toEqual({
      code: 2,
      report: 'Cannot check the budget: no dist/.vite/manifest.json: run npm run build first, and keep build.manifest '
        + 'on in vite.config.js (this check reads the manifest)',
    });
  });

  it('cannot check a manifest with no entry, one that is not JSON, or without index.html (code 2)', () => {
    const { manifest, html } = fixture('lazy');
    delete manifest['index.html'].isEntry;

    expect(checkBundle(writeDist({ manifest, html, files: FILES.lazy }))).toEqual({
      code: 2,
      report: expect.stringMatching(/^Cannot check the budget: the manifest has no entry record \(isEntry\)/),
    });
    expect(checkBundle(writeDist({ manifest: '{"index.html": ' }))).toEqual({
      code: 2,
      report: 'Cannot check the budget: dist/.vite/manifest.json is not a manifest (a JSON object): '
        + 'run npm run build again',
    });
    rmSync(path.join(root, 'dist', 'index.html'));
    expect(checkBundle(writeDist({ manifest: fixture('lazy').manifest }))).toEqual({
      code: 2,
      report: 'Cannot check the budget: no dist/index.html: run npm run build first',
    });
  });

  it('cannot check, after the table, when index.html loads other scripts than the manifest says (code 2)', () => {
    const { manifest } = fixture('static');
    const { code, report } = checkBundle(writeDist({ manifest, html: fixture('lazy').html, files: FILES.static }));

    expect(code).toBe(2);
    expect(report).toMatch(/^Bundle budget \(kB of 1000 bytes\):\n {2}entry {7}assets\/index-xVlV-wpr\.js/);
    expect(report.split(/\n(?=Cannot check)/)[1].split('\n')).toEqual([
      'Cannot check the budget: index.html and the manifest disagree on the startup path, so the figures above may '
        + 'not be what the page loads (did build.modulePreload change in vite.config.js?):',
      '  - index.html loads ./assets/index-CBNkpFUK.js, which the manifest does not put on the startup path',
      '  - the manifest puts assets/index-xVlV-wpr.js on the startup path, which index.html does not load',
      '  - the manifest puts assets/recharts-CU_N9K2c.js on the startup path, which index.html does not load',
      '  - the manifest puts assets/markdown-CiBvUsbF.js on the startup path, which index.html does not load',
    ]);
  });

  describe('as a command', () => {
    const node = (args, options = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', ...options });

    it('prints the report, on stdout within budget and on stderr over it, and exits with its code', () => {
      const lazy = node([SCRIPT, build('lazy')]);
      const { report } = checkBundle(path.join(root, 'dist'));
      expect([lazy.status, lazy.stdout, lazy.stderr]).toEqual([0, `${report}\n`, '']);

      rmSync(path.join(root, 'dist'), { recursive: true });
      const vendorGroups = node([SCRIPT, build('static')]);
      expect([vendorGroups.status, vendorGroups.stdout]).toEqual([1, '']);
      expect(vendorGroups.stderr).toMatch(/\nOver budget:\n/);
    });

    it('measures the dist/ next to its own scripts/ folder when given no path', () => {
      mkdirSync(path.join(root, 'scripts'));
      copyFileSync(SCRIPT, path.join(root, 'scripts', 'check-bundle.js'));
      build('lazy');

      const run = node([path.join(root, 'scripts', 'check-bundle.js')], { cwd: tmpdir() });
      expect([run.status, run.stderr]).toEqual([0, '']);
      expect(run.stdout).toMatch(/^Bundle budget .*\n {2}entry {7}assets\/index-CBNkpFUK\.js/);
    });

    it('runs nothing when imported', () => {
      const load = `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`;
      const imported = node(['--input-type=module', '-e', load], { cwd: root });

      expect([imported.status, imported.stdout, imported.stderr]).toEqual([0, '', '']);
    });
  });
});
