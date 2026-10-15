'use strict';
const siteVisits = require('../services/siteVisits');
const rateLimit = require('../utils/rateLimit');

/** POST /track : called by the public pages (analytics.js). Always answers 204, so a counting problem never shows on the site. */
async function track(ctx) {
  const b = ctx.body || {};
  try {
    await siteVisits.record({
      ip: rateLimit.clientIp(ctx.req),
      userAgent: ctx.req.headers['user-agent'],
      path: typeof b.path === 'string' ? b.path.slice(0, 200) : '/',
      referrer: typeof b.referrer === 'string' ? b.referrer.slice(0, 300) : '',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Visit not recorded:', err.message);
  }
  ctx.res.writeHead(204);
  ctx.res.end();
}

async function adminVisits() {
  return { status: 200, body: await siteVisits.stats() };
}

module.exports = { track, adminVisits };
