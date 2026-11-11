'use strict';
const supabase = require('../lib/supabase');

/**
 * "Did the merchant really make this request?" For one card, the timeline of everything that touched it, side by side:
 *  - what the partner recorded (funding, withdrawal, charges, purchases, declines),
 *  - the merchant's API / dashboard calls (the API journal: route, status, request id, time - never bodies),
 *  - our Master Wallet entries for the card (the money we really took from / gave back to the merchant),
 *  - the card's own creation (date, amount asked at creation).
 * Each partner funding/withdrawal/charge gets a verdict: a request by the merchant was found at that time, or none was.
 * The API journal is kept 14 days: older operations can only say "journal too old".
 */
const WINDOW_MS = 3 * 60 * 1000;
const JOURNAL_DAYS = 14;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const T = (v) => new Date(v).getTime();

async function resolveCard(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return (await supabase.selectOne('cards', { id: k })) || (await supabase.selectOne('cards', { own_reference: k })) || (await supabase.selectOne('cards', { maplerad_card_id: k })) || null;
}

const isFundCall = (r) => r.method === 'POST' && /\/(fund|recharge|topup|top-up)\b/i.test(`${r.route} ${r.path}`);
const isCreateCall = (r) => r.method === 'POST' && /\/cards\/?(\?|$)/i.test(String(r.path || r.route || '')) && !/\/cards\/[^/]+/i.test(String(r.path || ''));
const isWithdrawCall = (r) => r.method === 'POST' && /\/(withdraw|withdrawal)\b/i.test(`${r.route} ${r.path}`);

async function trace(key) {
  const card = await resolveCard(key);
  if (!card) return null;
  const merchant = await supabase.selectOne('merchants', { id: card.merchant_id });
  const [txs, ledgerRows, api] = await Promise.all([
    supabase.select('card_transactions', { card_id: card.id }, { order: 'occurred_at.asc', limit: 500 }),
    supabase.select('ledger_entries', { merchant_id: card.merchant_id, related_id: card.id }, { order: 'created_at.asc', limit: 500 }),
    supabase.select('api_call_log', { merchant_id: card.merchant_id }, { order: 'created_at.desc', limit: 3000 }).catch(() => []),
  ]);
  const journalFrom = Date.now() - JOURNAL_DAYS * 24 * 3600 * 1000;
  const calls = api.filter((r) => String(r.path || '').includes(card.id) || String(r.path || '').includes(card.own_reference) || isCreateCall(r)).map((r) => ({ ...r, at: r.created_at }));

  const near = (list, at, test) => list.filter((x) => Math.abs(T(x.at) - T(at)) <= WINDOW_MS && (!test || test(x)));
  const ledger = ledgerRows.map((e) => ({ at: e.created_at, reference: e.reference, amount: round2(e.amount), wallet: e.wallet, type: e.type }));

  const events = [];
  events.push({ at: card.created_at, source: 'card', title: 'Carte créée chez nous', detail: `Référence ${card.own_reference}${card.initial_amount != null ? `, montant demandé à la création : ${round2(Number(card.initial_amount) / 100)} $` : ''}`, amount: null });
  for (const c of calls) {
    events.push({ at: c.at, source: 'api', title: `Requête du marchand : ${c.method} ${c.route || c.path}`, detail: `Statut ${c.status}${c.code ? ` (${c.code})` : ''}${c.mode ? `, mode ${c.mode}` : ''}${c.request_id ? `, id de requête ${c.request_id}` : ''}`, amount: null, request_id: c.request_id || null });
  }
  for (const e of ledger) {
    events.push({ at: e.at, source: 'ledger', title: `Master Wallet ${e.amount >= 0 ? 'crédité' : 'débité'}`, detail: `Référence ${e.reference || '-'}`, amount: e.amount });
  }
  const declines = txs.filter((t) => /DECLIN|REJECT|FAIL/.test(String(t.status || '')) || String(t.type).toUpperCase() === 'DECLINE');

  // A request by the merchant (the API call + the Master Wallet debit it caused) is ONE span of time: the wallet is debited when it starts and the
  // API journal line is written when it ends, a few seconds later. Everything the partner records inside that span (plus a small margin) is part of it.
  const SPAN_MARGIN_MS = 10 * 1000;
  const anchorsOf = (callTest, ledgerTest) => {
    const items = [...calls.filter(callTest).map((c) => ({ at: c.at, call: c })), ...ledger.filter(ledgerTest).map((l) => ({ at: l.at, ledger: l }))].sort((x, y) => T(x.at) - T(y.at));
    const out = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (last && T(it.at) - T(last.end) <= 20 * 1000) { last.call = last.call || it.call; last.ledger = last.ledger || it.ledger; last.end = it.at; } else out.push({ start: it.at, end: it.at, call: it.call, ledger: it.ledger, events: [] });
    }
    return out;
  };
  const claim = (anchors, evs) => {
    const taken = new Map();
    for (const e of evs) {
      const hit = anchors.find((a) => T(e.at) >= T(a.start) - SPAN_MARGIN_MS && T(e.at) <= T(a.end) + SPAN_MARGIN_MS && !(a.ledger && e.amount != null && e.amount > Math.abs(a.ledger.amount) + 0.011));
      if (hit) { hit.events.push(e); taken.set(e, hit); }
    }
    return taken;
  };
  const fundingEvents = [];
  const partnerEvents = [];
  for (const t of txs) {
    const type = String(t.type || '').toUpperCase();
    const amount = t.amount_usd == null ? null : Number(t.amount_usd);
    const ev = { at: t.occurred_at || t.created_at, source: 'partner', type, title: `Fournisseur : ${type}${t.direction ? ` (${t.direction})` : ' (sans sens)'} ${t.status || ''}`.trim(), detail: `${t.description || ''}${t.merchant_name ? ` · ${t.merchant_name}` : ''} · réf ${t.provider_reference}`.replace(/^ · /, ''), amount, verdict: null };
    partnerEvents.push(ev);
    if (type === 'FUNDING') fundingEvents.push(ev);
  }
  const fundClaims = claim(anchorsOf((r) => isFundCall(r) || isCreateCall(r), (l) => l.amount < 0 && /^(fund:|fund-)|^[A-Za-z0-9_-]+$/.test(String(l.reference || ''))), fundingEvents);
  const withdrawEvents = partnerEvents.filter((e) => e.type === 'WITHDRAWAL');
  const withdrawClaims = claim(anchorsOf(isWithdrawCall, () => false), withdrawEvents);
  for (const ev of partnerEvents) {
    if (['FUNDING', 'WITHDRAWAL', 'CHARGE'].includes(ev.type)) {
      const tooOld = T(ev.at) < journalFrom;
      const anchor = ev.type === 'FUNDING' ? fundClaims.get(ev) : ev.type === 'WITHDRAWAL' ? withdrawClaims.get(ev) : null;
      const afterDecline = declines.some((d) => T(d.occurred_at || d.created_at) <= T(ev.at) && T(ev.at) - T(d.occurred_at || d.created_at) <= WINDOW_MS);
      if (anchor) {
        const c = anchor.call;
        const several = anchor.events.length > 1;
        const total = round2(anchor.events.reduce((t, x) => t + Number(x.amount || 0), 0));
        ev.verdict = { kind: 'requested', text: `Le marchand a fait cette requête : ${c ? `${c.method} ${c.route || c.path} (id ${c.request_id || '-'}, terminée à ${new Date(c.at).toISOString().slice(11, 19)})` : 'un débit du Master Wallet correspond'}${anchor.ledger ? `, Master Wallet débité de ${Math.abs(anchor.ledger.amount)} $ à ${new Date(anchor.ledger.at).toISOString().slice(11, 19)}` : ''}.${several ? ` ATTENTION : le fournisseur a enregistré ${anchor.events.length} écritures pour cette seule requête (${anchor.events.map((x) => `${Number(x.amount).toFixed(2)} $`).join(' + ')} = ${total} $) : la 2e écriture n'a pas été demandée séparément par le marchand, elle vient du fournisseur.` : ''}` };
      } else if (tooOld) {
        ev.verdict = { kind: 'unknown', text: `Journal API trop ancien (${JOURNAL_DAYS} jours) pour vérifier.` };
      } else if (ev.type !== 'FUNDING' && ev.amount != null && ev.amount <= 1 && afterDecline) {
        ev.verdict = { kind: 'provider_fee', text: "Frais appliqués par le fournisseur juste après un refus de transaction : aucune requête du marchand, ce n'est pas lui." };
      } else {
        ev.verdict = { kind: 'not_requested', text: `Aucune requête du marchand ne correspond à cette opération (ni appel API, ni débit du Master Wallet de ce montant, dans les ${WINDOW_MS / 60000} minutes autour de cette heure) : elle ne vient pas d'un appel visible de son côté.` };
      }
    }
    events.push(ev);
  }
  events.sort((a, b) => T(a.at) - T(b.at));
  return {
    card: { id: card.id, own_reference: card.own_reference, last4: card.masked_pan ? String(card.masked_pan).slice(-4) : null, status: card.status, mode: card.mode, balance: round2(card.balance), created_at: card.created_at, merchant_id: card.merchant_id, merchant_name: merchant ? merchant.business_name : null },
    journal_days: JOURNAL_DAYS, api_calls_found: calls.length, events,
    summary: {
      requested: events.filter((e) => e.verdict && e.verdict.kind === 'requested').length,
      not_requested: events.filter((e) => e.verdict && e.verdict.kind === 'not_requested').length,
      provider_fees: events.filter((e) => e.verdict && e.verdict.kind === 'provider_fee').length,
    },
  };
}

module.exports = { trace };
