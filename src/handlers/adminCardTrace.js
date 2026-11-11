'use strict';
const cardTrace = require('../services/cardTrace');

/** GET /admin/card-trace?card=<id | reference | partner id> : who really asked for each operation on this card. */
async function trace(ctx) {
  const key = ctx.query && ctx.query.card;
  if (!key) { const e = new Error('Indiquez la carte (identifiant ou référence).'); e.httpStatus = 400; e.code = 'MISSING_FIELDS'; throw e; }
  const t = await cardTrace.trace(key);
  if (!t) { const e = new Error('Carte introuvable.'); e.httpStatus = 404; e.code = 'NOT_FOUND'; throw e; }
  return { status: 200, body: t };
}
module.exports = { trace };
