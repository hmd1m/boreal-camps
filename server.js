/**
 * BOREAL — local / long-running host.
 *
 *   node server.js   →  http://localhost:3000
 *
 * Serves the landing page and the booking API from one origin, so requests are
 * same-origin and never hit a CORS preflight.
 *
 * The routing lives in lib/router.js and is shared with the Vercel function in
 * api/index.js — this file only owns the process lifecycle: listen, start the
 * scheduler, resume undelivered work, shut down cleanly.
 *
 * Zero runtime dependencies — node:http, node:fs, node:crypto only.
 */

import { createServer } from 'node:http';

import { config, configSummary } from './lib/config.js';
import { handle, boot } from './lib/router.js';
import * as store from './lib/store.js';
import * as pipeline from './lib/pipeline.js';
import * as scheduler from './lib/scheduler.js';

const PORT = config.port;

await boot();

const server = createServer(handle);

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

  if (!config.adminToken) {
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
