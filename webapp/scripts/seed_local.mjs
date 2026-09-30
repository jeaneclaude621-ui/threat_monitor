#!/usr/bin/env node
// Loads every reports/*_report_data.json into the LOCAL D1 through the
// ingest endpoint of a running `wrangler dev` (dev machine header).
// Local testing only: the header is honoured only on localhost with
// DEV_AUTH_MACHINE=1 in .dev.vars.
//
//   node scripts/seed_local.mjs [base_url]     (default http://127.0.0.1:8787)
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const reportsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports');

const files = (await readdir(reportsDir)).filter((f) => f.endsWith('_report_data.json')).sort();
let failed = 0;
for (const f of files) {
  const body = await readFile(join(reportsDir, f), 'utf8');
  const date = JSON.parse(body).date;
  const res = await fetch(`${base}/api/ingest/reports/${date}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Dev-Machine': '1' },
    body,
  });
  const text = await res.text();
  console.log(`${date}: ${res.status} ${text}`);
  if (!res.ok) failed++;
}
console.log(`Seeded ${files.length - failed}/${files.length} reports`);
process.exit(failed ? 1 : 0);
