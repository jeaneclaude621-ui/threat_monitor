#!/usr/bin/env node
// The morning report is started again when it has not come (Version 3.25):
// at 05:30 and 07:00 Stockholm time, at most twice, never while a run goes.
//   node scripts/retry_test.mjs
import { _test } from '../src/worker.js';
const { retryMissingReport, startDueRuns, lastDueMs } = _test;

let pass = 0, fail = 0;
const expect = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
};

function makeEnv({ report = false, running = false } = {}) {
  const meta = new Map(); const dispatched = []; const audits = [];
  const DB = {
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { args = a; return st; },
        async first() {
          if (sql.includes('FROM reports')) return report ? { ok: 1 } : null;
          if (sql.includes("key = 'report_retries'")) return meta.has('report_retries') ? { value: meta.get('report_retries') } : null;
          if (sql.includes('FROM runs')) return running ? { started_at: new Date().toISOString() } : null;
          return null;
        },
        async run() {
          if (sql.startsWith('INSERT INTO meta')) meta.set(args[0], args[1]);
          if (sql.startsWith('INSERT INTO audit_log')) audits.push(args);
          return {};
        },
      };
      return st;
    },
  };
  globalThis.fetch = async (url, init) => { dispatched.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); };
  return { env: { DB, GITHUB_REPO: 'o/r', GITHUB_DISPATCH_TOKEN: 't' }, dispatched, meta };
}

// 6 Nov 2026 is CET (UTC+1): 04:30Z is 05:30 in Stockholm.
const at = (hhmmZ) => Date.parse(`2026-11-06T${hhmmZ}:00Z`);

let e = makeEnv();
expect('05:00 is too early', (await retryMissingReport(e.env, at('04:00'))).retried, false);
expect('05:30 without a report: first retry', (await retryMissingReport(e.env, at('04:30'))).attempt, 1);
expect('the dispatch has no "at"', e.dispatched[0], { ref: 'main', inputs: { job: 'daily', test: 'false', at: '' } });
expect('06:00: no second retry yet', (await retryMissingReport(e.env, at('05:00'))).retried, false);
expect('07:00: second retry', (await retryMissingReport(e.env, at('06:00'))).attempt, 2);
expect('07:30: never a third', (await retryMissingReport(e.env, at('06:30'))).retried, false);
expect('two dispatches in all', e.dispatched.length, 2);

e = makeEnv({ report: true });
expect('report here: no retry', (await retryMissingReport(e.env, at('04:30'))).reason, 'report here');

e = makeEnv({ running: true });
expect('a run still going: no retry', (await retryMissingReport(e.env, at('04:30'))).reason, 'a run is still going');

// Version 3.26: Narrativ starts at half past, the others on the hour.
e = makeEnv();
await startDueRuns(e.env, at('07:00'));   // 08:00 Stockholm
expect('08:00: no Narrativ', e.dispatched.length, 0);
await startDueRuns(e.env, at('07:30'));   // 08:30
expect('08:30: Narrativ', e.dispatched.map((d) => d.inputs.at), ['8']);
e = makeEnv();
await startDueRuns(e.env, at('11:00'));   // 12:00: the thread check, not Narrativ
expect('12:00: only the thread check', e.dispatched.map((d) => d.inputs.job), ['hourly']);
await startDueRuns(e.env, at('11:30'));
expect('12:30: Narrativ', e.dispatched.length, 2);
expect('due time counts the half hour', new Date(lastDueMs([8], at('07:45'), 30)).toISOString().slice(11, 16), '07:30');

console.log(`\nretry_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
