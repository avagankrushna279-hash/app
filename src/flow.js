'use strict';
// What happens when a customer messages a business on WhatsApp.
const { q, one, all } = require('./db');
const wa = require('./whatsapp');
const { run } = require('../lib/agents');
const defaultLlm = require('../lib/llm');

function localParts(date, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t).value;
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')), hhmm: g('hour') + ':' + g('minute') };
}
function isOpen(client, date) {
  const { dow, hhmm } = localParts(date, client.timezone);
  return !((client.closed_days || []).includes(dow) || hhmm < String(client.open_time).slice(0, 5) || hhmm >= String(client.close_time).slice(0, 5));
}
async function agentClient(client) {
  const [services, faqs, rules] = await Promise.all([
    all('select name, price::float as price, duration_min from services where client_id = $1 order by created_at', [client.id]),
    all('select question as q, answer as a from faqs where client_id = $1 order by created_at', [client.id]),
    all('select rule_key, enabled from handover_rules where client_id = $1', [client.id]),
  ]);
  return { ...client, services, faqs, rules: Object.fromEntries(rules.map((r) => [r.rule_key, r.enabled])) };
}

async function deliver(client, ing, phone, text, { handover = false, reason = null } = {}) {
  const msg = await one('select record_reply($1, $2, $3, $4, $5) as id', [ing.out_conversation_id, 'ai', text, handover, reason]);
  const res = await wa.send(client.wa_number_id, phone, text);
  if (!res.ok) await q('update messages set send_error = $2 where id = $1', [msg.id, res.error]);
  if (handover) {
    const cu = await one('select name from customers where id = $1', [ing.out_customer_id]);
    await wa.alertOwner(client, (cu && cu.name ? cu.name : phone) + ' needs you: ' + (reason || 'handover'));
  }
  return { sent: res.ok };
}

async function handleIncoming(m, deps = {}) {
  const llm = deps.llm || defaultLlm;
  const client = await one('select * from clients where wa_number_id = $1', [m.wa_number_id]);
  if (!client) return { ignored: 'unknown_number' };
  const isText = m.type === 'text';
  const text = isText ? m.text : '[' + m.type + ']';
  const ing = await one('select * from ingest_customer_message($1, $2, $3, $4, $5, $6)', [client.id, m.phone, m.name, m.wa_message_id, text, !isOpen(client, new Date(m.ts * 1000))]);
  if (ing.out_duplicate) return { ignored: 'duplicate' };
  const base = { conversationId: ing.out_conversation_id };
  if (!(client.ai_enabled && client.status !== 'paused' && ing.out_status === 'ai')) return { ...base, ai: false };
  if (!isText || !text.trim()) return { ...base, ...(await deliver(client, ing, m.phone, 'Thanks! I can only read text messages. Could you type your question?')) };

  const ac = await agentClient(client);
  const history = await all('select * from recent_messages($1, 10)', [ing.out_conversation_id]);
  let r;
  try { r = await run('whatsapp', { client: ac, history }, llm); }
  catch (e) {
    console.error('AI unavailable:', e.message);
    r = { reply: 'Thanks for your message. Our team will get back to you shortly.', intent: 'handover', reason: 'ai_unavailable', handover: true, booking_ready: false };
  }

  let bookingId = null;
  if (r.booking_ready) {
    const start = new Date(r.booking_start_utc);
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: client.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(start);
    const svc = ac.services.find((s) => s.name.toLowerCase() === String(r.booking.service).toLowerCase());
    if (!isOpen(client, start)) {
      r = { ...r, intent: 'other', handover: false, reply: 'We are closed at that time. Our hours are ' + (client.opening_hours || String(client.open_time).slice(0, 5) + ' to ' + String(client.close_time).slice(0, 5)) + '. Which other time works for you?' };
    } else {
      try {
        bookingId = (await one('select create_booking($1, $2, $3, $4, $5, $6, $7) as id', [client.id, ing.out_customer_id, r.booking.name, r.booking.service, r.booking_start_utc, (svc && svc.duration_min) || 30, 'ai'])).id;
        await q('update customers set name = coalesce(name, $2) where id = $1', [ing.out_customer_id, r.booking.name]);
        r = { ...r, reply: 'Your ' + r.booking.service + ' is booked for ' + when + '. See you then!' };
      } catch (e) {
        if (!/slot_taken/.test(e.message)) throw e;
        r = { ...r, intent: 'other', handover: false, reply: 'Sorry, that time is already taken. Which other time works for you?' };
      }
    }
  }
  const out = await deliver(client, ing, m.phone, r.reply, { handover: r.handover, reason: r.reason });
  return { ...base, ...out, intent: r.intent, handover: !!r.handover, bookingId };
}
module.exports = { handleIncoming, isOpen, agentClient };
