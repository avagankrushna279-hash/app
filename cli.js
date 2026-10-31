#!/usr/bin/env node
'use strict';
require('./lib/env').loadEnv();
const db = require('./src/db');
const { hashPassword } = require('./src/auth');
const [cmd, a, b] = process.argv.slice(2);

async function createAdmin(email, pw) {
  if (!email || !pw || pw.length < 8) throw new Error('Usage: node cli.js create-admin <email> <password of 8+ characters>');
  await db.q('insert into app_users (email, password_hash, role) values ($1, $2, $3) on conflict (email) do update set password_hash = excluded.password_hash', [email.toLowerCase(), hashPassword(pw), 'admin']);
  console.log('Admin ready: ' + email.toLowerCase());
}
async function demo(pw = 'demo12345') {
  const plan = await db.one("select id from plans where name = 'Starter'");
  let c = await db.one("select id from clients where wa_number_id = 'demo-number'");
  if (!c) {
    c = await db.one("insert into clients (name, business_type, city, plan_id, status, wa_number_id, owner_whatsapp, opening_hours) values ('Sample Dental Clinic','Clinic','Thane',$1,'active','demo-number','910000000000','Mon to Sat, 10am to 8pm. Closed Sunday.') returning id", [plan.id]);
    await db.q("insert into services (client_id, name, price, duration_min) values ($1,'Consultation',300,30),($1,'Teeth cleaning',800,45),($1,'Root canal',5000,60)", [c.id]);
    await db.q("insert into faqs (client_id, question, answer) values ($1,'Where are you located?','[address], Thane West'),($1,'Do you accept UPI?','Yes, UPI, cards and cash.')", [c.id]);
    const flow = require('./src/flow');
    process.env.MOCK_LLM = '1'; process.env.WHATSAPP_MODE = 'mock';
    const now = Math.floor(Date.now() / 1000);
    for (const [n, name, text] of [['919000000001', 'Rahul S.', 'How much does teeth cleaning cost?'], ['919000000002', 'Priya M.', 'I want a refund for my last visit']])
      await flow.handleIncoming({ wa_number_id: 'demo-number', phone: n, wa_message_id: 'demo-' + n, type: 'text', ts: now, name, text });
  }
  await db.q("insert into app_users (email, password_hash, role, client_id) values ('demo@example.com', $1, 'owner', $2) on conflict (email) do update set password_hash = excluded.password_hash", [hashPassword(pw), c.id]);
  console.log('Demo owner login: demo@example.com / ' + pw + '\n(Demo chats are samples written by the mock AI.)');
}
(async () => {
  if (cmd === 'migrate') { const r = await db.migrate(); console.log(r.length ? 'Applied: ' + r.join(', ') : 'Database is up to date'); }
  else if (cmd === 'create-admin') await createAdmin(a, b);
  else if (cmd === 'set-password') {
    if (!a || !b || b.length < 8) throw new Error('Usage: node cli.js set-password <email> <new password of 8+ characters>');
    const r = await db.q('update app_users set password_hash = $2 where email = $1', [a.toLowerCase(), hashPassword(b)]);
    if (!r.rowCount) throw new Error('No user with that email');
    console.log('Password changed for ' + a.toLowerCase());
  }
  else if (cmd === 'demo') await demo(a);
  else console.log('Commands:\n  node cli.js migrate\n  node cli.js create-admin <email> <password>\n  node cli.js set-password <email> <new password>   reset any login\n  node cli.js demo [password]   adds a sample business with a login, for testing');
  await db.close();
})().catch(async (e) => { console.error('Error: ' + e.message); await db.close(); process.exit(1); });
