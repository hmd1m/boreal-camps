/**
 * Scheduled jobs.
 *
 * This is the part that separates an automation from an app: nobody presses
 * anything. The process wakes on a timer, looks at the data, and acts.
 *
 * Jobs
 *   trip-reminder    N days before departure, flag confirmed bookings for a reminder
 *   pending-chase    a booking still 'pending' after N hours needs a phone call
 *   delivery-sweep   anything never delivered to a destination gets another go
 *
 * Every job is idempotent — it records what it did on the booking, so running
 * twice (restart, overlapping tick) never doubles up.
 */

import { config } from './config.js';
import * as store from './store.js';
import * as pipeline from './pipeline.js';

const DAY_MS = 86_400_000;

let timer = null;
let running = false;

const daysUntil = (iso) =>
  Math.ceil((new Date(iso + 'T00:00:00Z') - Date.now()) / DAY_MS);

const hoursSince = (iso) => (Date.now() - new Date(iso)) / 3_600_000;

/* ══════════════════════════════════════════════════════════
   jobs
   ══════════════════════════════════════════════════════════ */

/** Departure is close — remind confirmed guests once. */
async function tripReminder() {
  const window = config.scheduler.reminderDaysBefore;
  let sent = 0;

  for (const b of store.all()) {
    if (b.status !== 'confirmed') continue;
    if (b.jobs?.reminderSentAt) continue;              // idempotent

    const left = daysUntil(b.trip.departs);
    if (left < 0 || left > window) continue;

    console.log(
      `[scheduler] reminder → ${b.contact.name} <${b.contact.email}> ` +
      `· ${b.trip.label} departs in ${left} day${left === 1 ? '' : 's'}`
    );

    await store.setJob(b.ref, { reminderSentAt: new Date().toISOString(), reminderDaysOut: left });
    sent++;
  }
  return sent;
}

/** Still pending after a day — surface it so a human actually calls. */
async function pendingChase() {
  const after = config.scheduler.pendingChaseHours;
  let flagged = 0;

  for (const b of store.all()) {
    if (b.status !== 'pending') continue;
    if (b.jobs?.chaseFlaggedAt) continue;
    if (hoursSince(b.createdAt) < after) continue;

    console.log(
      `[scheduler] needs a call → ${b.ref} ${b.contact.name} ${b.contact.phone} ` +
      `(pending ${Math.round(hoursSince(b.createdAt))}h)`
    );

    await store.setJob(b.ref, { chaseFlaggedAt: new Date().toISOString() });
    flagged++;
  }
  return flagged;
}

/** Safety net for anything the retry chain gave up on or never started. */
async function deliverySweep() {
  let requeued = 0;

  for (const b of store.all()) {
    const stuck = pipeline.destinationNames.some((d) => {
      const s = b.sync?.[d];
      return !s || (s.status !== 'sent' && s.status !== 'failed');
    });
    if (!stuck) continue;

    pipeline.deliver(b);
    requeued++;
  }
  return requeued;
}

/* ══════════════════════════════════════════════════════════
   runner
   ══════════════════════════════════════════════════════════ */

export async function tick() {
  if (running) return;            // never let two ticks overlap
  running = true;

  try {
    const [reminders, chases, requeued] = [
      await tripReminder(),
      await pendingChase(),
      await deliverySweep(),
    ];

    if (reminders || chases || requeued) {
      console.log(
        `[scheduler] tick — ${reminders} reminder(s), ${chases} chase(s), ${requeued} requeued`
      );
    }
    return { reminders, chases, requeued };
  } catch (err) {
    console.error('[scheduler] tick failed:', err);
    return { error: err.message };
  } finally {
    running = false;
  }
}

export function start() {
  const every = Math.max(1, config.scheduler.intervalMinutes) * 60_000;

  tick();                                  // run once at boot, don't wait
  timer = setInterval(tick, every);
  timer.unref?.();

  return config.scheduler.intervalMinutes;
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
