#!/usr/bin/env node
// scripts/generate-token.js
// CLI tool to generate signed JWT access tokens for premium features.
//
// Usage:
//   node scripts/generate-token.js --tier trial --days 7 --label "beta-tester-1"
//   node scripts/generate-token.js --tier pro --days 365
//   node scripts/generate-token.js --tier trial               (defaults: 7 days)
//   node scripts/generate-token.js --tier pro                 (defaults: 365 days)
//
// The signing secret comes from TOKEN_SECRET in the environment / .env, or from
// stdin with --secret-stdin (echo "$SECRET" | node scripts/generate-token.js --secret-stdin).
// It is never accepted as a command-line argument, so it can't leak via shell
// history or the process list.
//
// Every token carries a unique jti. To revoke one, insert its jti into the
// revoked_tokens table (see supabase/migrations/004_security_hardening.sql).

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  TOKEN_ISSUER, TOKEN_AUDIENCE, TOKEN_ALGORITHM, MIN_SECRET_LENGTH, VALID_TIERS,
} from '../netlify/functions/lib/auth.js';

const TIER_DEFAULTS = { trial: 7, pro: 365 };

const { values } = parseArgs({
  options: {
    tier:           { type: 'string', default: 'trial' },
    days:           { type: 'string', default: '' },
    label:          { type: 'string', default: '' },
    'secret-stdin': { type: 'boolean', default: false },
  },
});

const tier = values.tier;
if (!VALID_TIERS.includes(tier)) {
  console.error(`Error: --tier must be one of ${VALID_TIERS.join(', ')}`);
  process.exit(1);
}

const days = values.days ? parseInt(values.days, 10) : TIER_DEFAULTS[tier];
if (!Number.isInteger(days) || days < 1 || days > 3650) {
  console.error('Error: --days must be an integer between 1 and 3650');
  process.exit(1);
}

let secret = process.env.TOKEN_SECRET || '';
if (values['secret-stdin']) {
  secret = readFileSync(0, 'utf8').trim();
}
if (!secret) {
  console.error('Error: TOKEN_SECRET not found. Set it in .env or pipe it with --secret-stdin');
  process.exit(1);
}
if (secret.length < MIN_SECRET_LENGTH) {
  console.error(`Error: TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters. Generate one with:`);
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const jti = randomUUID();
const sub = values.label || `token-${jti.slice(0, 8)}`;

const token = jwt.sign({ tier }, secret, {
  algorithm: TOKEN_ALGORITHM,
  issuer: TOKEN_ISSUER,
  audience: TOKEN_AUDIENCE,
  subject: sub,
  jwtid: jti,
  expiresIn: `${days}d`,
});

const decoded = jwt.decode(token);
const expiresAt = new Date(decoded.exp * 1000).toISOString();

console.log('\n--- Generated Access Token ---');
console.log(`Tier:    ${tier}`);
console.log(`Subject: ${sub}`);
console.log(`JTI:     ${jti}`);
console.log(`Expires: ${expiresAt} (${days} days)`);
console.log(`\nToken:\n${token}\n`);
console.log(`Revoke with: INSERT INTO revoked_tokens (jti, sub, reason) VALUES ('${jti}', '${sub}', 'manual');\n`);
