/**
 * Request handling, shared by both hosts.
 *
 *   server.js     — long-running node process (local, Render)
 *   api/index.js  — serverless function (Vercel)
 *
 * The two differ in lifecycle, not behaviour:
 *   • long-running  → boot once, keep state, deliver in the background
 *   • serverless    → cold start per container, state rebuilt from Airtable,
 *                     delivery awaited because the process dies at response
 */

import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, configSummary } from './config.js';
import { TRIPS, priceBooking, seatsRemaining, availability } from './trips.js';
import { validateBooking } from './validate.js';
import * as store from './store.js';
import * as pipeline from './pipeline.js';
import * as scheduler from './scheduler.js';
import * as airtable from './destinations/airtable.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');

/** Serverless containers die after responding, so background work never runs. */
export const SERVERLESS = Boolean(process.env.VERCEL);

/* ══════════════════════════════════════════════════════════
   helpers
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
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

async function sendFile(res, relPath) {
  const full = normalize(join(PUBLIC, relPath));
  if (!full.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });

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

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve) => {
    // Some hosts parse the body before the handler runs.
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'object') return resolve({ value: req.body });
      try { return resolve({ value: JSON.parse(String(req.body)) }); }
      catch { return resolve({ error: 'Body is not valid JSON.' }); }
    }

    let size = 0;
    const chunks = [];

    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { resolve({ error: 'Request body too large.' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({ error: 'Empty request body.' });
      try { resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
      catch { resolve({ error: 'Body is not valid JSON.' }); }
    });
    req.on('error', () => resolve({ error: 'Could not read request body.' }));
  });
}

/* ══════════════════════════════════════════════════════════
   rate limiting
   In-process only. On serverless each container has its own map, so this is a
   speed bump rather than a hard limit — noted here so it isn't mistaken for one.
   ══════════════════════════════════════════════════════════ */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  'unknown';

const adminOk = (req) =>
  !config.adminToken || req.headers['x-admin-token'] === config.adminToken;

/* ══════════════════════════════════════════════════════════
   boot — rebuild state from Airtable
   ══════════════════════════════════════════════════════════ */

let booted = null;
let lastHydrated = 0;

async function hydrate() {
  if (!airtable.isEnabled()) return;
  try {
    const added = await store.hydrate(await airtable.list());
    lastHydrated = Date.now();
    if (added) console.log(`[store] restored ${added} booking(s) from Airtable`);
  } catch (err) {
    console.warn(`[store] could not read Airtable: ${err.message}`);
  }
}

export function boot() {
  booted ??= (async () => { await store.load(); await hydrate(); })();
  return booted;
}

/** A warm serverless container can hold stale seat counts — refresh periodically. */
async function freshen() {
  if (!SERVERLESS) return;
  if (Date.now() - lastHydrated < 10_000) return;
  await hydrate();
}

/* ══════════════════════════════════════════════════════════
   booking
   ══════════════════════════════════════════════════════════ */

async function createBooking(req, res) {
  if (rateLimited(clientIp(req))) {
    return json(res, 429, { error: 'Too many booking attempts. Please try again in a few minutes.' });
  }

  const body = await readJson(req);
  if (body.error) return json(res, 400, { error: body.error });

  const check = validateBooking(body.value);
  if (!check.ok) return json(res, 422, { error: 'Some fields need fixing.', fields: check.errors });

  const { tripKey, people, contact, emergency, gear, notes, source } = check.data;

  await freshen();

  const left = seatsRemaining(tripKey, store.all());
  if (people > left) {
    return json(res, 409, {
      error: left === 0
        ? `${TRIPS[tripKey].label} is fully booked.`
        : `Only ${left} spot${left === 1 ? '' : 's'} left on ${TRIPS[tripKey].label}.`,
      remaining: left,
    });
  }

  const pricing = priceBooking(tripKey, people, gear);

  const clientTotal = Number(body.value?.estimatedTotal);
  if (Number.isFinite(clientTotal) && clientTotal !== pricing.total) {
    console.warn(`[price] client said $${clientTotal}, server says $${pricing.total} — using server value`);
  }

  const booking = await store.add({
    trip: { key: tripKey, label: TRIPS[tripKey].label, departs: TRIPS[tripKey].departs },
    people, contact, emergency, gear, notes, pricing, source,
  });

  console.log(`[booking] ${booking.ref} ${booking.trip.label} ${people}p $${pricing.total}`);

  /* Long-running: fire and forget, so the customer never waits on Airtable and
     retries continue in the background.
     Serverless: the container is frozen the moment we respond, so background
     work would silently never happen — the write has to be awaited. */
  if (SERVERLESS) {
    await pipeline.deliverAndWait(booking);
  } else {
    pipeline.deliver(booking);
  }

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
   router
   ══════════════════════════════════════════════════════════ */

export async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    await boot();

    /* static — Vercel serves public/ itself, this covers the local server */
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return sendFile(res, 'index.html');
    if (req.method === 'GET' && (path === '/admin' || path === '/admin.html')) return sendFile(res, 'admin.html');

    if (req.method === 'GET' && path === '/api/availability') {
      await freshen();
      return json(res, 200, { trips: availability(store.all()) });
    }

    if (req.method === 'POST' && path === '/api/bookings') return await createBooking(req, res);

    if (path.startsWith('/api/bookings')) {
      if (!adminOk(req)) return json(res, 401, { error: 'Unauthorized.' });

      if (req.method === 'GET' && path === '/api/bookings') {
        await freshen();
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
        await pipeline.syncStatus(updated);
        return json(res, 200, { ok: true, booking: updated });
      }

      const r = path.match(/^\/api\/bookings\/([A-Z0-9-]+)\/retry$/i);
      if (req.method === 'POST' && r) {
        const ok = await pipeline.retry(r[1].toUpperCase(), { wait: SERVERLESS });
        if (!ok) return json(res, 404, { error: 'No booking with that reference.' });
        return json(res, 202, { ok: true, queued: true });
      }
    }

    /* Scheduled jobs. Vercel Cron calls this with a bearer token; the dashboard
       calls it with the admin token so a demo doesn't wait for the next tick. */
    if (req.method === 'POST' && path === '/api/scheduler/run') {
      const cronAuth = config.cronSecret &&
        req.headers.authorization === `Bearer ${config.cronSecret}`;
      if (!cronAuth && !adminOk(req)) return json(res, 401, { error: 'Unauthorized.' });
      await freshen();
      return json(res, 200, { ok: true, ...(await scheduler.tick()) });
    }
    /* Vercel Cron can only issue GET */
    if (req.method === 'GET' && path === '/api/cron') {
      const cronAuth = !config.cronSecret ||
        req.headers.authorization === `Bearer ${config.cronSecret}`;
      if (!cronAuth) return json(res, 401, { error: 'Unauthorized.' });
      await freshen();
      return json(res, 200, { ok: true, ...(await scheduler.tick()) });
    }

    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, {
        ok: true,
        bookings: store.all().length,
        serverless: SERVERLESS,
        integrations: Object.fromEntries(configSummary()),
      });
    }

    return json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('[error]', err);
    return json(res, 500, { error: 'Something went wrong on our side.' });
  }
}
