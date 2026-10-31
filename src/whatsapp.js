'use strict';
// WhatsApp Cloud API: verify, parse, send. WHATSAPP_MODE=mock records messages instead of sending them.
const crypto = require('crypto');
const sent = [];
const mock = () => process.env.WHATSAPP_MODE === 'mock';

function verifySignature(raw, header) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return mock();           // no secret: only allowed in mock mode
  if (!header || !String(header).startsWith('sha256=')) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest();
  const got = Buffer.from(String(header).slice(7), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Turns a Cloud API webhook body into a flat list of incoming messages.
function parsePayload(body) {
  const out = [];
  for (const entry of (body && body.entry) || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    for (const m of v.messages || []) {
      out.push({
        wa_number_id: v.metadata && v.metadata.phone_number_id, phone: m.from, wa_message_id: m.id, type: m.type, ts: Number(m.timestamp) || Math.floor(Date.now() / 1000),
        name: ((v.contacts || []).find((c) => c.wa_id === m.from) || (v.contacts || [])[0] || {}).profile?.name || null,
        text: m.type === 'text' ? (m.text && m.text.body) || '' : '',
      });
    }
  }
  return out;
}

async function post(phoneNumberId, payload) {
  if (mock()) { sent.push({ phoneNumberId, to: payload.to, type: payload.type, text: payload.text ? payload.text.body : undefined, template: payload.template }); return { ok: true, id: 'mock-' + sent.length }; }
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { ok: false, error: 'WHATSAPP_TOKEN is not set' };
  try {
    const res = await fetch('https://graph.facebook.com/' + (process.env.GRAPH_VERSION || 'v21.0') + '/' + phoneNumberId + '/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }), signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (j.error && j.error.message) || 'HTTP ' + res.status };
    return { ok: true, id: j.messages && j.messages[0] && j.messages[0].id };
  } catch (e) { return { ok: false, error: e.message }; }
}
const send = (phoneNumberId, to, text) => post(phoneNumberId, { to, type: 'text', text: { body: String(text).slice(0, 4000) } });
const sendTemplate = (phoneNumberId, to, name, lang, params) => post(phoneNumberId, { to, type: 'template', template: { name, language: { code: lang || 'en' }, components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] } });
// Owner alerts need an approved template outside the 24-hour window, so use ALERT_TEMPLATE when set.
function alertOwner(client, text) {
  if (!client.owner_whatsapp || !client.wa_number_id) return Promise.resolve({ ok: false, error: 'no owner number' });
  const to = String(client.owner_whatsapp).replace(/\D/g, '');
  return process.env.ALERT_TEMPLATE ? sendTemplate(client.wa_number_id, to, process.env.ALERT_TEMPLATE, process.env.ALERT_TEMPLATE_LANG || 'en', [text]) : send(client.wa_number_id, to, text);
}
module.exports = { sent, verifySignature, parsePayload, send, sendTemplate, alertOwner };
