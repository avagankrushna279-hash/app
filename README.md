# AI Receptionist: complete app

One Node server (one dependency, `pg`) that runs everything:

- **WhatsApp agent:** receives customer messages through the WhatsApp Cloud API webhook, answers with Claude using each business's services, FAQs, hours and rules, books appointments without double-booking, and hands over to a person when needed.
- **Owner app (installable on a phone):** chats (take over, reply, hand back), bookings, handover rules, setup, weekly report, Google profile check with AI advice, and Studio (Google posts, reel plans, review replies).
- **Agency admin:** you create clients and their logins, see usage against plan limits, pause or activate a client.
- **Database:** PostgreSQL (Supabase, Neon, Render, or your own).

## 1. Try it on your computer (about 10 minutes, no WhatsApp or AI key needed)

You need Node 18+ and a PostgreSQL database. A free Supabase project works: copy its connection string from Project Settings > Database.

```
cp .env.example .env        # then edit .env: set DATABASE_URL and APP_SECRET, and MOCK_LLM=1, WHATSAPP_MODE=mock
npm install
node cli.js migrate                      # creates the tables
node cli.js create-admin you@example.com yourpassword1
node cli.js demo                         # optional: a sample clinic with chats; owner login demo@example.com / demo12345
npm start
```
Open http://localhost:8787 and sign in. Mock mode uses canned AI answers and records WhatsApp messages instead of sending them, so everything can be clicked through.

To pretend a customer wrote on WhatsApp, send a webhook to the server (mock mode needs no signature):
```
curl -X POST localhost:8787/webhook/whatsapp -H 'content-type: application/json' -d '{"entry":[{"changes":[{"value":{"metadata":{"phone_number_id":"demo-number"},"contacts":[{"wa_id":"919000000009","profile":{"name":"Test"}}],"messages":[{"from":"919000000009","id":"t1","timestamp":"1700000000","type":"text","text":{"body":"How much is cleaning?"}}]}}]}]}'
```

**Test mode in the app:** while `WHATSAPP_MODE=mock`, the Chats screen shows a "Try as a customer" box so you can type as a customer and watch the AI reply, with no WhatsApp needed.

## 2. Put it online

**Easiest:** push this folder to GitHub and create a Render Blueprint from it (`render.yaml` creates the app and database). Read `START-HERE.txt`. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` and the first admin is created automatically.

Other hosts: (needed for the phone app and for real WhatsApp)

Any host that runs Node works (Render, Railway, Fly.io, a VPS). On Render: create a **Web Service** from your GitHub repo, build command `npm install`, start command `node server.js`, then add the environment variables from `.env.example`. It gives you an HTTPS address.

Free plans that sleep when idle make WhatsApp replies slow or lost, so use an always-on plan for real customers. Check each host's current plans.

## 3. Turn on real AI and real WhatsApp

1. **AI:** put your Anthropic key in `ANTHROPIC_API_KEY` and set `MOCK_LLM=0`. Without a key, the agent safely hands every chat to a person.
2. **WhatsApp (Meta Cloud API):**
   - In Meta for Developers, create an app with the WhatsApp product and add your business phone number.
   - Copy the **phone number ID** and create a permanent access token (a system user token). Put the token in `WHATSAPP_TOKEN`, the app secret in `WHATSAPP_APP_SECRET`, and choose any random text for `WHATSAPP_VERIFY_TOKEN`. Leave `WHATSAPP_MODE` empty.
   - Set the webhook callback URL to `https://YOUR-ADDRESS/webhook/whatsapp` with that verify token, and subscribe to **messages**.
   - In the admin screen, create the client and paste its **phone number ID**. Each business needs its own number registered under your Meta business account.
3. **Messages outside WhatsApp's 24-hour window** (owner alerts, appointment reminders) must use approved templates. Create them in Meta and set `ALERT_TEMPLATE` (one body variable) and `REMINDER_TEMPLATE` (three: name, service, time). Without them, alerts try a normal message and may fail, and reminders stay off.

## 4. Day to day

- **New client:** sign in as admin, tap **Add a client**, enter the business, the owner's email and a password, and the WhatsApp phone number ID. Send the owner the address and login. They then fill in **Setup** (services, questions, hours).
- **Forgot a password:** `node cli.js set-password someone@example.com newpassword1`.
- **Prices and limits:** the plan names and message limits in the `plans` table are placeholders. Change them in the database to what you actually sell.

## 5. Tests

`npm test` runs 20 backend tests against a real PostgreSQL (it creates a throwaway database called `apptest`, so the database user needs permission to create databases; set `TEST_DB_ADMIN_URL` and `TEST_DATABASE_URL` if yours is not local).

## Honest limits

- **Not yet tested against live services.** Everything was tested with a real database and a real browser, but with mock AI answers and mock WhatsApp. The real Claude, Meta and Google calls are written but unproven. Test with your own number first and read what the AI sends.
- Bookings live in this app only. They are not synced to Google Calendar.
- The Google profile check works on profile details pasted as JSON. Live Google sync needs Google's API access approval.
- No email, no self-service password reset, one kind of admin.
- AI answers can be wrong. Keep the handover rules on, and review Studio drafts before posting.
- You store customers' phone numbers and messages. Add a privacy policy, get the business's consent line in place, and ask a lawyer about India's data protection rules before charging customers.
- The login and AI rate limits are kept in memory, which is fine for one server instance only.
