#!/usr/bin/env node
// scripts/generate-token.js
// CLI tool to generate signed JWT access tokens for premium features.
//
// Usage:
//   node scripts/generate-token.js --tier trial --days 7 --label "beta-tester-1"
//   node scripts/generate-token.js --tier pro --days 365
//   node scripts/generate-token.js --tier trial               (defaults: 7 days)
//   node scripts/generate-token.js --tier pro                 (defaults: 365 days)

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { parseArgs } from 'node:util';

const TIER_DEFAULTS = { trial: 7, pro: 365 };

const { values } = parseArgs({
  options: {
    tier:   { type: 'string', default: 'trial' },
    days:   { type: 'string', default: '' },
    label:  { type: 'string', default: '' },
    secret: { type: 'string', default: '' },
  },
});

const tier = values.tier;
if (!['trial', 'pro'].includes(tier)) {
  console.error('Error: --tier must be "trial" or "pro"');
  process.exit(1);
}

const days = values.days ? parseInt(values.days, 10) : TIER_DEFAULTS[tier];
if (isNaN(days) || days < 1) {
  console.error('Error: --days must be a positive integer');
  process.exit(1);
}

const secret = values.secret || process.env.TOKEN_SECRET;
if (!secret) {
  console.error('Error: TOKEN_SECRET not found. Set it in .env or pass --secret');
  process.exit(1);
}

const payload = { tier };
if (values.label) payload.sub = values.label;

const token = jwt.sign(payload, secret, { expiresIn: `${days}d` });

const decoded = jwt.decode(token);
const expiresAt = new Date(decoded.exp * 1000).toISOString();

console.log('\n--- Generated Access Token ---');
console.log(`Tier:    ${tier}`);
console.log(`Expires: ${expiresAt} (${days} days)`);
if (values.label) console.log(`Label:   ${values.label}`);
console.log(`\nToken:\n${token}\n`);
