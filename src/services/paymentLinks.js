'use strict';
const supabase = require('../lib/supabase');

async function create({ id, merchantId, amount, currency, description, mode }) {
  return supabase.insert('payment_links', {
    id,
    merchant_id: merchantId,
    amount: amount != null ? amount : null,
    currency: currency || 'HTG',
    description: description || null,
    status: 'active',
    mode: mode || 'sandbox',
  });
}

async function list(merchantId, limit, offset, mode) {
  const filters = { merchant_id: merchantId };
  if (mode) filters.mode = mode;
  return supabase.select('payment_links', filters, { order: 'created_at.desc', limit: limit || 50, offset: offset || 0 });
}

async function getById(id) {
  return supabase.selectOne('payment_links', { id });
}

async function getByIdForMerchant(merchantId, id) {
  return supabase.selectOne('payment_links', { id, merchant_id: merchantId });
}

async function disable(merchantId, id) {
  const rows = await supabase.update('payment_links', { id, merchant_id: merchantId }, { status: 'disabled' });
  return rows && rows[0];
}

module.exports = { create, list, getById, getByIdForMerchant, disable };
