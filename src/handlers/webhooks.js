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
    require('../services/providerErrors').record({ mode: webhookMode, route: `webhook ${event.event || event.eventType || '?'}`, method: 'WEBHOOK', path: String(event.reference || event.card_id || ''), message: `Le webhook n'a pas pu être traité : ${err.message}`, shown_to_merchant: null }).catch(() => {}); // visible in admin "Erreurs cartes"
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
/**
 * POST /webhooks/plopplop : the MonCash / Natcash partner tells us a transaction was created or changed status
 * (events transaction.created and transaction.status_changed; its documentation, section Webhooks). The partner's URL is set on its side
 * (webhook_url of our merchant account). The signature header X-Webhook-Signature is "sha256=" + HMAC-SHA256 of the raw body with our
 * client_secret (present when a secret is configured there). The notification is only a signal: the payment is read again at the partner
 * (paiement-verify) before anything is credited, so a forged or best-effort notification can never credit by itself.
 */
async function receivePlopplop(ctx) {
  const secret = config.plopplop.clientSecret;
  const given = String(ctx.req.headers['x-webhook-signature'] || '');
  if (given && secret) {
    const expected = 'sha256=' + require('crypto').createHmac('sha256', secret).update(ctx.rawBody || '').digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) throw httpError(401, 'INVALID_SIGNATURE', 'Signature de webhook invalide.');
  }
  let event;
  try { event = JSON.parse(ctx.rawBody || ''); } catch (e) { throw httpError(400, 'INVALID_JSON', 'Corps du webhook invalide.'); }
  const t = (event && event.transaction) || {};
  const reference = String(t.reference_id || t.refference_id || '');
  if (!reference || !['transaction.created', 'transaction.status_changed'].includes(event.event)) return { status: 200, body: { received: true, ignored: true } };

  // Kept for the admin (is the partner really notifying us?), one record per notification.
  const eventId = `plopplop:${t.transaction_id || reference}:${event.event}:${t.new_status || t.status || ''}:${event.timestamp || ''}`.slice(0, 200);
  if (await supabase.selectOne('webhook_events', { id: eventId })) return { status: 200, body: { received: true, duplicate: true } };
  await supabase.insert('webhook_events', { id: eventId, provider: 'plopplop', event_type: event.event, payload: event }).catch(() => {});

  const orchestrator = require('../services/paymentOrchestrator');
  // The partner may name the payment differently from our reference: its transaction id is the second way to find it.
  const payment = (await supabase.selectOne('payments', { plopplop_reference: reference }))
    || (t.transaction_id ? await supabase.selectOne('payments', { plopplop_transaction_id: String(t.transaction_id) }) : null);
  if (payment) {
    if (event.event === 'transaction.status_changed' || payment.status === 'pending') await orchestrator.refreshStatus(payment.merchant_id, payment);
    return { status: 200, body: { received: true } };
  }
  const topup = (await supabase.selectOne('wallet_topups', { plopplop_reference: reference }))
    || (t.transaction_id ? await supabase.selectOne('wallet_topups', { plopplop_transaction_id: String(t.transaction_id) }) : null);
  if (topup) {
    await require('../services/walletTopupOrchestrator').refreshAutoTopup(topup.merchant_id, topup);
    return { status: 200, body: { received: true } };
  }
  return { status: 200, body: { received: true, ignored: true } }; // not one of ours (or not saved yet: the background pass covers it)
}

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

async function processMapleradEvent(rawEvent, webhookMode) {
  // The partner documents some events wrapped as { eventId, eventType, payload: {...} }: the payload is the event itself.
  const event = (!rawEvent.event && rawEvent.payload && typeof rawEvent.payload === 'object') ? Object.assign({ event: rawEvent.eventType }, rawEvent.payload) : rawEvent;
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
      const body = event;
      await cardOrchestrator.applyCardCreationWebhook({
        mapleradReference: body.reference || event.reference,
        status: 'FAILED',
        providerReason: [body.reason, body.failure_reason, body.failureReason, body.message, body.error].find((v) => typeof v === 'string' && v.trim()) || null,
        verificationLink: typeof body.verification_link === 'string' && /^https:\/\//.test(body.verification_link) ? body.verification_link : null,
        linkExpireAt: body.link_expire_at || null,
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
    case 'collection.successful':
    case 'collection.failed':
    case 'crypto.deposit.successful': {
      // A stablecoin deposit converted to USD: credited to the merchant's Master Wallet once (see services/cryptoWallet).
      await require('../services/cryptoWallet').applyDepositEvent(event, webhookMode);
      break;
    }
    case 'issuing.terminated': {
      await cardOrchestrator.applyCardTerminationWebhook(event, webhookMode);
      break;
    }
    case 'issuing.charge': {
      // A fee the partner takes from the card: stored as a transaction so the balance follows it (the event has no type or direction).
      await cardOrchestrator.recordCardTransaction({ event: 'issuing.transaction', type: 'CHARGE', mode: 'DEBIT', status: 'SUCCESS', amount: event.amount, currency: 'USD', card_id: event.card_id, created_at: event.transaction_date, description: 'Frais de carte', reference: event.reference }, webhookMode);
      break;
    }
    // issuing.activation: recorded in webhook_events only.
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

module.exports = {
  receivePlopplop, receiveMaplerad, receiveTranzak };
