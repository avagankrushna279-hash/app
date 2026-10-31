'use strict';
const { Pool } = require('pg');
let pool;
function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const ssl = process.env.DATABASE_SSL === '1' || /supabase\.(co|com)|neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined;
    pool = new Pool({ connectionString: url, ssl, max: Number(process.env.DB_POOL || 10) });
  }
  return pool;
}
const q = (text, params) => getPool().query(text, params);
const one = async (t, p) => (await q(t, p)).rows[0] || null;
const all = async (t, p) => (await q(t, p)).rows;
async function tx(fn) {
  const c = await getPool().connect();
  try { await c.query('begin'); const r = await fn((t, p) => c.query(t, p)); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { c.release(); }
}
async function close() { if (pool) { const p = pool; pool = null; await p.end(); } }
async function migrate() {
  const fs = require('fs'), path = require('path');
  await q('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.join(__dirname, '..', 'db');
  const done = new Set((await all('select name from schema_migrations')).map((r) => r.name));
  const ran = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await tx(async (run) => { await run(fs.readFileSync(path.join(dir, f), 'utf8')); await run('insert into schema_migrations (name) values ($1)', [f]); });
    ran.push(f);
  }
  return ran;
}
module.exports = { q, one, all, tx, close, migrate };
