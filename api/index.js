/**
 * Vercel entry point.
 *
 * One function handles every /api route. The routing itself lives in
 * lib/router.js and is shared with the local server, so there is only ever one
 * definition of what each endpoint does.
 */

import { handle, boot } from '../lib/router.js';

// Runs once per cold start, reused while the container stays warm.
const ready = boot();

export default async function handler(req, res) {
  await ready;
  return handle(req, res);
}
