'use strict';
const adminStats = require('../services/adminStats');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

/** GET /admin/profit?mode=live&from&to&kind : what each kind of operation earned (fees collected - partner costs), and the operations. Default: the last 30 days. */
async function breakdown(ctx) {
  const q = ctx.query || {};
  const to = q.to || new Date().toISOString().slice(0, 10);
  const from = q.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw httpError(400, 'INVALID_PERIOD', 'Période invalide : dates AAAA-MM-JJ, début avant fin.');
  const mode = q.mode === 'sandbox' ? 'sandbox' : 'live';
  const kind = q.kind ? String(q.kind).slice(0, 40) : undefined;
  return { status: 200, body: { mode, from, to, ...(await adminStats.profitBreakdown(mode, from, to, { kind, limit: 300 })) } };
}

module.exports = { breakdown };
