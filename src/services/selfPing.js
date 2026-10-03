'use strict';
const config = require('../config');

const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Keeps a free-tier host (Render, etc.) awake by pinging this server's own
 * /health endpoint every 10 minutes. Free plans spin down after ~15 minutes
 * of no incoming HTTP traffic; a periodic self-ping counts as traffic and
 * prevents that, at the cost of the instance never fully idling (acceptable
 * tradeoff for a payments backend that should stay warm anyway).
 *
 * No-ops if no URL is configured (e.g. local dev) - see config.selfPing.
 */
function start() {
  const base = config.selfPing.url;
  if (!base) {
    // eslint-disable-next-line no-console
    console.log('Self-ping disabled (set SELF_PING_URL, or deploy on Render which sets RENDER_EXTERNAL_URL automatically).');
    return null;
  }

  const target = `${base.replace(/\/+$/, '')}/health`;
  // eslint-disable-next-line no-console
  console.log(`Self-ping enabled: pinging ${target} every 10 minutes to keep the host awake.`);

  const timer = setInterval(async () => {
    try {
      const res = await fetch(target);
      // eslint-disable-next-line no-console
      console.log(`Self-ping -> ${res.status}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Self-ping failed:', err.message);
    }
  }, PING_INTERVAL_MS);

  // Never block the process from exiting on its own (e.g. in tests/scripts).
  timer.unref();
  return timer;
}

module.exports = { start };
