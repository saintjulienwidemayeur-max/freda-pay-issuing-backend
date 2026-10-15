'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { randomHex } = require('../utils/ids');

// Simple retry schedule: immediate, then +5s, then +30s. After that we give
// up and just log it - a merchant who needs stronger delivery guarantees
// than best-effort HTTP should also poll as a safety net (same advice we
// give for Maplerad's own inbound webhooks).
const RETRY_DELAYS_MS = [0, 5000, 30000];
const DELIVERY_TIMEOUT_MS = 8000;

/**
 * Notifies the merchant's registered webhook endpoint (if any) of an event.
 * Fire-and-forget: never awaited by callers, so a slow/down merchant server
 * never slows down the actual API response that triggered the event.
 */
function dispatch(merchantId, event, data) {
  // Deliberately not awaited by the caller - see comment above.
  dispatchAsync(merchantId, event, data).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`Webhook dispatch setup failed for merchant ${merchantId}, event ${event}:`, err.message);
  });
}

async function dispatchAsync(merchantId, event, data) {
  const endpoint = await supabase.selectOne('webhook_endpoints', { merchant_id: merchantId, active: true });
  if (!endpoint) return; // merchant hasn't registered a webhook - they're polling instead, nothing to do

  const payload = {
    id: `evt_${randomHex(12)}`,
    event,
    created_at: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex');

  attemptDelivery(endpoint.url, body, signature, payload.id, 0);
}

async function attemptDelivery(url, body, signature, eventId, attemptIndex) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Freda-Signature': `sha256=${signature}`,
          'X-Freda-Event-Id': eventId,
          'X-Freda-Delivery-Attempt': String(attemptIndex + 1),
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (res.ok) return; // any 2xx = delivered, per our docs
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const nextAttempt = attemptIndex + 1;
    if (nextAttempt < RETRY_DELAYS_MS.length) {
      const timer = setTimeout(
        () => attemptDelivery(url, body, signature, eventId, nextAttempt),
        RETRY_DELAYS_MS[nextAttempt]
      );
      timer.unref();
    } else {
      // eslint-disable-next-line no-console
      console.error(`Webhook delivery to ${url} failed permanently (event ${eventId}) after ${nextAttempt} attempts:`, err.message);
    }
  }
}

/**
 * Sends ONE event to the merchant's endpoint right now and reports the outcome (used when an admin re-sends a webhook,
 * so the admin sees whether the merchant's server accepted it). Same payload shape and signature as a normal delivery.
 */
async function deliverNow(merchantId, event, data) {
  const endpoint = await supabase.selectOne('webhook_endpoints', { merchant_id: merchantId, active: true });
  if (!endpoint) return { sent: false, reason: 'NO_ENDPOINT' };
  const payload = { id: `evt_${randomHex(12)}`, event, created_at: new Date().toISOString(), data, resent_by_admin: true };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Freda-Signature': `sha256=${signature}`,
        'X-Freda-Event-Id': payload.id,
        'X-Freda-Delivery-Attempt': '1',
      },
      body,
      signal: controller.signal,
    });
    return { sent: res.ok, http_status: res.status, event_id: payload.id, reason: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { sent: false, event_id: payload.id, reason: err.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE' };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { dispatch, deliverNow };
