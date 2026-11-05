#!/usr/bin/env node
'use strict';
/**
 * CLI for cryptoWallet.replayMissedDeposits() (same function the admin endpoint POST /admin/crypto/deposits/replay
 * uses) - re-checks deposit notifications already stored in webhook_events against the current address records,
 * for deposits missed the first time (e.g. the EVM address case-sensitivity bug: an address stored in one case
 * never matched a notification reporting it in another, so nothing was ever written, not even a 'review' row).
 * Safe to run more than once: an already-credited deposit is reported as skipped, never credited twice.
 *
 * Run on the server that has SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (e.g. via a hosting shell):
 *   node scripts/replay-crypto-deposit.js --address=0x4540c69b4D42d190C99AfCE5a0aa4912BEB6acb6
 *   node scripts/replay-crypto-deposit.js --reference=<provider_reference or tx_hash>
 *   node scripts/replay-crypto-deposit.js --all          (checks every stored deposit notification, not just one merchant)
 */
const cryptoWallet = require('../src/services/cryptoWallet');

function arg(name) {
  const pfx = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(pfx));
  return found ? found.slice(pfx.length) : null;
}

async function main() {
  const address = arg('address');
  const reference = arg('reference');
  const all = process.argv.includes('--all');
  const mode = arg('mode') || 'live';
  if (!address && !reference && !all) {
    console.error('Usage: node scripts/replay-crypto-deposit.js --address=0x... [--mode=live]');
    console.error('   or: node scripts/replay-crypto-deposit.js --reference=<provider_reference or tx_hash> [--mode=live]');
    console.error('   or: node scripts/replay-crypto-deposit.js --all [--mode=live]');
    process.exit(1);
  }

  const { checked, credited, still_missing: stillMissing, results } = await cryptoWallet.replayMissedDeposits({ address, reference, all, mode });
  if (!results.length) {
    console.log('No stored Maplerad webhook event matches that address/reference. Nothing to replay.');
    return;
  }
  for (const r of results) {
    if (r.outcome === 'already_recorded' && all) continue; // the normal case once the fix is deployed: skip quietly in --all mode
    console.log(`\nwebhook_event_id=${r.webhook_event_id}  at=${r.at}  amount=${r.amount}  reference=${r.reference}`);
    if (r.outcome === 'already_recorded') console.log(`  -> already in crypto_deposits (status=${r.status}, credited_usd=${r.credited_usd}). Skipped.`);
    else if (r.outcome === 'credited') console.log(`  -> CREDITED: crypto_deposits.id=${r.crypto_deposit_id}, status=${r.status}, credited_usd=${r.credited_usd}`);
    else if (r.outcome === 'error') console.log(`  -> ERROR: ${r.message}`);
    else console.log('  -> still not credited (address unknown, wrong mode, amount out of bounds, or not a successful deposit). Check crypto_addresses for this merchant.');
  }
  if (all) console.log(`\n${checked} checked, ${credited} newly credited, ${stillMissing} still need manual investigation.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
