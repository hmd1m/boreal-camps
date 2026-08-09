/**
 * Verify the Airtable table matches what the pipeline expects.
 *
 *   node scripts/check-airtable.js
 *
 * Reads the schema through Airtable's Meta API and compares it, field by field,
 * against the shape `lib/destinations/airtable.js` writes. Catches the failure
 * that is otherwise invisible until the first real booking: a column whose name
 * is off by a character, or a type that silently drops the value.
 */

import { config } from '../lib/config.js';

const EXPECTED = [
  { name: 'Name',            types: ['singleLineText'] },
  { name: 'Reference',       types: ['singleLineText'] },
  { name: 'Status',          types: ['singleSelect', 'singleLineText'] },
  { name: 'Trip',            types: ['singleLineText', 'singleSelect'] },
  { name: 'Departs',         types: ['date', 'dateTime'] },
  { name: 'People',          types: ['number'] },
  { name: 'Email',           types: ['email', 'singleLineText'] },
  { name: 'Phone',           types: ['phoneNumber', 'singleLineText'] },
  { name: 'City',            types: ['singleLineText'] },
  { name: 'Gear',            types: ['multilineText', 'singleLineText'] },
  { name: 'Emergency Name',  types: ['singleLineText'] },
  { name: 'Emergency Phone', types: ['phoneNumber', 'singleLineText'] },
  { name: 'Notes',           types: ['multilineText', 'singleLineText'] },
  { name: 'Total (CAD)',     types: ['number', 'currency'] },
  { name: 'Source',          types: ['singleLineText'] },
  { name: 'Booked At',       types: ['dateTime', 'date'] },
];

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/** Flag names that differ only by case, spacing or punctuation — the usual typo. */
const loose = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

if (!config.airtable.enabled) {
  console.error(r('\n  AIRTABLE_TOKEN or AIRTABLE_BASE_ID is missing.'));
  console.error('  Copy .env.example to .env and fill both in, then run this again.\n');
  process.exit(1);
}

const url = `https://api.airtable.com/v0/meta/bases/${config.airtable.baseId}/tables`;

let res;
try {
  res = await fetch(url, {
    headers: { authorization: `Bearer ${config.airtable.token}` },
    signal: AbortSignal.timeout(15_000),
  });
} catch (err) {
  console.error(r(`\n  Could not reach Airtable: ${err.message}\n`));
  process.exit(1);
}

if (!res.ok) {
  const body = await res.text().catch(() => '');
  console.error(r(`\n  Airtable ${res.status}`), dim(body.slice(0, 200)));
  if (res.status === 401) console.error('  → the token is wrong, or lacks the schema.bases:read scope.');
  if (res.status === 403) console.error('  → the token has no access to this base.');
  if (res.status === 404) console.error('  → AIRTABLE_BASE_ID does not match any base.');
  console.error('');
  process.exit(1);
}

const { tables } = await res.json();
const table = tables.find((t) => t.name === config.airtable.table);

if (!table) {
  console.error(r(`\n  No table named "${config.airtable.table}" in this base.`));
  console.error('  Tables found: ' + tables.map((t) => `"${t.name}"`).join(', '));
  console.error('  → rename your table, or change AIRTABLE_TABLE in .env.\n');
  process.exit(1);
}

console.log(`\n  base   ${config.airtable.baseId}`);
console.log(`  table  ${table.name}  ${dim(`(${table.fields.length} fields)`)}\n`);

const byName = new Map(table.fields.map((f) => [f.name, f]));
const byLoose = new Map(table.fields.map((f) => [loose(f.name), f]));

let missing = 0;
let wrongType = 0;

for (const want of EXPECTED) {
  const field = byName.get(want.name);

  if (!field) {
    const near = byLoose.get(loose(want.name));
    if (near) {
      console.log(`  ${r('✗')} ${want.name.padEnd(17)} ${r('name mismatch')} — found ${y(`"${near.name}"`)}`);
      console.log(`    ${dim(`rename it to exactly: ${want.name}`)}`);
    } else {
      console.log(`  ${r('✗')} ${want.name.padEnd(17)} ${r('missing')}`);
    }
    missing++;
    continue;
  }

  if (!want.types.includes(field.type)) {
    console.log(`  ${y('!')} ${want.name.padEnd(17)} type is ${y(field.type)}, expected ${want.types[0]}`);
    wrongType++;
    continue;
  }

  console.log(`  ${g('✓')} ${want.name.padEnd(17)} ${dim(field.type)}`);
}

const extra = table.fields.filter((f) => !EXPECTED.some((e) => e.name === f.name));
if (extra.length) {
  console.log(`\n  ${dim('extra fields (harmless, they are simply never written):')}`);
  extra.forEach((f) => console.log(`    ${dim('·')} ${dim(f.name)}`));
}

console.log('');
if (missing) {
  console.log(r(`  ${missing} field(s) must be fixed before bookings can sync.\n`));
  process.exit(1);
}
if (wrongType) {
  console.log(y(`  ${wrongType} field(s) have an unexpected type — rows may still write, but check them.\n`));
  process.exit(0);
}
console.log(g('  All good. Airtable is ready to receive bookings.\n'));
