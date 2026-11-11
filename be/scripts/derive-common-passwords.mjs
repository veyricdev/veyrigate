#!/usr/bin/env node
// Run 85 T3 (DEBT-574, D85.4): derive the embedded common-password list from the SecLists NCSC file.
//
//   node be/scripts/derive-common-passwords.mjs <raw 100k-most-used-passwords-NCSC.txt> <out.txt>
//
// Node stdlib only; the input is read as text and never executed. Rules: split lines (drop `\r`),
// NFKC + toLowerCase(), keep lengths 8–128 (the password policy), drop duplicates keeping the first
// (highest-ranked) occurrence, keep the first 10 000. Writes LF lines ending with `\n` and prints the
// line count and the sha256 of the output (record both in common-passwords.NOTICE.md).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const LIMIT = 10_000;
const [raw, out] = process.argv.slice(2);
if (!raw || !out) {
  console.error('usage: derive-common-passwords.mjs <raw> <out>');
  process.exit(2);
}

const seen = new Set();
const kept = [];
for (const line of readFileSync(raw, 'utf8').split('\n')) {
  const value = line.replace(/\r$/, '').normalize('NFKC').toLowerCase();
  if (value.length < 8 || value.length > 128 || seen.has(value)) continue;
  seen.add(value);
  kept.push(value);
  if (kept.length === LIMIT) break;
}
if (kept.length < LIMIT) {
  console.error(`only ${kept.length} entries (need ${LIMIT})`);
  process.exit(1);
}
const text = kept.join('\n') + '\n';
writeFileSync(out, text);
console.log(`lines ${kept.length}`);
console.log(`sha256 ${createHash('sha256').update(text).digest('hex')}`);
