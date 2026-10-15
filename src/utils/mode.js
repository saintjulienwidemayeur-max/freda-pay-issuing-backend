'use strict';
const supabase = require('../lib/supabase');

/**
 * Resolves whether the current request should write/read Sandbox or Live
 * data. For an API-key request, this is simply the key's own mode
 * ('test' keys -> 'sandbox', 'live' keys -> 'live'). For a dashboard
 * (session) request, there's no key - it follows whichever mode the
 * merchant currently has their dashboard switched to (merchants.active_mode).
 */
async function resolveMode(ctx) {
  if (ctx.apiKeyMode) return ctx.apiKeyMode === 'live' ? 'live' : 'sandbox';
  const merchant = ctx.merchant || (await supabase.selectOne('merchants', { id: ctx.merchantId }));
  return (merchant && merchant.active_mode) || 'sandbox';
}

module.exports = { resolveMode };
