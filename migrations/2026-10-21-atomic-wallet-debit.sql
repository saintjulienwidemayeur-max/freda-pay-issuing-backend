-- Atomic Master Wallet debit with a minimum-balance floor.
-- The backend calls this through POST /rest/v1/rpc/debit_master_wallet. The balance check and the ledger insert run in
-- one transaction under a per-wallet advisory lock, so parallel requests (even on several backend instances) can never
-- take the wallet under the floor. Until this is installed the backend falls back to a per-instance lock plus a re-check.
create or replace function debit_master_wallet(
  p_merchant_id text,
  p_wallet text,
  p_amount numeric,
  p_minimum numeric,
  p_reference text,
  p_related_id text
)
returns jsonb
language plpgsql
as $$
declare
  v_balance numeric;
begin
  perform pg_advisory_xact_lock(hashtext('ledger:' || p_merchant_id || ':' || p_wallet));
  select coalesce(sum(amount), 0) into v_balance
    from ledger_entries
    where merchant_id = p_merchant_id and wallet = p_wallet and currency = 'USD';
  if round(v_balance - abs(p_amount), 2) < p_minimum then
    return jsonb_build_object('ok', false, 'balance', v_balance);
  end if;
  insert into ledger_entries (merchant_id, wallet, type, amount, currency, reference, related_id)
    values (p_merchant_id, p_wallet, 'wallet_debit', -abs(p_amount), 'USD', p_reference, p_related_id);
  return jsonb_build_object('ok', true, 'balance', v_balance - abs(p_amount));
end;
$$;
