#!/usr/bin/env node
// Stockholm local time for the missing-report alarm, across the DST change.
//   node scripts/clock_test.mjs
import { _test } from '../src/worker.js';
const { stockholmClock } = _test;
let pass = 0, fail = 0;
const t = (name, iso, date, hhmm) => {
  const c = stockholmClock(Date.parse(iso));
  const got = `${c.date} ${String(Math.floor(c.minutes / 60)).padStart(2, '0')}:${String(c.minutes % 60).padStart(2, '0')}`;
  if (got === `${date} ${hhmm}`) { pass++; console.log(`  ok    ${name} (${got})`); }
  else { fail++; console.log(`  FAIL  ${name}: expected ${date} ${hhmm}, got ${got}`); }
};
t('summer time (CEST, UTC+2)', '2026-10-01T04:30:00Z', '2026-10-01', '06:30');
t('last CEST morning', '2026-10-24T04:30:00Z', '2026-10-24', '06:30');
t('first CET morning (UTC+1)', '2026-10-26T05:30:00Z', '2026-10-26', '06:30');
t('CET at 04:30 UTC is still 05:30', '2026-10-26T04:30:00Z', '2026-10-26', '05:30');
t('date rolls at local midnight', '2026-10-01T22:15:00Z', '2026-10-02', '00:15');
t('spring change (CEST from 29 Mar 2027)', '2027-03-29T04:30:00Z', '2027-03-29', '06:30');
console.log(`\nclock_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
