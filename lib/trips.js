/**
 * Trip catalogue — the single source of truth for pricing and capacity.
 *
 * The browser has its own copy of the labels and prices for the live summary,
 * but the server NEVER trusts those. Every total is recomputed from this file,
 * so a tampered request can't book an $890 trip for $1.
 */

export const TRIPS = {
  algonquin: {
    label:    'Algonquin Lakes',
    price:    340,          // CAD per person
    capacity: 16,
    seatsAlreadyTaken: 9,   // pre-existing bookings before this system went live
    departs:  '2026-09-12',
  },
  berglake: {
    label:    'Berg Lake Traverse',
    price:    890,
    capacity: 10,
    seatsAlreadyTaken: 8,
    departs:  '2026-09-26',
  },
  tofino: {
    label:    'Tofino Rainforest',
    price:    420,
    capacity: 14,
    seatsAlreadyTaken: 5,
    departs:  '2026-09-05',
  },
};

export const GEAR = {
  'tent':         { label: 'Extra tent',    price: 35 },
  'sleeping-bag': { label: 'Sleeping bag',  price: 25 },
  'backpack':     { label: '60L backpack',  price: 30 },
  'boots':        { label: 'Hiking boots',  price: 40 },
};

export const MAX_PEOPLE_PER_BOOKING = 8;

/** Label → key, for rebuilding local state from what Airtable stores. */
export const tripKeyByLabel = (label) =>
  Object.keys(TRIPS).find((k) => TRIPS[k].label === label) ?? null;

export const gearKeyByLabel = (label) =>
  Object.keys(GEAR).find((k) => GEAR[k].label === label) ?? null;

/**
 * Authoritative price calculation.
 * Gear is priced per person — matches what the form shows the customer.
 */
export function priceBooking(tripKey, people, gearKeys = []) {
  const trip = TRIPS[tripKey];
  if (!trip) return null;

  const gearPerPerson = gearKeys.reduce((sum, k) => sum + (GEAR[k]?.price ?? 0), 0);

  const tripTotal = trip.price * people;
  const gearTotal = gearPerPerson * people;

  return {
    tripTotal,
    gearTotal,
    total: tripTotal + gearTotal,
    currency: 'CAD',
  };
}

/** Seats still available, given everything booked through this system so far. */
export function seatsRemaining(tripKey, bookings) {
  const trip = TRIPS[tripKey];
  if (!trip) return 0;

  const bookedHere = bookings
    .filter((b) => b.trip.key === tripKey && b.status !== 'cancelled')
    .reduce((sum, b) => sum + b.people, 0);

  return Math.max(0, trip.capacity - trip.seatsAlreadyTaken - bookedHere);
}

/** Public availability snapshot — safe to expose to the browser. */
export function availability(bookings) {
  return Object.entries(TRIPS).map(([key, t]) => ({
    key,
    label: t.label,
    price: t.price,
    departs: t.departs,
    capacity: t.capacity,
    remaining: seatsRemaining(key, bookings),
  }));
}
