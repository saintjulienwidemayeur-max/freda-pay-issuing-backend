'use strict';

/** Everything people read on the platform is in Haiti time (America/Port-au-Prince, which follows daylight saving). */
const TZ = 'America/Port-au-Prince';
const dateFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function parts(date) {
  const o = {};
  for (const p of dateFmt.formatToParts(date)) o[p.type] = p.value;
  return o;
}

/** "18/10/2026 17:44:00" in Haiti time, or "-" for a missing/invalid date. */
function format(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = parts(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/** The calendar day (YYYY-MM-DD) in Haiti of a timestamp. */
function day(t) {
  const p = parts(new Date(t));
  return `${p.year}-${p.month}-${p.day}`;
}

module.exports = { TZ, format, day };
