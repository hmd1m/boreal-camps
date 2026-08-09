/**
 * BOREAL — booking server
 *
 * Serves the landing page AND the booking API from the same origin, which means
 * no CORS preflight, no allowed-origins config, and one command to run everything.
 *
 *   node server.js          →  http://localhost:3000
 *
 * Routes
 *   GET  /                  landing page
 *   GET  /admin             bookings dashboard
 *   GET  /api/availability  live seat counts
 *   POST /api/bookings      create a booking
 *   GET  /api/bookings      list bookings   (admin)
 *   PATCH /api/bookings/:ref  change status (admin)
 *
 * Zero runtime dependencies — node:http, node:fs, node:crypto only.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, configSummary } from './lib/config.js';
import { TRIPS, priceBooking, seatsRemaining, availability } from './lib/trips.js';
import { validateBooking } from './lib/validate.js';
import * as store from './lib/store.js';
import * as pipeline from './lib/pipeline.js';
import * as scheduler from './lib/scheduler.js';
import * as airtable from './lib/destinations/airtable.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = config.port;
const ADMIN_TOKEN = config.adminToken;

/* ══════════════════════════════════════════════════════════
   small helpers
   ══════════════════════════════════════════════════════════ */

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

async function sendFile(res, relPath) {
  // normalize + prefix check keeps "../../etc/passwd" style paths inside ROOT
  const full = normalize(join(ROOT, relPath));
  if (!full.startsWith(ROOT)) return json(res, 403, { error: 'Forbidden' });

  try {
    const buf = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full)] ?? 'application/octet-stream',
      'content-length': buf.length,
    });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

/** Read a JSON body with a hard size cap so a huge POST can't exhaust memory. */
function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];

    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        resolve({ error: 'Request body too large.' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (!chunks.length) return resolve({ error: 'Empty request body.' });
      try {
        resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ error: 'Body is not valid JSON.' });
      }
    });

    req.on('error', () => resolve({ error: 'Could not read request body.' }));
  });
}

/* ══════════════════════════════════════════════════════════
   rate limiting — in-memory, per IP
   Fine for one process. A multi-instance deploy would move this to Redis.
   ══════════════════════════════════════════════════════════ */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();   // ip → number[] (timestamps)

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }

  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// keep the map from growing forever on a long-running process
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    const live = times.filter((t) => now - t < WINDOW_MS);
    live.length ? hits.set(ip, live) : hits.delete(ip);
  }
}, WINDOW_MS).unref();

/* ══════════════════════════════════════════════════════════
   admin auth
   ══════════════════════════════════════════════════════════ */

function adminOk(req) {
  if (!ADMIN_TOKEN) return true;   // dev mode — warned about at startup
  return req.headers['x-admin-token'] === ADMIN_TOKEN;
}

/* ══════════════════════════════════════════════════════════
   routes
   ══════════════════════════════════════════════════════════ */

async function createBooking(req, res, ip) {
  if (rateLimited(ip)) {
    return json(res, 429, { error: 'Too many booking attempts. Please try again in a few minutes.' });
  }

  const body = await readJson(req);
  if (body.error) return json(res, 400, { error: body.error });

  const check = validateBooking(body.value);
  if (!check.ok) {
    return json(res, 422, { error: 'Some fields need fixing.', fields: check.errors });
  }

  const { tripKey, people, contact, emergency, gear, notes, source } = check.data;

  /* capacity is checked server-side — the page's "spots left" badge is only a hint */
  const left = seatsRemaining(tripKey, store.all());
  if (people > left) {
    return json(res, 409, {
      error: left === 0
        ? `${TRIPS[tripKey].label} is fully booked.`
        : `Only ${left} spot${left === 1 ? '' : 's'} left on ${TRIPS[tripKey].label}.`,
      remaining: left,
    });
  }

  /* price is recomputed from the catalogue, never taken from the request */
  const pricing = priceBooking(tripKey, people, gear);

  const clientTotal = Number(body.value?.estimatedTotal);
  if (Number.isFinite(clientTotal) && clientTotal !== pricing.total) {
    console.warn(
      `[price] client said $${clientTotal}, server says $${pricing.total} — using server value`
    );
  }

  const booking = await store.add({
    trip: { key: tripKey, label: TRIPS[tripKey].label, departs: TRIPS[tripKey].departs },
    people,
    contact,
    emergency,
    gear,
    notes,
    pricing,
    source,
  });

  console.log(`[booking] ${booking.ref} ${booking.trip.label} ${people}p $${pricing.total}`);

  /* Not awaited on purpose — the customer's confirmation must not wait on
     Airtable, and a third-party outage must not turn a saved booking into an
     error. The pipeline owns retries from here. */
  pipeline.deliver(booking);

  return json(res, 201, {
    ok: true,
    ref: booking.ref,
    trip: booking.trip,
    people: booking.people,
    pricing: booking.pricing,
    remaining: seatsRemaining(tripKey, store.all()),
  });
}

/* ══════════════════════════════════════════════════════════
   server
   ══════════════════════════════════════════════════════════ */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const ip = req.socket.remoteAddress ?? 'unknown';

  try {
    /* ── static ── */
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return sendFile(res, 'index.html');
    }
    if (req.method === 'GET' && (path === '/admin' || path === '/admin.html')) {
      return sendFile(res, 'admin.html');
    }

    /* ── public API ── */
    if (req.method === 'GET' && path === '/api/availability') {
      return json(res, 200, { trips: availability(store.all()) });
    }

    if (req.method === 'POST' && path === '/api/bookings') {
      return await createBooking(req, res, ip);
    }

    /* ── admin API ── */
    if (path.startsWith('/api/bookings')) {
      if (!adminOk(req)) return json(res, 401, { error: 'Unauthorized.' });

      if (req.method === 'GET' && path === '/api/bookings') {
        return json(res, 200, { bookings: store.all(), trips: availability(store.all()) });
      }

      const m = path.match(/^\/api\/bookings\/([A-Z0-9-]+)$/i);
      if (req.method === 'PATCH' && m) {
        const body = await readJson(req);
        if (body.error) return json(res, 400, { error: body.error });

        const status = body.value?.status;
        if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
          return json(res, 422, { error: 'status must be pending, confirmed or cancelled.' });
        }

        const updated = await store.setStatus(m[1].toUpperCase(), status);
        if (!updated) return json(res, 404, { error: 'No booking with that reference.' });

        console.log(`[booking] ${updated.ref} → ${status}`);
        pipeline.syncStatus(updated);          // echo the change out to Airtable
        return json(res, 200, { ok: true, booking: updated });
      }

      /* re-deliver a booking whose sync failed */
      const r = path.match(/^\/api\/bookings\/([A-Z0-9-]+)\/retry$/i);
      if (req.method === 'POST' && r) {
        const ok = await pipeline.retry(r[1].toUpperCase());
        if (!ok) return json(res, 404, { error: 'No booking with that reference.' });
        return json(res, 202, { ok: true, queued: true });
      }
    }

    /* run the scheduled jobs on demand — lets the dashboard (and a demo video)
       show time-based automation without waiting for the next tick */
    if (req.method === 'POST' && path === '/api/scheduler/run') {
      if (!adminOk(req)) return json(res, 401, { error: 'Unauthorized.' });
      return json(res, 200, { ok: true, ...(await scheduler.tick()) });
    }

    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, {
        ok: true,
        bookings: store.all().length,
        integrations: Object.fromEntries(configSummary()),
      });
    }

    return json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('[error]', err);
    return json(res, 500, { error: 'Something went wrong on our side.' });
  }
});

await store.load();

/* Rebuild local state from Airtable before accepting traffic.
   On an ephemeral filesystem (Render free tier, containers) bookings.json is
   gone after every restart — without this the seat counts would reset and the
   site would oversell trips that are already full. */
if (airtable.isEnabled()) {
  try {
    const added = await store.hydrate(await airtable.list());
    if (added) console.log(`[store] restored ${added} booking(s) from Airtable`);
  } catch (err) {
    // Starting with a stale local copy beats not starting at all.
    console.warn(`[store] could not read Airtable at boot: ${err.message}`);
  }
}

server.listen(PORT, () => {
  console.log(`\n  BOREAL booking automation`);
  console.log(`  ─────────────────────────────────────────────────────`);
  console.log(`  site       http://localhost:${PORT}`);
  console.log(`  dashboard  http://localhost:${PORT}/admin`);
  console.log(`  bookings   ${store.all().length} on file`);

  console.log(`\n  destinations`);
  for (const [label, state] of configSummary()) {
    console.log(`    ${label.padEnd(10)} ${state}`);
  }

  const mins = scheduler.start();
  console.log(`\n  scheduler  every ${mins} min`);
  console.log(`    trip-reminder   ${config.scheduler.reminderDaysBefore} days before departure`);
  console.log(`    pending-chase   after ${config.scheduler.pendingChaseHours}h unconfirmed`);
  console.log(`    delivery-sweep  re-queues anything undelivered`);

  pipeline.resumePending();

  if (!ADMIN_TOKEN) {
    console.log(`\n  ⚠  ADMIN_TOKEN not set — the dashboard is open to anyone.`);
    console.log(`     Fine locally. Set it before deploying anywhere public.`);
  }
  console.log('');
});

/* Flush pending writes and stop timers cleanly on Ctrl-C. */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  shutting down…');
    scheduler.stop();
    pipeline.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
