/**
 * Delivery pipeline.
 *
 * A booking is saved the moment it is valid. Getting it *out* to Airtable is a
 * separate concern that is allowed to fail and be retried — the customer must
 * never see an error just because a third-party API had a bad minute.
 *
 * Guarantees:
 *   • the HTTP response never waits on a third party
 *   • transient failures retry with exponential backoff
 *   • permanent failures (bad token, unknown column) stop immediately and are
 *     surfaced in the dashboard instead of retrying forever
 *   • delivery state is persisted, so a restart doesn't lose in-flight work
 *   • a row is written at most once — the saved record id makes retries safe
 */

import * as airtable from './destinations/airtable.js';
import * as store from './store.js';

const DESTINATIONS = [airtable];

/** Attempt N waits this long before firing. Roughly 5s → 30s → 2m → 10m → 30m. */
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

const timers = new Set();

function later(fn, ms) {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  t.unref?.();
  timers.add(t);
  return t;
}

/**
 * Try one destination for one booking, recording the outcome either way.
 */
async function attempt(dest, ref) {
  const booking = store.find(ref);
  if (!booking) return;

  const state = booking.sync?.[dest.name];

  // A dry-run "success" is not a real delivery. Once credentials appear, the
  // booking still has to go out for real — otherwise everything captured
  // before setup would be silently lost.
  const wasDryRun = state?.dryRun === true;
  const nowLive = dest.isEnabled?.() ?? true;

  if (state?.status === 'sent' && !(wasDryRun && nowLive)) return;
  if (!wasDryRun && (state?.attempts ?? 0) >= MAX_ATTEMPTS) return;   // gave up earlier

  const attempts = (state?.attempts ?? 0) + 1;

  try {
    const result = await dest.send(booking);

    await store.setSync(ref, dest.name, {
      status: 'sent',
      recordId: result.id,
      dryRun: result.dryRun ?? false,
      attempts,
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
    });

    console.log(`[pipeline] ${ref} → ${dest.name} ok${result.dryRun ? ' (dry run)' : ''}`);

  } catch (err) {
    const permanent = Boolean(err.permanent);
    const exhausted = attempts >= MAX_ATTEMPTS;
    const giveUp = permanent || exhausted;

    await store.setSync(ref, dest.name, {
      status: giveUp ? 'failed' : 'retrying',
      attempts,
      lastAttemptAt: new Date().toISOString(),
      lastError: err.message,
      permanent,
    });

    if (giveUp) {
      console.error(
        `[pipeline] ${ref} → ${dest.name} FAILED ` +
        `(${permanent ? 'permanent' : `${attempts} attempts`}): ${err.message}`
      );
      return;
    }

    const wait = BACKOFF_MS[attempts - 1];
    console.warn(
      `[pipeline] ${ref} → ${dest.name} attempt ${attempts} failed, ` +
      `retrying in ${Math.round(wait / 1000)}s: ${err.message}`
    );
    later(() => attempt(dest, ref), wait);
  }
}

/**
 * Kick off delivery. Deliberately NOT awaited by the request handler —
 * the customer gets their confirmation immediately.
 */
export function deliver(booking) {
  for (const dest of DESTINATIONS) {
    attempt(dest, booking.ref).catch((err) =>
      console.error(`[pipeline] unexpected error for ${booking.ref}:`, err)
    );
  }
}

/** Push a status change out to destinations that already hold the row. */
export async function syncStatus(booking) {
  for (const dest of DESTINATIONS) {
    const state = booking.sync?.[dest.name];
    if (state?.status !== 'sent' || !dest.updateStatus) continue;

    try {
      await dest.updateStatus(booking, state.recordId);
      console.log(`[pipeline] ${booking.ref} status → ${dest.name} ok`);
    } catch (err) {
      // A failed status echo is worth logging but must not fail the dashboard
      // action — the operator's change is already saved locally.
      console.warn(`[pipeline] ${booking.ref} status → ${dest.name} failed: ${err.message}`);
    }
  }
}

/** Manual retry, triggered from the dashboard. Clears the attempt counter. */
export async function retry(ref) {
  const booking = store.find(ref);
  if (!booking) return false;

  for (const dest of DESTINATIONS) {
    const state = booking.sync?.[dest.name];
    if (state?.status === 'sent') continue;

    await store.setSync(ref, dest.name, { status: 'queued', attempts: 0, lastError: null });
    attempt(dest, ref).catch(() => {});
  }
  return true;
}

/**
 * On boot, pick up anything left mid-flight by a restart.
 * Without this, a crash between "saved" and "sent" would strand the booking.
 */
export function resumePending() {
  const stuck = store.all().filter((b) =>
    DESTINATIONS.some((d) => {
      const s = b.sync?.[d.name];
      if (!s) return true;
      if (s.status === 'queued' || s.status === 'retrying') return true;
      // recorded as sent, but only into the void — re-send now that it's live
      return s.dryRun === true && (d.isEnabled?.() ?? true);
    })
  );

  if (!stuck.length) return 0;

  console.log(`[pipeline] resuming ${stuck.length} undelivered booking(s)`);
  stuck.forEach((b, i) => later(() => deliver(b), i * 400));   // gentle stagger
  return stuck.length;
}

export function shutdown() {
  timers.forEach(clearTimeout);
  timers.clear();
}

export const destinationNames = DESTINATIONS.map((d) => d.name);
