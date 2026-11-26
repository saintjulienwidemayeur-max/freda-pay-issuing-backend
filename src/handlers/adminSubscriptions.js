'use strict';
const supabase = require('../lib/supabase');
const ledger = require('../services/ledger');
const planRenewals = require('../services/planRenewals');
const config = require('../config');

/**
 * Admin "Abonnements": every merchant on a paid LIVE plan (Gateway or Issuing), what it costs, when it renews, whether it is paid, in debt or overdue,
 * and the buttons to take the subscriptions that are due without waiting for the hourly pass.
 */
const LABELS = { gateway: 'Gateway', issuing: 'Issuing' };

async function list() {
  const merchants = await supabase.select('merchants', { deleted_at: supabase.isNull() }, { limit: 5000 });
  const now = Date.now();
  const rows = [];
  for (const m of merchants) {
    for (const product of Object.keys(planRenewals.PRODUCTS)) {
      const P = planRenewals.PRODUCTS[product];
      const plan = m[P.plan] || P.entry;
      const price = planRenewals.monthlyPriceUsd(product, plan);
      if (price <= 0) continue;
      const cfg = P.plans()[plan];
      const renews = m[P.renews] || null;
      rows.push({ merchant_id: m.id, business_name: m.business_name, email: m.email, product, product_label: LABELS[product], plan, plan_label: cfg && cfg.label, price_usd: price, renews_at: renews, unpaid_since: m[P.unpaid] || null, _m: m });
    }
  }
  const balances = await Promise.all(rows.map((r) => ledger.getBalance(r.merchant_id, 'master_wallet', 'USD', 'live')));
  let overdue = 0; let inDebt = 0; let mrr = 0;
  const out = rows.map((r, i) => {
    const balance = balances[i];
    const due = r.renews_at && new Date(r.renews_at).getTime() <= now;
    let status = 'ok';
    if (r.unpaid_since) status = planRenewals.isBlocked(r._m, r.product) ? 'blocked' : 'unpaid';
    else if (due) status = 'due';
    else if (!r.renews_at) status = 'unscheduled';
    if (status === 'due' || status === 'unpaid' || status === 'blocked') overdue += 1;
    if (balance < 0) inDebt += 1;
    mrr += r.price_usd;
    const { _m, ...pub } = r; // eslint-disable-line no-unused-vars
    return Object.assign(pub, { master_wallet_usd: Math.round(balance * 100) / 100, in_debt: balance < 0, status });
  }).sort((a, b) => (a.renews_at || '9').localeCompare(b.renews_at || '9'));
  return { status: 200, body: { subscriptions: out, summary: { count: out.length, monthly_usd: Math.round(mrr * 100) / 100, overdue, in_debt: inDebt, grace_days: config.billing.graceDays } } };
}

/** The button "Prélever tous les abonnements échus": the same pass the server runs every hour. */
async function runAll(ctx) {
  const done = await planRenewals.run();
  console.log(`Subscriptions run by ${(ctx.admin && ctx.admin.email) || ctx.adminId}: ${JSON.stringify(done)}`); // eslint-disable-line no-console
  return { status: 200, body: done };
}

const MESSAGES = {
  renewed: 'Abonnement prélevé.',
  'not-due': "Pas encore échu : rien n'a été prélevé.",
  scheduled: 'Cycle démarré (aucun prélèvement).',
  free: 'Plan gratuit : rien à prélever.',
  'unpaid-warned': 'Solde déjà négatif : le marchand a été averti, nouvel essai automatique chaque heure.',
  'unpaid-waiting': 'Solde déjà négatif : en attente de dépôt (délai de grâce en cours).',
  blocked: 'Solde toujours négatif après le délai de grâce : l\'API du marchand est bloquée jusqu\'au paiement.',
};

async function chargeOne(ctx) {
  const result = await planRenewals.renewMerchant(ctx.params.id, ctx.params.product);
  return { status: 200, body: { result, message: MESSAGES[result] || result } };
}

module.exports = { list, runAll, chargeOne };
