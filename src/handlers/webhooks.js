'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const mapleradWebhook = require('../utils/mapleradWebhook');
const cardOrchestrator = require('../services/cardOrchestrator');

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
    // We already stored the raw event, so nothing is lost even if processing
    // fails - log server-side and still acknowledge receipt (200) so
    // Maplerad doesn't endlessly retry a webhook we simply couldn't map.
    // eslint-disable-next-line no-console
    console.error('Error processing Maplerad webhook:', event.event, err);
  }

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

module.exports = { receiveMaplerad };
