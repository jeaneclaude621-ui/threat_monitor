import { DatabaseSync } from 'node:sqlite';
// Version 3.46: every migration applies, in order, to an empty database
// through the Worker's own applyMigrations, and a second run applies none.
const { _test } = await import(new URL('../src/worker.js', import.meta.url));
const sq = new DatabaseSync(':memory:');
sq.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
const D1 = { prepare(sql) { let a = []; const st = { bind(...x) { a = x; return st; }, _x() { sq.prepare(sql).run(...a); },
  async all() { return { results: sq.prepare(sql).all(...a) }; } }; return st; },
  async batch(list) { sq.exec('BEGIN'); try { for (const s of list) s._x(); sq.exec('COMMIT'); } catch (e) { sq.exec('ROLLBACK'); throw e; } } };
const fail = (m) => { console.error(`migrate_test: ${m}`); process.exit(1); };
let r = await _test.applyMigrations({ DB: D1 });
const first = await r.json();
if (r.status !== 200 || first.applied.length !== first.total) fail(`first run: ${JSON.stringify(first)}`);
r = await _test.applyMigrations({ DB: D1 });
const again = await r.json();
if (again.applied.length) fail(`second run applied ${again.applied}`);
const triggers = sq.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger'").get().n;
if (triggers < 4) fail(`only ${triggers} triggers`);
console.log(`migrate_test: ${first.total} migrations applied to an empty database, ${triggers} triggers; a second run applies none`);
