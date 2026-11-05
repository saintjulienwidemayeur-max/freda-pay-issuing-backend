#!/usr/bin/env node
'use strict';
/**
 * Re-runs applyDepositEvent() against a Maplerad crypto deposit webhook already stored in webhook_events,
 * for deposits that were missed because the deposit address didn't match (e.g. the case-sensitivity bug fixed
 * alongside this script: an EVM address stored in one case never matched a notification reporting it in another).
 * Safe to re-run: applyDepositEvent is idempotent on the partner's reference, so an already-credited deposit is
 * left untouched and reported as "already credited" instead of being credited twice.
 *
 * Run on the server that has SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (e.g. via the Render shell):
 *   node scripts/replay-crypto-deposit.js --address=0x4540c69b4D42d190C99AfCE5a0aa4912BEB6acb6
 *   node scripts/replay-crypto-deposit.js --reference=<provider_reference or tx_hash>
 */
const supabase = require('../src/lib/supabase');
const cryptoWallet = require('../src/services/cryptoWallet');

function arg(name) {
  const pfx = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(pfx));
  return found ? found.slice(pfx.length) : null;
}

async function main() {
  const address = arg('address');
  const reference = arg('reference');
  const mode = arg('mode') || 'live';
  if (!address && !reference) {
    console.error('Usage: node scripts/replay-crypto-deposit.js --address=0x... [--mode=live]');
    console.error('   or: node scripts/replay-crypto-deposit.js --reference=<provider_reference or tx_hash> [--mode=live]');
    process.exit(1);
  }
  const normalized = address && /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address;

  const rows = await supabase.select('webhook_events', { provider: 'maplerad' }, { order: 'created_at.desc', limit: 2000 });
  const matches = rows.filter((r) => {
    const dep = cryptoWallet.parseDepositEvent(r.payload || {});
    if (!dep) return false;
    if (address) {
      const depAddr = dep.address && /^0x[0-9a-fA-F]{40}$/.test(dep.address) ? dep.address.toLowerCase() : dep.address;
      return depAddr === normalized;
    }
    return dep.reference === reference || dep.txHash === reference;
  });

  if (!matches.length) {
    console.log('No stored Maplerad webhook event matches that address/reference. Nothing to replay.');
    return;
  }

  for (const r of matches) {
    const dep = cryptoWallet.parseDepositEvent(r.payload || {});
    console.log(`\nwebhook_events.id=${r.id}  at=${r.created_at}  event=${r.event_type}  ok=${dep.ok}  amount=${dep.amount}  reference=${dep.reference}`);
    const existing = await supabase.selectOne('crypto_deposits', { provider_reference: dep.reference }).catch(() => null);
    if (existing) {
      console.log(`  -> already in crypto_deposits (status=${existing.status}, credited_usd=${existing.credited_usd}). Skipped.`);
      continue;
    }
    try {
      const row = await cryptoWallet.applyDepositEvent(r.payload, mode);
      if (row) console.log(`  -> CREDITED: crypto_deposits.id=${row.id}, status=${row.status}, credited_usd=${row.credited_usd}`);
      else console.log('  -> still not credited (address unknown, wrong mode, amount out of bounds, or not a successful deposit). Check crypto_addresses for this merchant.');
    } catch (err) {
      console.log(`  -> ERROR: ${err.message}`);
    }
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
