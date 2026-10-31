'use strict';
const { q, one, all, tx } = require('./db');
const { hashPassword, verifyPassword, sign } = require('./auth');
const { audit } = require('../lib/gbp-audit');
const { run, zonedToUtc } = require('../lib/agents');
const llm = require('../lib/llm');
const wa = require('./whatsapp');
const sample = require('../sample/profile.json');
const { handleIncoming } = require('./flow');

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const str = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const need = (c, m, status) => { if (!c) throw bad(m, status); };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const TYPES = ['Clinic', 'Salon', 'Restaurant', 'Gym', 'Retail', 'Other'], TONES = ['Friendly', 'Formal', 'Short'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const id = (v) => { if (!UUID.test(String(v))) throw bad('Not found', 404); return v; };
const time = (v, label) => { need(/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)), label + ' must look like 10:00'); return v; };
const tzOk = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (e) { return false; } };

const attempts = new Map();
function tooMany(key) {
  const now = Date.now(), list = (attempts.get(key) || []).filter((t) => now - t < 10 * 60000);
  list.push(now); attempts.set(key, list);
  return list.length > Number(process.env.LOGIN_ATTEMPTS || 8);
}
const DUMMY = hashPassword('not-a-real-password');

async function getClient(cid) {
  const c = await one('select c.*, p.name as plan from clients c left join plans p on p.id = c.plan_id where c.id = $1', [cid]);
  need(c, 'Client not found', 404);
  return c;
}
const publicClient = (c) => ({ id: c.id, name: c.name, business_type: c.business_type, city: c.city, status: c.status, ai_enabled: c.ai_enabled, plan: c.plan, languages: c.languages, tone: c.tone, opening_hours: c.opening_hours, timezone: c.timezone, open_time: String(c.open_time).slice(0, 5), close_time: String(c.close_time).slice(0, 5), closed_days: c.closed_days, owner_whatsapp: c.owner_whatsapp, wa_number_id: c.wa_number_id });
async function ownConversation(cid, convId) {
  const cv = await one('select cv.*, cu.name as customer_name, cu.phone from conversations cv join customers cu on cu.id = cv.customer_id where cv.id = $1 and cv.client_id = $2', [id(convId), cid]);
  need(cv, 'Not found', 404);
  return cv;
}
const bizCtx = (c) => ({ name: c.name, type: c.business_type, city: c.city, tone: c.tone, languages: c.languages });

const R = []; // [method, pattern, access, handler]
const on = (method, pattern, access, handler) => R.push([method, pattern, access, handler]);

// ------------------------------------------------------------------ auth
on('POST', '/api/login', 'public', async ({ body, ip }) => {
  const email = str(body.email, 200).toLowerCase(), pw = typeof body.password === 'string' ? body.password : '';
  if (tooMany(ip + '|' + email)) throw bad('Too many attempts. Try again in a few minutes.', 429);
  const u = await one('select * from app_users where email = $1', [email]);
  const ok = verifyPassword(pw, u ? u.password_hash : DUMMY);
  if (!u || !ok) throw bad('Wrong email or password', 401);
  attempts.delete(ip + '|' + email);
  return { token: sign({ uid: u.id, role: u.role, cid: u.client_id }), user: await me(u) };
});
async function me(u) {
  const c = u.client_id ? await one('select name from clients where id = $1', [u.client_id]) : null;
  return { email: u.email, role: u.role, clientId: u.client_id, clientName: c && c.name };
}
on('GET', '/api/me', 'user', async ({ user }) => me(await one('select * from app_users where id = $1', [user.uid])));

// ------------------------------------------------------------------ home, chats
on('GET', '/api/home', 'owner', async ({ cid }) => {
  const c = await getClient(cid), tz = c.timezone;
  const stats = await one(`select
    (select count(*)::int from conversations where client_id = $1 and (last_message_at at time zone $2)::date = (now() at time zone $2)::date) as chats_today,
    (select count(*)::int from bookings where client_id = $1 and status = 'booked' and (start_at at time zone $2)::date = (now() at time zone $2)::date) as bookings_today,
    (select count(*)::int from conversations where client_id = $1 and status = 'handed_over') as needs_you`, [cid, tz]);
  return { client: publicClient(c), stats, today: (await one('select (now() at time zone $1)::date::text as d', [tz])).d };
});
on('POST', '/api/live', 'owner', async ({ cid, body }) => {
  need(typeof body.enabled === 'boolean', 'enabled must be true or false');
  await q('update clients set ai_enabled = $2 where id = $1', [cid, body.enabled]);
  return { ai_enabled: body.enabled };
});
on('GET', '/api/chats', 'owner', async ({ cid }) => ({ test_mode: process.env.WHATSAPP_MODE === 'mock', chats: await all(`select cv.id, cv.status, cv.handover_reason, cv.last_message_at, cu.name, cu.phone,
    (select body from messages m where m.conversation_id = cv.id order by created_at desc limit 1) as last_body
    from conversations cv join customers cu on cu.id = cv.customer_id where cv.client_id = $1 order by cv.last_message_at desc limit 50`, [cid]) }));
// Test mode only: pretend to be a customer so the whole flow can be tried without WhatsApp.
on('POST', '/api/test/customer-message', 'owner', async ({ cid, body }) => {
  need(process.env.WHATSAPP_MODE === 'mock', 'Test messages only work while WHATSAPP_MODE is mock');
  const text = str(body.text, 1000); need(text, 'Type a message first');
  const c = await getClient(cid);
  let numId = c.wa_number_id;
  if (!numId) { numId = 'mock-' + cid.slice(0, 8); await q('update clients set wa_number_id = $2 where id = $1', [cid, numId]); }
  const name = str(body.name, 60) || 'Test customer';
  const phone = '9199' + (parseInt(require('crypto').createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 7), 16) % 100000000).toString().padStart(8, '0');
  const r = await handleIncoming({ wa_number_id: numId, phone, name, wa_message_id: 'test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), type: 'text', ts: Math.floor(Date.now() / 1000), text });
  return { ok: true, result: r };
});
on('GET', '/api/chats/:id', 'owner', async ({ cid, params }) => {
  const cv = await ownConversation(cid, params.id);
  return { chat: { id: cv.id, status: cv.status, handover_reason: cv.handover_reason, name: cv.customer_name, phone: cv.phone },
    messages: await all('select id, role, body, send_error, created_at from messages where conversation_id = $1 order by created_at', [cv.id]) };
});
on('POST', '/api/chats/:id/reply', 'owner', async ({ cid, params, body }) => {
  const text = str(body.text, 1000);
  need(text, 'Type a message first');
  const cv = await ownConversation(cid, params.id), c = await getClient(cid);
  const m = await one('select record_reply($1, $2, $3, $4, $5) as id', [cv.id, 'owner', text, cv.status === 'ai', 'owner took over']);
  const res = await wa.send(c.wa_number_id, cv.phone, text);
  if (!res.ok) await q('update messages set send_error = $2 where id = $1', [m.id, res.error]);
  return { delivered: res.ok, error: res.ok ? null : res.error };
});
on('POST', '/api/chats/:id/status', 'owner', async ({ cid, params, body }) => {
  need(['ai', 'handed_over', 'closed'].includes(body.status), 'Invalid status');
  const cv = await ownConversation(cid, params.id);
  await q('update conversations set status = $2, handover_reason = case when $2 = \'ai\' then null else handover_reason end where id = $1', [cv.id, body.status]);
  return { status: body.status };
});

// ------------------------------------------------------------------ bookings
on('GET', '/api/bookings', 'owner', async ({ cid, query }) => {
  const c = await getClient(cid);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : (await one('select (now() at time zone $1)::date::text as d', [c.timezone])).d;
  const days = Math.min(14, Math.max(1, Number(query.days) || 2));
  return { bookings: await all(`select b.id, b.service, coalesce(b.customer_name, cu.name) as name, cu.phone, b.source, b.status, b.duration_min,
      (b.start_at at time zone $2)::date::text as date, to_char(b.start_at at time zone $2, 'HH24:MI') as time
      from bookings b left join customers cu on cu.id = b.customer_id
      where b.client_id = $1 and (b.start_at at time zone $2)::date >= $3::date and (b.start_at at time zone $2)::date < $3::date + $4::int order by b.start_at`, [cid, c.timezone, from, days]) };
});
on('POST', '/api/bookings', 'owner', async ({ cid, body }) => {
  const c = await getClient(cid);
  const name = str(body.name, 100), service = str(body.service, 100), phone = str(body.phone, 20).replace(/[^\d+]/g, '');
  need(name && service, 'Name and service are required');
  need(/^\d{4}-\d{2}-\d{2}$/.test(body.date || ''), 'Date must look like 2026-11-02');
  time(body.time, 'Time');
  const mins = Math.min(480, Math.max(5, Number(body.minutes) || 30));
  let customerId = null;
  if (phone) customerId = (await one('insert into customers (client_id, phone, name) values ($1, $2, $3) on conflict (client_id, phone) do update set name = coalesce(customers.name, excluded.name) returning id', [cid, phone.replace(/^\+/, ''), name])).id;
  try {
    const b = await one('select create_booking($1, $2, $3, $4, $5, $6, $7) as id', [cid, customerId, name, service, zonedToUtc(body.date, body.time, c.timezone), mins, 'staff']);
    return { id: b.id };
  } catch (e) { if (/slot_taken/.test(e.message)) throw bad('That time is already booked', 409); throw e; }
});
on('POST', '/api/bookings/:id/status', 'owner', async ({ cid, params, body }) => {
  need(['booked', 'completed', 'cancelled', 'no_show'].includes(body.status), 'Invalid status');
  const r = await q('update bookings set status = $3 where id = $1 and client_id = $2', [id(params.id), cid, body.status]);
  need(r.rowCount, 'Not found', 404);
  return { status: body.status };
});

// ------------------------------------------------------------------ settings, rules, services, faqs
on('GET', '/api/settings', 'owner', async ({ cid }) => ({ settings: publicClient(await getClient(cid)) }));
on('PUT', '/api/settings', 'owner', async ({ cid, body }) => {
  const set = [], v = [cid];
  const add = (col, val) => { v.push(val); set.push(col + ' = $' + v.length); };
  if (body.name !== undefined) { need(str(body.name, 100), 'Business name is required'); add('name', str(body.name, 100)); }
  if (body.business_type !== undefined) { need(TYPES.includes(body.business_type), 'Invalid business type'); add('business_type', body.business_type); }
  if (body.tone !== undefined) { need(TONES.includes(body.tone), 'Invalid tone'); add('tone', body.tone); }
  if (body.city !== undefined) add('city', str(body.city, 80) || null);
  if (body.languages !== undefined) { need(Array.isArray(body.languages) && body.languages.length && body.languages.length <= 6, 'Pick 1 to 6 languages'); add('languages', body.languages.map((l) => str(l, 30)).filter(Boolean)); }
  if (body.opening_hours !== undefined) add('opening_hours', str(body.opening_hours, 200) || null);
  if (body.open_time !== undefined) add('open_time', time(body.open_time, 'Opening time'));
  if (body.close_time !== undefined) add('close_time', time(body.close_time, 'Closing time'));
  if (body.closed_days !== undefined) { need(Array.isArray(body.closed_days) && body.closed_days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6), 'closed_days must be numbers 0 to 6'); add('closed_days', body.closed_days); }
  if (body.owner_whatsapp !== undefined) add('owner_whatsapp', str(body.owner_whatsapp, 20).replace(/[^\d+]/g, '') || null);
  if (body.timezone !== undefined) { need(tzOk(body.timezone), 'Unknown time zone'); add('timezone', body.timezone); }
  if (set.length) await q('update clients set ' + set.join(', ') + ' where id = $1', v);
  return { settings: publicClient(await getClient(cid)) };
});
const RULE_KEYS = ['asks_person', 'urgent_problem', 'upset'];
on('GET', '/api/rules', 'owner', async ({ cid }) => ({ rules: Object.fromEntries((await all('select rule_key, enabled from handover_rules where client_id = $1', [cid])).map((r) => [r.rule_key, r.enabled])) }));
on('PUT', '/api/rules', 'owner', async ({ cid, body }) => {
  for (const k of RULE_KEYS) if (typeof body[k] === 'boolean') await q('insert into handover_rules (client_id, rule_key, enabled) values ($1, $2, $3) on conflict (client_id, rule_key) do update set enabled = excluded.enabled', [cid, k, body[k]]);
  return { rules: Object.fromEntries((await all('select rule_key, enabled from handover_rules where client_id = $1', [cid])).map((r) => [r.rule_key, r.enabled])) };
});
on('GET', '/api/knowledge', 'owner', async ({ cid }) => ({
  services: await all('select id, name, price::float as price, duration_min from services where client_id = $1 order by created_at', [cid]),
  faqs: await all('select id, question, answer from faqs where client_id = $1 order by created_at', [cid]),
}));
on('POST', '/api/services', 'owner', async ({ cid, body }) => {
  const name = str(body.name, 100); need(name, 'Service name is required');
  const price = body.price === '' || body.price == null ? null : Number(body.price); need(price === null || (Number.isFinite(price) && price >= 0), 'Price must be a number');
  const dur = body.duration_min ? Math.min(480, Math.max(5, Number(body.duration_min) || 30)) : null;
  need((await one('select count(*)::int n from services where client_id = $1', [cid])).n < 100, 'Too many services');
  return { id: (await one('insert into services (client_id, name, price, duration_min) values ($1, $2, $3, $4) returning id', [cid, name, price, dur])).id };
});
on('DELETE', '/api/services/:id', 'owner', async ({ cid, params }) => { await q('delete from services where id = $1 and client_id = $2', [id(params.id), cid]); return { ok: true }; });
on('POST', '/api/faqs', 'owner', async ({ cid, body }) => {
  const qn = str(body.question, 300), an = str(body.answer, 1000); need(qn && an, 'Question and answer are required');
  need((await one('select count(*)::int n from faqs where client_id = $1', [cid])).n < 100, 'Too many questions');
  return { id: (await one('insert into faqs (client_id, question, answer) values ($1, $2, $3) returning id', [cid, qn, an])).id };
});
on('DELETE', '/api/faqs/:id', 'owner', async ({ cid, params }) => { await q('delete from faqs where id = $1 and client_id = $2', [id(params.id), cid]); return { ok: true }; });

// ------------------------------------------------------------------ report
on('GET', '/api/report', 'owner', async ({ cid }) => {
  const c = await getClient(cid);
  const days = await all(`select d::date::text as day, coalesce(count(distinct m.conversation_id), 0)::int as chats
    from generate_series((now() at time zone $2)::date - 6, (now() at time zone $2)::date, '1 day') d
    left join messages m on m.client_id = $1 and m.role = 'customer' and (m.created_at at time zone $2)::date = d::date group by d order by d`, [cid, c.timezone]);
  const w = await one(`select
    (select count(distinct cv.customer_id)::int from conversations cv join messages m on m.conversation_id = cv.id and m.role = 'ai' where cv.client_id = $1 and m.created_at >= now() - interval '7 days') as helped,
    (select count(distinct cv.customer_id)::int from conversations cv join messages m on m.conversation_id = cv.id and m.role = 'ai' where cv.client_id = $1 and m.created_at >= now() - interval '14 days' and m.created_at < now() - interval '7 days') as helped_prev,
    (select count(*)::int from bookings where client_id = $1 and status <> 'cancelled' and created_at >= now() - interval '7 days') as bookings,
    (select count(*)::int from conversations where client_id = $1 and after_hours and created_at >= now() - interval '7 days') as after_hours`, [cid]);
  return { ...w, change_pct: w.helped_prev > 0 ? Math.round(((w.helped - w.helped_prev) / w.helped_prev) * 100) : null, days };
});

// ------------------------------------------------------------------ Google profile
on('GET', '/api/gbp/sample', 'owner', async () => sample);
on('GET', '/api/gbp', 'owner', async ({ cid }) => ({
  saved: await one('select profile, metrics, updated_at from gbp_profiles where client_id = $1', [cid]),
  latest: await one('select score, grade, audit, advice, created_at from gbp_audits where client_id = $1 order by created_at desc limit 1', [cid]),
}));
on('PUT', '/api/gbp', 'owner', async ({ cid, body }) => {
  need(isObj(body.profile) && JSON.stringify(body).length < 100000, 'Send the profile as a JSON object (under 100 KB)');
  need(body.metrics == null || isObj(body.metrics), 'metrics must be an object');
  await q('insert into gbp_profiles (client_id, profile, metrics) values ($1, $2, $3) on conflict (client_id) do update set profile = excluded.profile, metrics = excluded.metrics, updated_at = now()', [cid, body.profile, body.metrics || null]);
  return { ok: true };
});
async function runAudit(cid, withAdvice) {
  const s = await one('select profile, metrics from gbp_profiles where client_id = $1', [cid]);
  need(s, 'Save your Google profile details first');
  const a = audit(s.profile, s.metrics);
  const advice = withAdvice ? await run('gbp_advisor', { profile: s.profile, metrics: s.metrics, audit: a }, llm) : null;
  await q('insert into gbp_audits (client_id, score, grade, audit, advice) values ($1, $2, $3, $4, $5)', [cid, a.score, a.grade, a, advice]);
  return { audit: a, advice };
}
on('POST', '/api/gbp/audit', 'owner', async ({ cid }) => runAudit(cid, false));
on('POST', '/api/gbp/advise', 'owner', async ({ cid }) => runAudit(cid, true));

// ------------------------------------------------------------------ studio
on('GET', '/api/creatives', 'owner', async ({ cid }) => ({ creatives: await all('select id, kind, headline, caption, details, status, created_at from creatives where client_id = $1 order by created_at desc limit 50', [cid]) }));
on('POST', '/api/creatives', 'owner', async ({ cid, body }) => {
  need(['post', 'story', 'reel'].includes(body.kind), 'kind must be post, story or reel');
  need(str(body.headline, 200) || str(body.caption, 1500), 'Add a headline or caption');
  need((await one('select count(*)::int n from creatives where client_id = $1', [cid])).n < 500, 'Too many saved items');
  return { id: (await one('insert into creatives (client_id, kind, headline, caption, details) values ($1, $2, $3, $4, $5) returning id', [cid, body.kind, str(body.headline, 200), str(body.caption, 1500), isObj(body.details) ? body.details : null])).id };
});
on('POST', '/api/creatives/:id/status', 'owner', async ({ cid, params, body }) => {
  need(['draft', 'needs_approval', 'approved', 'published'].includes(body.status), 'Invalid status');
  need((await q('update creatives set status = $3 where id = $1 and client_id = $2', [id(params.id), cid, body.status])).rowCount, 'Not found', 404);
  return { status: body.status };
});
on('DELETE', '/api/creatives/:id', 'owner', async ({ cid, params }) => { await q('delete from creatives where id = $1 and client_id = $2', [id(params.id), cid]); return { ok: true }; });
on('POST', '/api/studio/draft', 'owner', async ({ cid, body }) => {
  const biz = bizCtx(await getClient(cid));
  if (body.type === 'post') { need(str(body.topic, 600), 'Tell the AI what the post is about'); return { type: 'post', result: await run('gbp_post', { business: biz, topic: str(body.topic, 600), kind: body.kind }, llm) }; }
  if (body.type === 'social') { need(str(body.goal, 600), 'Tell the AI the goal'); return { type: 'social', result: await run('social_content', { business: biz, goal: str(body.goal, 600), format: body.format }, llm) }; }
  if (body.type === 'review') { need(isObj(body.review) && str(body.review.text, 1500), 'Paste the review text'); return { type: 'review', result: await run('review_reply', { business: biz, review: { rating: Number(body.review.rating) || null, reviewerName: str(body.review.name, 60), text: str(body.review.text, 1500) } }, llm) }; }
  throw bad('type must be post, social or review');
});

// ------------------------------------------------------------------ admin
const adminList = `select c.id, c.name, c.business_type, c.status, c.ai_enabled, c.wa_number_id, p.name as plan, p.monthly_message_limit,
  coalesce(u.messages_count, 0)::int as messages_used, round(100.0 * coalesce(u.messages_count, 0) / nullif(p.monthly_message_limit, 0))::int as percent_used
  from clients c left join plans p on p.id = c.plan_id left join usage_monthly u on u.client_id = c.id and u.month = date_trunc('month', now())::date`;
on('GET', '/api/admin/clients', 'admin', async () => ({ clients: await all(adminList + ' order by c.created_at desc'), plans: await all('select name, monthly_message_limit from plans order by monthly_message_limit') }));
on('POST', '/api/admin/clients', 'admin', async ({ body }) => {
  const name = str(body.name, 100), email = str(body.owner_email, 200).toLowerCase(), pw = typeof body.owner_password === 'string' ? body.owner_password : '';
  need(name, 'Business name is required'); need(EMAIL.test(email), 'Enter a valid owner email'); need(pw.length >= 8, 'Password must be at least 8 characters');
  need(TYPES.includes(body.business_type || 'Other'), 'Invalid business type');
  const plan = await one('select id from plans where name = $1', [str(body.plan, 40) || 'Trial']); need(plan, 'Unknown plan');
  const wa_id = str(body.wa_number_id, 40) || null;
  return tx(async (run) => {
    const c = (await run('insert into clients (name, business_type, city, plan_id, wa_number_id, owner_whatsapp) values ($1, $2, $3, $4, $5, $6) returning id', [name, body.business_type || 'Other', str(body.city, 80) || null, plan.id, wa_id, str(body.owner_whatsapp, 20).replace(/[^\d+]/g, '') || null])).rows[0];
    await run('insert into app_users (email, password_hash, role, client_id) values ($1, $2, $3, $4)', [email, hashPassword(pw), 'owner', c.id]);
    return { id: c.id, owner_email: email };
  });
});
on('PATCH', '/api/admin/clients/:id', 'admin', async ({ params, body }) => {
  const set = [], v = [id(params.id)];
  const add = (col, val) => { v.push(val); set.push(col + ' = $' + v.length); };
  if (body.status !== undefined) { need(['active', 'trial', 'paused'].includes(body.status), 'Invalid status'); add('status', body.status); }
  if (body.plan !== undefined) { const p = await one('select id from plans where name = $1', [str(body.plan, 40)]); need(p, 'Unknown plan'); add('plan_id', p.id); }
  if (body.wa_number_id !== undefined) add('wa_number_id', str(body.wa_number_id, 40) || null);
  if (body.owner_whatsapp !== undefined) add('owner_whatsapp', str(body.owner_whatsapp, 20).replace(/[^\d+]/g, '') || null);
  if (set.length) need((await q('update clients set ' + set.join(', ') + ' where id = $1', v)).rowCount, 'Not found', 404);
  return { client: await one(adminList + ' where c.id = $1', [params.id]) };
});

module.exports = { routes: R, bad, need, isObj };
