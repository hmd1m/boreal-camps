/**
 * Server-side validation.
 *
 * The browser validates too, but that's a convenience for the customer — not a
 * security boundary. Anyone can POST straight to /api/bookings with curl, so
 * every rule the form enforces is enforced again here, independently.
 */

import { TRIPS, GEAR, MAX_PEOPLE_PER_BOOKING } from './trips.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const isStr = (v) => typeof v === 'string';
const clean = (v) => (isStr(v) ? v.trim() : '');
const digits = (v) => clean(v).replace(/\D/g, '');

/**
 * @returns {{ok: true, data: object} | {ok: false, errors: Record<string,string>}}
 */
export function validateBooking(raw) {
  const errors = {};

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: { _: 'Request body must be a JSON object.' } };
  }

  /* ── trip ────────────────────────────────────────────── */
  const tripKey = clean(raw.trip?.key);
  if (!TRIPS[tripKey]) errors.trip = 'Unknown trip.';

  /* ── people ──────────────────────────────────────────── */
  const people = Number(raw.people);
  if (!Number.isInteger(people) || people < 1 || people > MAX_PEOPLE_PER_BOOKING) {
    errors.people = `Number of people must be a whole number between 1 and ${MAX_PEOPLE_PER_BOOKING}.`;
  }

  /* ── contact ─────────────────────────────────────────── */
  const name  = clean(raw.contact?.name);
  const email = clean(raw.contact?.email);
  const phone = clean(raw.contact?.phone);
  const city  = clean(raw.contact?.city);

  if (name.length < 2 || name.length > 120) errors.name = 'Enter a full name.';
  if (!EMAIL_RE.test(email) || email.length > 200) errors.email = 'Enter a valid email address.';
  if (digits(phone).length < 10 || digits(phone).length > 15) errors.phone = 'Enter a valid phone number.';
  if (city.length > 120) errors.city = 'City name is too long.';

  /* ── emergency contact ───────────────────────────────── */
  const emName  = clean(raw.emergency?.name);
  const emPhone = clean(raw.emergency?.phone);

  if (emName.length < 2 || emName.length > 120) errors.emergencyName = 'Emergency contact name is required.';
  if (digits(emPhone).length < 10 || digits(emPhone).length > 15) errors.emergencyPhone = 'Enter a valid emergency phone number.';

  /* ── gear ────────────────────────────────────────────── */
  let gear = Array.isArray(raw.gear) ? raw.gear.filter(isStr) : [];
  gear = [...new Set(gear)];                        // drop duplicates
  const badGear = gear.filter((g) => !GEAR[g]);
  if (badGear.length) errors.gear = `Unknown gear item: ${badGear.join(', ')}`;

  /* ── notes ───────────────────────────────────────────── */
  const notes = clean(raw.notes);
  if (notes.length > 1000) errors.notes = 'Notes are limited to 1000 characters.';

  /* ── consent ─────────────────────────────────────────── */
  if (raw.consent !== true) errors.consent = 'You must accept the camp rules and cancellation policy.';

  if (Object.keys(errors).length) return { ok: false, errors };

  /* Return a clean, normalised object — nothing else from the request
     is carried forward, so unexpected fields can't reach storage. */
  return {
    ok: true,
    data: {
      tripKey,
      people,
      contact:   { name, email, phone, city: city || null },
      emergency: { name: emName, phone: emPhone },
      gear,
      notes: notes || null,
      source: clean(raw.source) || 'unknown',
    },
  };
}
