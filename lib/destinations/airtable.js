/**
 * Airtable destination.
 *
 * Turns a booking record into an Airtable row. This is the piece that makes the
 * project an *automation* rather than a self-contained web app: the data lands
 * in a system the business already works in, with no one retyping anything.
 *
 * If credentials are missing the module still "succeeds", but only logs the row
 * it would have written — so the pipeline, retries and dashboard can all be
 * demonstrated before any account exists.
 */

import { config } from '../config.js';
import { GEAR, TRIPS, tripKeyByLabel, gearKeyByLabel } from '../trips.js';

const API = 'https://api.airtable.com/v0';

export const name = 'airtable';

export const isEnabled = () => config.airtable.enabled;

/**
 * Booking → Airtable fields.
 * Kept in one place so a column rename is a one-line change.
 */
export function toFields(b) {
  return {
    'Reference':       b.ref,
    'Status':          b.status,
    'Trip':            b.trip.label,
    'Departs':         b.trip.departs,
    'People':          b.people,
    'Name':            b.contact.name,
    'Email':           b.contact.email,
    'Phone':           b.contact.phone,
    'City':            b.contact.city ?? '',
    'Gear':            (b.gear ?? []).map((g) => GEAR[g]?.label ?? g).join(', '),
    'Emergency Name':  b.emergency.name,
    'Emergency Phone': b.emergency.phone,
    'Notes':           b.notes ?? '',
    'Total (CAD)':     b.pricing.total,
    'Source':          b.source,
    'Booked At':       b.createdAt,
  };
}

/**
 * Create the row.
 * @returns {Promise<{id: string, dryRun?: boolean}>}
 * @throws  on any non-2xx response, so the pipeline can retry.
 */
export async function send(booking) {
  const fields = toFields(booking);

  if (!isEnabled()) {
    console.log(`[airtable:dry-run] would create row for ${booking.ref}:`,
      JSON.stringify(fields));
    return { id: 'dry-run', dryRun: true };
  }

  const url = `${API}/${config.airtable.baseId}/${encodeURIComponent(config.airtable.table)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.airtable.token}`,
      'content-type': 'application/json',
    },
    // typecast lets Airtable coerce strings into select options / dates
    // instead of rejecting the row outright.
    body: JSON.stringify({ fields, typecast: true }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Airtable ${res.status}: ${detail.slice(0, 300)}`);
    // 4xx (bad token, unknown column) will fail identically on every retry —
    // tell the pipeline not to waste attempts on it.
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }

  const data = await res.json();
  return { id: data.id };
}

/**
 * Read every row back, shaped like a local booking record.
 *
 * Needed because the host's filesystem is ephemeral on a free tier: a restart
 * wipes bookings.json. Without this, seat counts would reset and the site would
 * happily oversell trips that are actually full. Airtable is the real database —
 * the local file is only a working copy.
 */
export async function list() {
  if (!isEnabled()) return [];

  const rows = [];
  let offset;

  do {
    const url = new URL(`${API}/${config.airtable.baseId}/${encodeURIComponent(config.airtable.table)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${config.airtable.token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`Airtable ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }

    const data = await res.json();
    rows.push(...data.records);
    offset = data.offset;
  } while (offset);

  return rows.map(fromRecord).filter(Boolean);
}

/** Airtable row → the booking shape the rest of the app expects. */
function fromRecord(rec) {
  const f = rec.fields ?? {};
  const ref = f['Reference'];
  const tripKey = tripKeyByLabel(f['Trip']);

  // Rows that predate this system, or were typed in by hand, are skipped
  // rather than crashing the boot.
  if (!ref || !tripKey) return null;

  const gear = String(f['Gear'] ?? '')
    .split(',')
    .map((s) => gearKeyByLabel(s.trim()))
    .filter(Boolean);

  return {
    ref,
    status: f['Status'] ?? 'pending',
    createdAt: f['Booked At'] ?? new Date(0).toISOString(),
    trip: { key: tripKey, label: f['Trip'], departs: TRIPS[tripKey].departs },
    people: Number(f['People']) || 1,
    contact: {
      name:  f['Name']  ?? '',
      email: f['Email'] ?? '',
      phone: f['Phone'] ?? '',
      city:  f['City']  || null,
    },
    emergency: { name: f['Emergency Name'] ?? '', phone: f['Emergency Phone'] ?? '' },
    gear,
    notes: f['Notes'] || null,
    pricing: { total: Number(f['Total (CAD)']) || 0, currency: 'CAD' },
    source: f['Source'] ?? 'airtable',
    // it is already in Airtable, so mark it delivered — never re-create the row
    sync: { airtable: { status: 'sent', recordId: rec.id, attempts: 1, dryRun: false } },
  };
}

/** Keep an already-synced row in step when the status changes in the dashboard. */
export async function updateStatus(booking, recordId) {
  if (!isEnabled() || !recordId || recordId === 'dry-run') {
    console.log(`[airtable:dry-run] would set ${booking.ref} → ${booking.status}`);
    return;
  }

  const url = `${API}/${config.airtable.baseId}/${encodeURIComponent(config.airtable.table)}/${recordId}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${config.airtable.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ fields: { Status: booking.status }, typecast: true }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Airtable ${res.status}: ${detail.slice(0, 200)}`);
  }
}
