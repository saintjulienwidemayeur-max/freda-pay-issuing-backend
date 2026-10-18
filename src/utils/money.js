'use strict';

/**
 * Strict reading of a money amount that comes from a request. Only a real JSON number is accepted (a string such as
 * "100" is refused: it would turn into a concatenation further down), it must be finite, positive, within a sane
 * ceiling and have at most two decimals, so the same value is used everywhere (ledger, provider, fees).
 * Throws a 400 with a French message; returns the number.
 */
function parseAmount(value, opts) {
  const o = opts || {};
  const field = o.field || 'amount';
  const max = o.max || 1e7;
  const fail = (message) => {
    const err = new Error(message);
    err.httpStatus = 400;
    err.code = 'INVALID_AMOUNT';
    return err;
  };
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw fail(`${field} doit être un nombre positif.`);
  }
  if (value > max) throw fail(`${field} est trop élevé (maximum ${max}).`);
  if (Math.round(value * 100) / 100 !== value) throw fail(`${field} ne peut pas avoir plus de deux décimales.`);
  return value;
}

module.exports = { parseAmount };
