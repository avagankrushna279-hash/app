'use strict';
// Sends appointment reminders with an approved WhatsApp template (REMINDER_TEMPLATE).
// The template needs 3 body variables: {{1}} customer name, {{2}} service, {{3}} time.
const { all, q } = require('./db');
const wa = require('./whatsapp');
async function runReminders(now = new Date()) {
  const tpl = process.env.REMINDER_TEMPLATE;
  if (!tpl) return { skipped: 'REMINDER_TEMPLATE not set' };
  const rows = await all(`select b.id, b.service, b.start_at, coalesce(b.customer_name, cu.name) as name, cu.phone, c.wa_number_id, c.timezone
    from bookings b join clients c on c.id = b.client_id join customers cu on cu.id = b.customer_id
    where b.status = 'booked' and not b.reminder_sent and c.status <> 'paused' and c.ai_enabled
      and b.start_at > $1::timestamptz + interval '1 hour' and b.start_at <= $1::timestamptz + interval '24 hours'`, [now]);
  let sent = 0;
  for (const b of rows) {
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: b.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(b.start_at);
    const res = await wa.sendTemplate(b.wa_number_id, b.phone, tpl, process.env.REMINDER_TEMPLATE_LANG || 'en', [b.name || 'there', b.service, when]);
    if (res.ok) { await q('update bookings set reminder_sent = true where id = $1', [b.id]); sent++; }
    else console.error('Reminder failed:', res.error);
  }
  return { due: rows.length, sent };
}
function start() { setInterval(() => runReminders().catch((e) => console.error(e.message)), 5 * 60 * 1000).unref(); }
module.exports = { runReminders, start };
