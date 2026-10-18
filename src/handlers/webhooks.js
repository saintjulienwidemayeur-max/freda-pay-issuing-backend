'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const mapleradWebhook = require('../utils/mapleradWebhook');
const cardOrchestrator = require('../services/cardOrchestrator');
const tranzak = require('../services/tranzak');
const paymentOrchestrator = require('../services/paymentOrchestrator');

/**
 * POST /webhooks/maplerad
 * Public endpoint (no API key - Maplerad itself calls this). Trust is
 * established purely via the Svix-style HMAC signature, never by IP or
 * obscurity. See src/utils/mapleradWebhook.js and
 * https://maplerad.dev/docs/verifying-webhooks
 */
async function receiveMaplerad(ctx) {
  const svixId = ctx.req.headers['svix-id'];
  const svixTimestamp = ctx.req.headers['svix-timestamp'];
  const svixSignature = ctx.req.headers['svix-signature'];

  // Sandbox and live each have their OWN signing secret (Maplerad issues one
  // per environment). The secret that validates the signature tells us which
  // environment sent the event - that is the only trusted source of the mode.
  let webhookMode = null;
  let result = { valid: false };
  for (const [mode, secret] of [['sandbox', config.maplerad.webhookSecret], ['live', config.maplerad.liveWebhookSecret]]) {
    if (!secret) continue;
    const attempt = mapleradWebhook.verify({
      svixId,
      svixTimestamp,
      rawBody: ctx.rawBody || '',
      signatureHeader: svixSignature,
      signingSecret: secret,
    });
    if (attempt.valid) {
      result = attempt;
      webhookMode = mode;
      break;
    }
  }

  if (!result.valid) {
    // 401 tells Maplerad the delivery was rejected (it will retry per their
    // retry schedule); never process an unverified payload.
    throw httpError(401, 'INVALID_SIGNATURE', 'Signature de webhook invalide.');
  }

  // Idempotency: Maplerad may resend the same event after a delivery failure.
  const already = await supabase.selectOne('webhook_events', { id: svixId });
  if (already) {
    return { status: 200, body: { received: true, duplicate: true } };
  }

  let event;
  try {
    event = JSON.parse(ctx.rawBody);
  } catch (e) {
    throw httpError(400, 'INVALID_JSON', 'Corps du webhook invalide.');
  }

  await supabase.insert('webhook_events', {
    id: svixId,
    provider: 'maplerad',
    event_type: event.event || null,
    payload: event,
  });

  try {
    await processMapleradEvent(event, webhookMode);
  } catch (err) {
    // A failure here (database hiccup...) must not turn the event into a "duplicate" that is never processed: release the
    // record and answer 500 so the partner delivers it again. Processing is idempotent (every money step is a claim).
    // eslint-disable-next-line no-console
    console.error('Error processing Maplerad webhook:', event.event, err);
    await supabase.delete('webhook_events', { id: svixId }).catch(() => {});
    throw httpError(500, 'PROCESSING_ERROR', 'Traitement impossible pour le moment.');
  }

  return { status: 200, body: { received: true } };
}

/**
 * POST /webhooks/tranzak  (card payments)
 * Trust comes only from the HMAC signature (X-Tranzak-Signature) on the RAW body. The secret that matches tells which
 * environment sent it. The event is only a signal: the payment is read again from the partner before anything is
 * credited, so a replayed or doctored body can never create money.
 */
async function receiveTranzak(ctx) {
  const mode = tranzak.verifyWebhook(ctx.rawBody || '', ctx.req.headers['x-tranzak-signature']);
  if (!mode) throw httpError(403, 'INVALID_SIGNATURE', 'Signature de webhook invalide.');

  let event;
  try { event = JSON.parse(ctx.rawBody); } catch (e) { throw httpError(400, 'INVALID_JSON', 'Corps du webhook invalide.'); }
  const data = (event && event.data) || {};
  if (!data.transaction_id || !['payment.success', 'payment.failed'].includes(event.event)) {
    return { status: 200, body: { received: true, ignored: true } };
  }

  // The same event can arrive more than once: it is processed once per (transaction, event). (The claim inside
  // applyCardResult is what really prevents a double credit; this record just avoids useless work.)
  const eventId = `tranzak:${data.transaction_id}:${event.event}`;
  if (await supabase.selectOne('webhook_events', { id: eventId })) {
    return { status: 200, body: { received: true, duplicate: true } };
  }

  const payment = await supabase.selectOne('payments', { provider: 'tranzak', provider_transaction_id: String(data.transaction_id) });
  if (!payment) {
    // Possibly faster than our own insert of the payment: answer "not yet" so the partner retries (the reconciliation also covers it).
    throw httpError(503, 'PAYMENT_NOT_FOUND', 'Paiement inconnu pour le moment.');
  }
  if ((payment.mode || 'sandbox') !== mode) {
    // eslint-disable-next-line no-console
    console.error(`Card webhook mode mismatch for ${payment.id}: ${mode} event on a ${payment.mode} payment. Ignored.`);
    return { status: 200, body: { received: true, ignored: true } };
  }

  try {
    // Read the payment again at the source: only what the partner returns is trusted.
    const remote = await tranzak.retrievePayment(mode, data.transaction_id);
    await paymentOrchestrator.applyCardResult(payment, remote || data);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error processing card webhook:', event.event, err);
    throw httpError(500, 'PROCESSING_ERROR', 'Traitement impossible pour le moment.'); // the partner retries
  }
  try {
    await supabase.insert('webhook_events', { id: eventId, provider: 'tranzak', event_type: event.event, payload: event });
  } catch (_) { /* a concurrent copy of the same event recorded it first */ }
  return { status: 200, body: { received: true } };
}

async function processMapleradEvent(event, webhookMode) {
  switch (event.event) {
    case 'issuing.created.successful': {
      const card = event.card || {};
      await cardOrchestrator.applyCardCreationWebhook({
        mapleradReference: event.reference,
        mapleradCardId: card.id,
        maskedPan: card.masked_pan,
        holderName: card.name,
        status: 'ACTIVE',
        currency: card.currency,
        webhookMode,
      });
      break;
    }
    case 'issuing.created.failed': {
      await cardOrchestrator.applyCardCreationWebhook({
        mapleradReference: event.reference,
        status: 'FAILED',
        webhookMode,
      });
      break;
    }
    case 'issuing.transaction': {
      // Every transaction notification is stored (the admin's spending figures read them); a low-balance DECLINE
      // additionally charges the decline fee.
      await cardOrchestrator.recordCardTransaction(event, webhookMode);
      await cardOrchestrator.applyCardDeclineWebhook(event, webhookMode);
      break;
    }
    // issuing.terminated, issuing.charge, issuing.activation: recorded in webhook_events only.
    default:
      break;
  }
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { receiveMaplerad, receiveTranzak };
