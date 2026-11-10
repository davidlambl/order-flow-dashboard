// scripts/generate-token.test.js — the token script as its README command runs it: plain Node, which loads the
// functions' auth module by its .ts name through its own type stripping. Nothing else runs that path, so this is what
// fails the day lib/auth.ts gains a static relative import or syntax Node cannot strip.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { TOKEN_ALGORITHM, TOKEN_AUDIENCE, TOKEN_ISSUER } from '../netlify/functions/lib/auth.js';

const SECRET = 'x'.repeat(48);
const TOKEN_LINE = /^(eyJ[\w-]+\.[\w-]+\.[\w-]+)$/m;

describe('scripts/generate-token.js', () => {
  it('Pin: under plain Node it mints a one-day trial token that verifies with the functions\' algorithm, issuer and audience', () => {
    // process.execPath, so the child is the Node under test; a cwd with no .env, so dotenv/config loads nothing and
    // this secret is the only one the script sees.
    const out = execFileSync(process.execPath, [path.join(import.meta.dirname, 'generate-token.js'), '--tier', 'trial', '--days', '1'], {
      cwd: os.tmpdir(),
      env: { ...process.env, TOKEN_SECRET: SECRET },
      encoding: 'utf8',
    });
    expect(out).toMatch(TOKEN_LINE);
    const [, token] = out.match(TOKEN_LINE);
    const claims = jwt.verify(token, SECRET, { algorithms: [TOKEN_ALGORITHM], issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE });
    expect(claims.tier).toBe('trial');
    expect(claims.exp - claims.iat).toBe(86400);
  });
});
