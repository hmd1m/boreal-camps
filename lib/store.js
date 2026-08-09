/**
 * Booking storage — a JSON file on disk.
 *
 * Deliberately boring: no database to install, the whole dataset is readable in
 * a text editor, and it survives restarts. Swapping this module for Postgres or
 * Airtable later means changing this file only — nothing else imports `fs`.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// fileURLToPath, not url.pathname — on Windows the raw pathname comes back as
// "/C:/Users/..." which every fs call then rejects.
const ROOT     = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'data');
const FILE     = join(DATA_DIR, 'bookings.json');

let cache = null;           // in-memory copy, kept in sync with the file
let writeQueue = Promise.resolve();   // serialises writes so two requests can't interleave

/** Load once at startup; every later read is served from memory. */
export async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'));
    if (!Array.isArray(cache)) cache = [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;   // a real error, not just a missing file
    cache = [];
  }
  return cache;
}

export function all() {
  return cache ?? [];
}

/**
 * Write via a temp file + rename. Rename is atomic on the same filesystem, so a
 * crash mid-write leaves the previous good file intact instead of a truncated one.
 */
function persist() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await rename(tmp, FILE);
  }).catch((err) => {
    console.error('[store] write failed:', err.message);
  });
  return writeQueue;
}

/** BRL-4F9K2A — short enough to read over the phone, random enough not to guess. */
export function makeRef() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // no 0/O/1/I
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `BRL-${out}`;
}

export async function add(booking) {
  await load();

  // Refs are random; on the astronomically unlikely collision, just draw again.
  let ref = makeRef();
  while (cache.some((b) => b.ref === ref)) ref = makeRef();

  const record = { ref, status: 'pending', createdAt: new Date().toISOString(), ...booking };
  cache.unshift(record);
  await persist();
  return record;
}

export function find(ref) {
  return (cache ?? []).find((b) => b.ref === ref) ?? null;
}

/**
 * Record how delivery to one destination is going.
 * Merged rather than replaced so a retry keeps the original recordId.
 */
export async function setSync(ref, destination, patch) {
  const b = find(ref);
  if (!b) return null;

  b.sync ??= {};
  b.sync[destination] = { ...(b.sync[destination] ?? {}), ...patch };

  await persist();
  return b;
}

/** Mark what a scheduled job has already done, so it never repeats itself. */
export async function setJob(ref, patch) {
  const b = find(ref);
  if (!b) return null;

  b.jobs = { ...(b.jobs ?? {}), ...patch };
  await persist();
  return b;
}

export async function setStatus(ref, status) {
  await load();
  const found = cache.find((b) => b.ref === ref);
  if (!found) return null;
  found.status = status;
  found.updatedAt = new Date().toISOString();
  await persist();
  return found;
}
