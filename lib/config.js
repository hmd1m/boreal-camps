/**
 * Configuration, loaded from `.env` if present, otherwise from the real
 * environment (which is how a deployed host injects secrets).
 *
 * Nothing here throws on missing values. An unconfigured integration reports
 * `enabled: false` and its destination falls back to dry-run logging, so the
 * project runs start-to-finish on a fresh clone with no accounts at all.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = join(ROOT, '.env');

if (existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);        // Node 20.12+ / 21+
  } catch (err) {
    console.warn('[config] could not read .env:', err.message);
  }
}

const str = (key, fallback = '') => (process.env[key] ?? fallback).trim();
const num = (key, fallback) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  root: ROOT,
  port: num('PORT', 3000),
  adminToken: str('ADMIN_TOKEN') || null,

  airtable: {
    token:  str('AIRTABLE_TOKEN'),
    baseId: str('AIRTABLE_BASE_ID'),
    table:  str('AIRTABLE_TABLE', 'Bookings'),
    get enabled() { return Boolean(this.token && this.baseId); },
  },

  scheduler: {
    intervalMinutes:  num('SCHEDULER_INTERVAL_MINUTES', 15),
    reminderDaysBefore: num('REMINDER_DAYS_BEFORE', 3),
    pendingChaseHours:  num('PENDING_CHASE_HOURS', 24),
  },
};

/** One-line-per-integration summary, printed at startup. */
export function configSummary() {
  return [
    ['Airtable', config.airtable.enabled
      ? `→ base ${config.airtable.baseId} / ${config.airtable.table}`
      : 'dry run (set AIRTABLE_TOKEN + AIRTABLE_BASE_ID)'],
  ];
}
