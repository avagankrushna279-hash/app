'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL || 'postgres://root@/postgres?host=/var/run/postgresql';
const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://root@/apptest?host=/var/run/postgresql';
Object.assign(process.env, { DATABASE_URL: DB_URL, APP_SECRET: 'test-secret-test-secret', MOCK_LLM: '1', WHATSAPP_MODE: 'mock', WHATSAPP_VERIFY_TOKEN: 'verify123', WHATSAPP_APP_SECRET: 'appsecret', LOGIN_ATTEMPTS: '100', LLM_PER_MINUTE: '1000' });

const db = require('../src/db');
const wa = require('../src/whatsapp');
const { hashPassword } = require('../src/auth');
const { server, whenIdle } = require('../server');
const { runReminders } = require('../src/reminders');

let base;
const S = {}; // shared state across the ordered tests
test.before(async () => {
  const c = new Client({ connectionString: ADMIN_URL }); await c.connect();
  await c.query('drop database if exists apptest'); await c.query('create database apptest'); await c.end();
  await db.migrate();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); await db.close(); });

async function api(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
let seq = 0;
async function say(numId, phone, text, extra = {}) {
  const msg = { from: phone, id: 'wamid.' + (++seq) + '.' + Date.now(), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra };
  return hook([msg], numId);
}
async function hook(messages, numId, sign = true) {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: numId }, contacts: [{ wa_id: messages[0].from, profile: { name: 'Asha' } }], messages } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(raw).digest('hex');
  const r = await fetch(base + '/webhook/whatsapp', { method: 'POST', headers: sign ? { 'x-hub-signature-256': sig } : {}, body: raw });
  await whenIdle();
  return r.status;
}
const msgs = async (clientId) => (await db.all("select role, body from messages where client_id = $1 order by created_at, id", [clientId]));
const dateInIst = (i) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + i * 864e5)); const g = (t) => p.find((x) => x.type === t).value; return { date: g('year') + '-' + g('month') + '-' + g('day'), dow: g('weekday') }; };
const futureDay = (min, notDow) => { for (let i = min; i < min + 8; i++) { const d = dateInIst(i); if (d.dow !== notDow) return d.date; } };
const sundayDate = () => { for (let i = 2; i < 10; i++) { const d = dateInIst(i); if (d.dow === 'Sun') return d.date; } };

test('migrations are repeatable and the app starts healthy', async () => {
  assert.deepEqual(await db.migrate(), []);
  const h = await api('GET', '/api/health');
  assert.equal(h.status, 200); assert.equal(h.json.llm, 'mock'); assert.equal(h.json.whatsapp, 'mock');
});

test('admin and owner accounts: login, wrong password, protected routes', async () => {
  await db.q("insert into app_users (email, password_hash, role) values ('boss@x.com', $1, 'admin')", [hashPassword('bosspassword')]);
  assert.equal((await api('POST', '/api/login', { email: 'boss@x.com', password: 'nope' })).status, 401);
  assert.equal((await api('POST', '/api/login', { email: 'nobody@x.com', password: 'whatever1' })).status, 401);
  const ok = await api('POST', '/api/login', { email: 'BOSS@x.com', password: 'bosspassword' });
  assert.equal(ok.status, 200); assert.equal(ok.json.user.role, 'admin'); S.admin = ok.json.token;
  assert.equal((await api('GET', '/api/admin/clients')).status, 401);
  assert.equal((await api('GET', '/api/admin/clients', undefined, 'garbage')).status, 401);
  const mk = async (name, num, email) => (await api('POST', '/api/admin/clients', { name, business_type: 'Clinic', plan: 'Starter', wa_number_id: num, owner_email: email, owner_password: 'ownerpass1', owner_whatsapp: '+91 91111 11111' }, S.admin));
  const a = await mk('Clinic A', 'num-A', 'a@x.com'), b = await mk('Salon B', 'num-B', 'b@x.com');
  assert.equal(a.status, 200); assert.equal(b.status, 200); S.A = a.json.id; S.B = b.json.id;
  assert.equal((await mk('Dup', 'num-A', 'c@x.com')).status, 409);
  assert.equal((await api('POST', '/api/admin/clients', { name: 'X', owner_email: 'bad', owner_password: 'ownerpass1' }, S.admin)).status, 400);
  assert.equal((await api('POST', '/api/admin/clients', { name: 'X', owner_email: 'x@x.com', owner_password: 'short' }, S.admin)).status, 400);
  S.ta = (await api('POST', '/api/login', { email: 'a@x.com', password: 'ownerpass1' })).json.token;
  S.tb = (await api('POST', '/api/login', { email: 'b@x.com', password: 'ownerpass1' })).json.token;
  assert.equal((await api('GET', '/api/admin/clients', undefined, S.ta)).status, 403);
  assert.equal((await api('GET', '/api/me', undefined, S.ta)).json.clientName, 'Clinic A');
  assert.equal((await api('GET', '/api/home')).status, 401);
  assert.equal((await api('GET', '/api/home', undefined, S.admin)).status, 400);
  assert.equal((await api('GET', '/api/home?client=' + S.A, undefined, S.admin)).status, 200);
});

test('webhook: verification, signatures and unknown numbers', async () => {
  const v = (t) => fetch(base + '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=' + t + '&hub.challenge=12345');
  const good = await v('verify123'); assert.equal(good.status, 200); assert.equal(await good.text(), '12345');
  assert.equal((await v('wrong')).status, 403);
  wa.sent.length = 0;
  assert.equal(await hook([{ from: '919000000001', id: 'x1', timestamp: '1', type: 'text', text: { body: 'hi' } }], 'num-A', false), 401);
  assert.equal((await db.one('select count(*)::int n from messages')).n, 0);
  assert.equal(await say('num-unknown', '919000000001', 'hello'), 200);
  assert.equal((await db.one('select count(*)::int n from messages')).n, 0);
  assert.equal(wa.sent.length, 0);
});

test('a customer question gets an AI answer, is stored, sent and counted', async () => {
  wa.sent.length = 0;
  await say('num-A', '919000000001', 'How much is cleaning?');
  const m = await msgs(S.A); assert.deepEqual(m.map((x) => x.role), ['customer', 'ai']);
  assert.equal(wa.sent.length, 1); assert.equal(wa.sent[0].to, '919000000001'); assert.equal(wa.sent[0].text, m[1].body);
  assert.equal((await db.one('select messages_count from usage_monthly where client_id = $1', [S.A])).messages_count, 1);
  const home = (await api('GET', '/api/home', undefined, S.ta)).json;
  assert.equal(home.stats.chats_today, 1); assert.equal(home.stats.needs_you, 0); assert.equal(home.client.name, 'Clinic A');
  const chats = (await api('GET', '/api/chats', undefined, S.ta)).json.chats;
  assert.equal(chats.length, 1); assert.equal(chats[0].name, 'Asha'); S.chat1 = chats[0].id;
});

test('the same message delivered twice is only handled once', async () => {
  wa.sent.length = 0;
  const msg = { from: '919000000001', id: 'wamid.same', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'And are you open Saturday?' } };
  await hook([msg], 'num-A'); await hook([msg], 'num-A');
  assert.equal((await msgs(S.A)).length, 4); assert.equal(wa.sent.length, 1);
});

test('a refund request hands over, alerts the owner and silences the AI', async () => {
  wa.sent.length = 0;
  await say('num-A', '919000000002', 'I want a refund');
  const cv = await db.one("select cv.* from conversations cv join customers cu on cu.id = cv.customer_id where cu.phone = '919000000002'");
  assert.equal(cv.status, 'handed_over'); assert.equal(cv.handover_reason, 'customer request'); S.chat2 = cv.id;
  assert.equal(wa.sent.length, 2);
  assert.equal(wa.sent[0].to, '919000000002');
  assert.equal(wa.sent[1].to, '919111111111'); assert.match(wa.sent[1].text, /needs you/);
  assert.equal((await api('GET', '/api/home', undefined, S.ta)).json.stats.needs_you, 1);
  wa.sent.length = 0;
  await say('num-A', '919000000002', 'Hello? Anyone there?');
  assert.equal(wa.sent.length, 0);
  const thread = (await api('GET', '/api/chats/' + S.chat2, undefined, S.ta)).json;
  assert.equal(thread.messages.at(-1).role, 'customer');
});

test('owner replies from the app, then hands the chat back to the AI', async () => {
  wa.sent.length = 0;
  assert.equal((await api('POST', `/api/chats/${S.chat2}/reply`, { text: '  ' }, S.ta)).status, 400);
  const r = await api('POST', `/api/chats/${S.chat2}/reply`, { text: 'Sorry about that, I will look into it today.' }, S.ta);
  assert.equal(r.status, 200); assert.equal(r.json.delivered, true);
  assert.equal(wa.sent[0].to, '919000000002');
  const thread = (await api('GET', '/api/chats/' + S.chat2, undefined, S.ta)).json;
  assert.equal(thread.messages.at(-1).role, 'owner'); assert.equal(thread.chat.status, 'handed_over');
  assert.equal((await api('POST', `/api/chats/${S.chat2}/status`, { status: 'weird' }, S.ta)).status, 400);
  await api('POST', `/api/chats/${S.chat2}/status`, { status: 'ai' }, S.ta);
  wa.sent.length = 0;
  await say('num-A', '919000000002', 'Thanks, what are your timings?');
  assert.equal(wa.sent.length, 1);
  assert.equal((await api('GET', '/api/home', undefined, S.ta)).json.stats.needs_you, 0);
});

test('bookings: hours, services, double-booking, closed times and the past', async () => {
  assert.equal((await api('PUT', '/api/settings', { open_time: '10:00', close_time: '20:00', closed_days: [0], opening_hours: 'Mon-Sat 10am-8pm' }, S.ta)).status, 200);
  assert.equal((await api('POST', '/api/services', { name: 'Cleaning', price: 800, duration_min: 45 }, S.ta)).status, 200);
  const day = futureDay(3, 'Sun'); S.day = day;
  wa.sent.length = 0;
  await say('num-A', '919000000010', `book Cleaning ${day} 11:00 as Asha`);
  assert.match(wa.sent[0].text, /is booked for/);
  const list = (await api('GET', `/api/bookings?from=${day}&days=1`, undefined, S.ta)).json.bookings;
  assert.equal(list.length, 1); assert.equal(list[0].time, '11:00'); assert.equal(list[0].name, 'Asha'); assert.equal(list[0].source, 'ai'); assert.equal(list[0].duration_min, 45); S.bk = list[0].id;
  wa.sent.length = 0;
  await say('num-A', '919000000011', `book Cleaning ${day} 11:30 as Ravi`);
  assert.match(wa.sent[0].text, /already taken/);
  await say('num-A', '919000000012', `book Cleaning ${day} 22:00 as Ravi`);
  assert.match(wa.sent.at(-1).text, /closed at that time/);
  await say('num-A', '919000000013', `book Cleaning ${sundayDate()} 11:00 as Ravi`);
  assert.match(wa.sent.at(-1).text, /closed at that time/);
  await say('num-A', '919000000014', 'book Cleaning 2020-01-01 11:00 as Ravi');
  assert.match(wa.sent.at(-1).text, /already passed/);
  assert.equal((await api('GET', `/api/bookings?from=${day}&days=1`, undefined, S.ta)).json.bookings.length, 1);
});

test('staff can add, conflict-check and cancel bookings', async () => {
  const day = S.day;
  const add = (time, name = 'Walk-in') => api('POST', '/api/bookings', { name, service: 'Consultation', date: day, time, minutes: 30, phone: '+91 98765 43210' }, S.ta);
  assert.equal((await add('14:00')).status, 200);
  assert.equal((await add('14:15')).status, 409);
  assert.equal((await api('POST', '/api/bookings', { name: 'X', service: 'Y', date: 'tomorrow', time: '14:00' }, S.ta)).status, 400);
  assert.equal((await api('POST', '/api/bookings', { name: 'X', service: 'Y', date: day, time: '25:00' }, S.ta)).status, 400);
  const all = (await api('GET', `/api/bookings?from=${day}&days=1`, undefined, S.ta)).json.bookings;
  const staff = all.find((b) => b.source === 'staff'); assert.equal(staff.time, '14:00');
  assert.equal((await api('POST', `/api/bookings/${staff.id}/status`, { status: 'cancelled' }, S.ta)).status, 200);
  assert.equal((await add('14:15')).status, 200);
});

test('one business can never see or change another business\'s data', async () => {
  assert.deepEqual((await api('GET', '/api/chats', undefined, S.tb)).json.chats, []);
  assert.equal((await api('GET', '/api/chats/' + S.chat1, undefined, S.tb)).status, 404);
  assert.equal((await api('POST', `/api/chats/${S.chat1}/reply`, { text: 'hi' }, S.tb)).status, 404);
  assert.equal((await api('POST', `/api/chats/${S.chat1}/status`, { status: 'closed' }, S.tb)).status, 404);
  assert.equal((await api('GET', `/api/bookings?from=${S.day}&days=1`, undefined, S.tb)).json.bookings.length, 0);
  assert.equal((await api('POST', `/api/bookings/${S.bk}/status`, { status: 'cancelled' }, S.tb)).status, 404);
  const svc = (await api('GET', '/api/knowledge', undefined, S.ta)).json.services[0];
  await api('DELETE', '/api/services/' + svc.id, undefined, S.tb);
  assert.equal((await api('GET', '/api/knowledge', undefined, S.ta)).json.services.length, 1);
  assert.equal((await api('GET', '/api/chats/not-a-uuid', undefined, S.ta)).status, 404);
  assert.equal((await api('GET', '/api/knowledge', undefined, S.tb)).json.services.length, 0);
  assert.equal((await api('GET', '/api/home?client=' + S.B, undefined, S.ta)).json.client.name, 'Clinic A');
});

test('settings, rules, services and questions validate and persist', async () => {
  assert.equal((await api('PUT', '/api/settings', { open_time: '9am' }, S.ta)).status, 400);
  assert.equal((await api('PUT', '/api/settings', { timezone: 'Mars/Base' }, S.ta)).status, 400);
  assert.equal((await api('PUT', '/api/settings', { tone: 'Rude' }, S.ta)).status, 400);
  assert.equal((await api('PUT', '/api/settings', { name: '  ' }, S.ta)).status, 400);
  const s = await api('PUT', '/api/settings', { tone: 'Formal', languages: ['English', 'Hindi'], city: 'Thane', owner_whatsapp: '+91 90000 11111' }, S.ta);
  assert.equal(s.json.settings.tone, 'Formal'); assert.deepEqual(s.json.settings.languages, ['English', 'Hindi']); assert.equal(s.json.settings.owner_whatsapp, '+919000011111');
  assert.equal((await api('GET', '/api/rules', undefined, S.ta)).json.rules.upset, true);
  assert.equal((await api('PUT', '/api/rules', { upset: false, asks_person: true }, S.ta)).json.rules.upset, false);
  assert.equal((await api('POST', '/api/services', { name: '' }, S.ta)).status, 400);
  assert.equal((await api('POST', '/api/services', { name: 'X', price: 'abc' }, S.ta)).status, 400);
  assert.equal((await api('POST', '/api/faqs', { question: 'Where?', answer: 'Thane West' }, S.ta)).status, 200);
  assert.equal((await api('POST', '/api/faqs', { question: 'Where?' }, S.ta)).status, 400);
  const k = (await api('GET', '/api/knowledge', undefined, S.ta)).json;
  assert.equal(k.faqs.length, 1); await api('DELETE', '/api/faqs/' + k.faqs[0].id, undefined, S.ta);
  assert.equal((await api('GET', '/api/knowledge', undefined, S.ta)).json.faqs.length, 0);
});

test('the weekly report adds up', async () => {
  const r = (await api('GET', '/api/report', undefined, S.ta)).json;
  assert.equal(r.days.length, 7); assert.ok(r.helped >= 3); assert.ok(r.bookings >= 2); assert.equal(typeof r.after_hours, 'number');
  assert.equal(r.days.at(-1).chats > 0, true);
});

test('Google profile: save, audit, AI advice, history', async () => {
  assert.equal((await api('POST', '/api/gbp/audit', {}, S.ta)).status, 400);
  const sample = (await api('GET', '/api/gbp/sample', undefined, S.ta)).json;
  assert.equal((await api('PUT', '/api/gbp', { profile: 'text' }, S.ta)).status, 400);
  assert.equal((await api('PUT', '/api/gbp', { profile: sample.profile, metrics: sample.metrics }, S.ta)).status, 200);
  const a = await api('POST', '/api/gbp/audit', {}, S.ta); assert.ok(a.json.audit.score < 45);
  const adv = await api('POST', '/api/gbp/advise', {}, S.ta); assert.ok(adv.json.advice.priorities.length > 0);
  const g = (await api('GET', '/api/gbp', undefined, S.ta)).json;
  assert.equal(g.saved.profile.name, 'Sample Dental Clinic'); assert.ok(g.latest.advice.summary); assert.equal((await api('GET', '/api/gbp', undefined, S.tb)).json.saved, null);
});

test('Studio: AI drafts and the saved content plan', async () => {
  const d = await api('POST', '/api/studio/draft', { type: 'post', topic: 'Free check-up week', kind: 'offer' }, S.ta);
  assert.match(d.json.result.body, /Free check-up week/);
  assert.equal((await api('POST', '/api/studio/draft', { type: 'social', goal: 'More bookings', format: 'reel' }, S.ta)).json.result.scenes.length, 3);
  assert.equal((await api('POST', '/api/studio/draft', { type: 'review', review: { rating: 1, text: 'Rude staff' } }, S.ta)).json.result.needs_owner, true);
  assert.equal((await api('POST', '/api/studio/draft', { type: 'post' }, S.ta)).status, 400);
  assert.equal((await api('POST', '/api/studio/draft', { type: 'nope' }, S.ta)).status, 400);
  const c = await api('POST', '/api/creatives', { kind: 'post', headline: 'Check-up week', caption: d.json.result.body }, S.ta); assert.equal(c.status, 200);
  assert.equal((await api('POST', '/api/creatives', { kind: 'video', headline: 'x' }, S.ta)).status, 400);
  await api('POST', `/api/creatives/${c.json.id}/status`, { status: 'approved' }, S.ta);
  assert.equal((await api('GET', '/api/creatives', undefined, S.ta)).json.creatives[0].status, 'approved');
  assert.equal((await api('GET', '/api/creatives', undefined, S.tb)).json.creatives.length, 0);
  assert.equal((await api('POST', `/api/creatives/${c.json.id}/status`, { status: 'draft' }, S.tb)).status, 404);
  await api('DELETE', '/api/creatives/' + c.json.id, undefined, S.ta);
  assert.equal((await api('GET', '/api/creatives', undefined, S.ta)).json.creatives.length, 0);
});

test('AI switched off, client paused, images, and an unavailable AI all fail safely', async () => {
  wa.sent.length = 0;
  await api('POST', '/api/live', { enabled: false }, S.ta);
  await say('num-A', '919000000020', 'Hello there'); assert.equal(wa.sent.length, 0);
  assert.equal((await db.one("select count(*)::int n from messages m join conversations cv on cv.id = m.conversation_id join customers cu on cu.id = cv.customer_id where cu.phone = '919000000020'")).n, 1);
  await api('POST', '/api/live', { enabled: true }, S.ta);
  await api('PATCH', '/api/admin/clients/' + S.A, { status: 'paused' }, S.admin);
  await say('num-A', '919000000021', 'Hello again'); assert.equal(wa.sent.length, 0);
  await api('PATCH', '/api/admin/clients/' + S.A, { status: 'active' }, S.admin);
  await hook([{ from: '919000000022', id: 'img1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'm1' } }], 'num-A');
  assert.match(wa.sent.at(-1).text, /only read text/);
  process.env.MOCK_LLM = '0'; delete process.env.ANTHROPIC_API_KEY;
  try {
    wa.sent.length = 0; await say('num-A', '919000000023', 'What is the price?');
    const cv = await db.one("select cv.* from conversations cv join customers cu on cu.id = cv.customer_id where cu.phone = '919000000023'");
    assert.equal(cv.status, 'handed_over'); assert.equal(cv.handover_reason, 'ai_unavailable');
    assert.match(wa.sent[0].text, /team will get back/); assert.equal(wa.sent.length, 2);
  } finally { process.env.MOCK_LLM = '1'; }
});

test('several messages in one webhook are processed in order', async () => {
  wa.sent.length = 0;
  const t = String(Math.floor(Date.now() / 1000));
  await hook([{ from: '919000000030', id: 'multi1', timestamp: t, type: 'text', text: { body: 'first question' } }, { from: '919000000030', id: 'multi2', timestamp: t, type: 'text', text: { body: 'second question' } }], 'num-A');
  const rows = await db.all("select m.role, m.body from messages m join conversations cv on cv.id = m.conversation_id join customers cu on cu.id = cv.customer_id where cu.phone = '919000000030' order by m.created_at, m.id");
  assert.deepEqual(rows.map((r) => r.role), ['customer', 'ai', 'customer', 'ai']);
});

test('appointment reminders go out once, only for upcoming bookings', async () => {
  const cu = await db.one("select id, phone from customers where client_id = $1 and phone = '919000000010'", [S.A]);
  await db.q("insert into bookings (client_id, customer_id, customer_name, service, start_at) values ($1, $2, 'Asha', 'Cleaning', now() + interval '5 hours')", [S.A, cu.id]);
  assert.deepEqual(await runReminders(), { skipped: 'REMINDER_TEMPLATE not set' });
  process.env.REMINDER_TEMPLATE = 'appt_reminder'; wa.sent.length = 0;
  try {
    const r = await runReminders(); assert.equal(r.sent, 1);
    assert.equal(wa.sent[0].type, 'template'); assert.equal(wa.sent[0].template.name, 'appt_reminder'); assert.equal(wa.sent[0].template.components[0].parameters[0].text, 'Asha');
    assert.equal((await runReminders()).sent, 0);
  } finally { delete process.env.REMINDER_TEMPLATE; }
});

test('test mode lets an owner pretend to be a customer, and is refused when WhatsApp is live', async () => {
  wa.sent.length = 0;
  const r = await api('POST', '/api/test/customer-message', { name: 'Tester', text: 'How much is cleaning?' }, S.ta);
  assert.equal(r.status, 200); assert.equal(r.json.result.sent, true); assert.equal(wa.sent.length, 1);
  assert.equal((await api('GET', '/api/chats', undefined, S.ta)).json.test_mode, true);
  const again = await api('POST', '/api/test/customer-message', { name: 'tester', text: 'one more' }, S.ta);
  assert.equal((await api('GET', '/api/chats', undefined, S.ta)).json.chats.filter((c) => c.name === 'Tester').length, 1);
  assert.equal((await api('POST', '/api/test/customer-message', { text: '  ' }, S.ta)).status, 400);
  process.env.WHATSAPP_MODE = '';
  try { assert.equal((await api('POST', '/api/test/customer-message', { text: 'hi' }, S.ta)).status, 400); }
  finally { process.env.WHATSAPP_MODE = 'mock'; }
});

test('admin overview shows usage and can change plan and status', async () => {
  const l = (await api('GET', '/api/admin/clients', undefined, S.admin)).json;
  const a = l.clients.find((c) => c.id === S.A); assert.ok(a.messages_used > 3); assert.equal(typeof a.percent_used, 'number'); assert.equal(a.plan, 'Starter');
  const p = await api('PATCH', '/api/admin/clients/' + S.B, { plan: 'Pro', status: 'active' }, S.admin); assert.equal(p.json.client.plan, 'Pro'); assert.equal(p.json.client.status, 'active');
  assert.equal((await api('PATCH', '/api/admin/clients/' + S.B, { plan: 'Gold' }, S.admin)).status, 400);
  assert.equal((await api('PATCH', '/api/admin/clients/' + S.B, { status: 'nope' }, S.admin)).status, 400);
});

test('login is rate limited; bad requests and files are handled safely', async () => {
  process.env.LOGIN_ATTEMPTS = '3';
  const codes = []; for (let i = 0; i < 5; i++) codes.push((await api('POST', '/api/login', { email: 'a@x.com', password: 'wrong-' + i })).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  process.env.LOGIN_ATTEMPTS = '100';
  assert.equal((await fetch(base + '/api/login', { method: 'POST', body: '{nope' })).status, 400);
  assert.equal((await fetch(base + '/api/login', { method: 'POST', body: '[]' })).status, 400);
  assert.equal((await api('GET', '/api/nothing', undefined, S.ta)).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 403);
  const big = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ email: 'x'.repeat(300000) }) }).then((r) => r.status).catch(() => 413);
  assert.ok(big === 413 || big === 0);
});
