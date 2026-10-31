'use strict';

/**
 * A timestamp from a partner, as an ISO string the database accepts. The card partner is written in Go and sometimes sends Go's own
 * time.String() format, e.g. "2026-10-30 17:39:24.664538266 +0000 UTC m=+367625.837597389" (nanoseconds, a zone name and a monotonic clock
 * suffix), which Postgres refuses ("invalid input syntax for type timestamp with time zone"): the notification then failed with a 500 and the
 * purchase was never recorded. ISO strings, Dates and numbers pass through; anything unreadable becomes `fallback` (now by default).
 */
function toIso(value, fallback) {
  const fb = fallback === undefined ? new Date().toISOString() : fallback;
  if (value == null || value === '') return fb;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fb : value.toISOString();
  if (typeof value === 'number') { const d = new Date(value < 1e12 ? value * 1000 : value); return Number.isNaN(d.getTime()) ? fb : d.toISOString(); }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = new Date(s); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(s);
  if (m) {
    const ms = (m[7] || '0').padEnd(3, '0').slice(0, 3);
    let tz = m[8] || 'Z';
    if (tz !== 'Z' && !tz.includes(':')) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}${tz}`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const loose = new Date(s);
  return Number.isNaN(loose.getTime()) ? fb : loose.toISOString();
}

module.exports = { toIso };
