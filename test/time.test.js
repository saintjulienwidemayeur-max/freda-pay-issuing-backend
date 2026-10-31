'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toIso } = require('../src/utils/time');

test('Go time.String() timestamps from the card partner become ISO strings the database accepts', () => {
  // the exact value that made the notification fail in production
  assert.equal(toIso('2026-10-30 17:39:24.664538266 +0000 UTC m=+367625.837597389'), '2026-10-30T17:39:24.664Z');
  assert.equal(toIso('2026-10-30 17:39:24 +0000 UTC'), '2026-10-30T17:39:24.000Z');
  assert.equal(toIso('2026-10-30 19:39:24.5 +0200 CEST m=+1.2'), '2026-10-30T17:39:24.500Z'); // an offset is honoured
});

test('ISO strings (with nanoseconds or an offset), Dates and numbers pass through; garbage falls back', () => {
  assert.equal(toIso('2026-03-15T05:21:49.464044009Z'), '2026-03-15T05:21:49.464Z');
  assert.equal(toIso('2025-02-27T09:38:07.337488+01:00'), '2025-02-27T08:38:07.337Z');
  assert.equal(toIso(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(toIso(1767323045), '2026-01-02T03:04:05.000Z'); // seconds
  assert.equal(toIso('not a date', 'FALLBACK'), 'FALLBACK');
  assert.equal(toIso(null, null), null);
  assert.match(toIso(undefined), /^\d{4}-\d{2}-\d{2}T/); // now by default
});
