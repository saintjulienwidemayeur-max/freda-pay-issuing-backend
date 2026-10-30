'use strict';

/** A partner's own name is never shown to a merchant: movements it makes itself (recharge, withdrawal, fees) carry it as the "merchant". */
function publicMerchantName(name) {
  const n = String(name == null ? '' : name).trim();
  return !n || /maplerad|tranzak|plopplop/i.test(n) ? null : n;
}

module.exports = { publicMerchantName };
