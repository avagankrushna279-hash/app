'use strict';
// AI Receptionist: serves the app, the API and the WhatsApp webhook. Node 18+, one dependency (pg).
const http = require('http'), fs = require('fs'), path = require('path');
require('./lib/env').loadEnv();
const db = require('./src/db');
const { verify } = require('./src/auth');
const { routes } = require('./src/routes');
const wa = require('./src/whatsapp');
const { handleIncoming } = require('./src/flow');

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
const hits = new Map();
const pending = new Set();
const compiled = routes.map(([method, pattern, access, handler]) => ({ method, access, handler, re: new RegExp('^' + pattern.replace(/:[a-z]+/g, '([^/]+)') + '$'), keys: (pattern.match(/:[a-z]+/g) || []).map((k) => k.slice(1)) }));

function limited(ip) {
  const now = Date.now(), max = Number(process.env.LLM_PER_MINUTE || 20), list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now); hits.set(ip, list); return list.length > max;
}
const readRaw = (req, max) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const parseJson = (buf) => { try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch (e) { throw Object.assign(new Error('Body is not valid JSON'), { status: 400 }); } };
const AI_PATHS = /^\/api\/(studio\/draft|gbp\/advise)$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress || 'x';
  const cors = { 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
  const send = (code, data) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    if (url.pathname === '/api/health') { await db.q('select 1'); return send(200, { ok: true, llm: process.env.MOCK_LLM === '1' ? 'mock' : process.env.ANTHROPIC_API_KEY ? 'live' : 'off', whatsapp: process.env.WHATSAPP_MODE === 'mock' ? 'mock' : process.env.WHATSAPP_TOKEN ? 'live' : 'off' }); }

    if (url.pathname === '/webhook/whatsapp') {
      if (req.method === 'GET') {
        const ok = url.searchParams.get('hub.mode') === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && url.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
        res.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' }); return res.end(ok ? url.searchParams.get('hub.challenge') : 'Forbidden');
      }
      if (req.method === 'POST') {
        const raw = await readRaw(req, 1024 * 1024);
        if (!wa.verifySignature(raw, req.headers['x-hub-signature-256'])) { res.writeHead(401); return res.end('Bad signature'); }
        const body = parseJson(raw);
        res.writeHead(200); res.end('ok');   // answer fast, work afterwards
        const job = (async () => { for (const m of wa.parsePayload(body)) { try { await handleIncoming(m); } catch (e) { console.error('Message failed:', e.message); } } })();
        pending.add(job); job.finally(() => pending.delete(job));
        return;
      }
    }

    if (url.pathname.startsWith('/api/')) {
      const r = compiled.map((c) => ({ c, m: c.method === req.method ? c.re.exec(url.pathname) : null })).find((x) => x.m);
      if (!r) return send(404, { error: 'Not found' });
      const { c, m } = r;
      let user = null;
      if (c.access !== 'public') {
        const h = req.headers.authorization || '';
        user = verify(h.startsWith('Bearer ') ? h.slice(7) : '');
        if (!user) return send(401, { error: 'Please sign in again' });
      }
      if (c.access === 'admin' && user.role !== 'admin') return send(403, { error: 'Admins only' });
      let cid = null;
      if (c.access === 'owner') {
        cid = user.role === 'owner' ? user.cid : url.searchParams.get('client');
        if (!cid) return send(400, { error: 'Choose a client first' });
      }
      if (AI_PATHS.test(url.pathname) && limited(ip)) return send(429, { error: 'Too many requests. Wait a minute.' });
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? parseJson(await readRaw(req, 200 * 1024)) : {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && (body === null || typeof body !== 'object' || Array.isArray(body))) return send(400, { error: 'Body must be a JSON object' });
      const params = Object.fromEntries(c.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return send(200, await c.handler({ req, ip, user, cid, params, query: Object.fromEntries(url.searchParams), body }));
    }

    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(buf);
    });
  } catch (e) {
    const status = e.status || (e.code === '23505' ? 409 : 500);
    if (status === 500) console.error(e.stack || e.message);
    if (!res.headersSent) send(status, { error: status === 500 ? 'Server error' : e.code === '23505' ? 'That already exists' : e.message });
  }
});

// Creates the first admin login from ADMIN_EMAIL and ADMIN_PASSWORD, so no command line is needed on a host.
// It only creates the account if it does not exist; it never overwrites a password you changed later.
async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  if (!email || !pw) return;
  if (pw.length < 8) return console.error('ADMIN_PASSWORD must be at least 8 characters, so no admin was created.');
  const r = await db.q("insert into app_users (email, password_hash, role) values ($1, $2, 'admin') on conflict (email) do nothing", [email, require('./src/auth').hashPassword(pw)]);
  if (r.rowCount) console.log('Admin account created for ' + email);
}

const whenIdle = async () => { while (pending.size) await Promise.allSettled([...pending]); };

if (require.main === module) {
  (async () => {
    for (const k of ['DATABASE_URL', 'APP_SECRET']) if (!process.env[k]) { console.error('Missing ' + k + '. Copy .env.example to .env and fill it in.'); process.exit(1); }
    const ran = await db.migrate();
    if (ran.length) console.log('Database updated:', ran.join(', '));
    await bootstrapAdmin();
    if (process.env.REMINDER_TEMPLATE) require('./src/reminders').start();
    const port = Number(process.env.PORT || 8787);
    server.listen(port, '0.0.0.0', () => console.log('AI Receptionist running on http://localhost:' + port + '\nAI: ' + (process.env.MOCK_LLM === '1' ? 'mock' : process.env.ANTHROPIC_API_KEY ? 'live' : 'OFF (set ANTHROPIC_API_KEY)') + ' | WhatsApp: ' + (process.env.WHATSAPP_MODE === 'mock' ? 'mock' : process.env.WHATSAPP_TOKEN ? 'live' : 'OFF (set WHATSAPP_TOKEN)')));
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { server, whenIdle, bootstrapAdmin };
