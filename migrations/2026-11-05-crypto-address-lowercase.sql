-- EVM addresses (Ethereum/Polygon/BSC, 0x...) are case-insensitive on-chain, but the code compared them as literal
-- strings: an address created in one case (e.g. checksummed) never matched a deposit notification reporting the
-- same address in another case, so the deposit was silently dropped before anything was even stored for review.
-- The app now normalizes EVM addresses to lowercase on both creation and lookup; this backfills existing rows so
-- addresses created before the fix keep matching future deposit notifications.
update crypto_addresses
set address = lower(address)
where chain in ('ethereum', 'polygon', 'bsc')
  and address ~ '^0x[0-9a-fA-F]{40}$'
  and address <> lower(address);
