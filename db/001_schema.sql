-- AI Receptionist: complete schema for any PostgreSQL 13+ (Supabase, Neon, Render, your own).
-- The server enforces who can see what, so no database-specific login tables are needed.

create table plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  monthly_message_limit integer not null check (monthly_message_limit > 0),
  price_inr integer,
  created_at timestamptz not null default now()
);
-- Placeholder limits: change them to what you actually sell.
insert into plans (name, monthly_message_limit) values ('Trial', 300), ('Starter', 1000), ('Pro', 3000);

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business_type text not null default 'Other' check (business_type in ('Clinic','Salon','Restaurant','Gym','Retail','Other')),
  city text,
  plan_id uuid references plans(id),
  status text not null default 'trial' check (status in ('active','trial','paused')),
  ai_enabled boolean not null default true,
  wa_number_id text unique,
  owner_whatsapp text,
  languages text[] not null default array['English'],
  tone text not null default 'Friendly' check (tone in ('Friendly','Formal','Short')),
  opening_hours text,
  timezone text not null default 'Asia/Kolkata',
  open_time time not null default '10:00',
  close_time time not null default '20:00',
  closed_days smallint[] not null default array[0],
  created_at timestamptz not null default now()
);

create table app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('owner','admin')),
  client_id uuid references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((role = 'owner' and client_id is not null) or (role = 'admin' and client_id is null))
);

create table services (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null, price numeric(10,2), duration_min integer,
  created_at timestamptz not null default now()
);
create table faqs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  question text not null, answer text not null,
  created_at timestamptz not null default now()
);
create table handover_rules (
  client_id uuid not null references clients(id) on delete cascade,
  rule_key text not null check (rule_key in ('asks_person','urgent_problem','upset')),
  enabled boolean not null default true,
  primary key (client_id, rule_key)
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  phone text not null, name text, first_seen timestamptz not null default now(),
  unique (client_id, phone)
);
create table conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  status text not null default 'ai' check (status in ('ai','handed_over','closed')),
  handover_reason text,
  after_hours boolean not null default false,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('customer','ai','owner')),
  body text not null,
  wa_message_id text,
  send_error text,
  created_at timestamptz not null default now()
);
create unique index messages_wa_unique on messages (client_id, wa_message_id) where wa_message_id is not null;

create table bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  customer_name text,
  service text not null,
  start_at timestamptz not null,
  duration_min integer not null default 30,
  source text not null default 'ai' check (source in ('ai','staff')),
  status text not null default 'booked' check (status in ('booked','completed','cancelled','no_show')),
  reminder_sent boolean not null default false,
  created_at timestamptz not null default now()
);

create table creatives (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('post','story','reel')),
  headline text, caption text, details jsonb,
  status text not null default 'draft' check (status in ('draft','needs_approval','approved','published')),
  created_at timestamptz not null default now()
);
create table usage_monthly (
  client_id uuid not null references clients(id) on delete cascade,
  month date not null, messages_count integer not null default 0,
  primary key (client_id, month)
);
create table gbp_profiles (
  client_id uuid primary key references clients(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb, metrics jsonb,
  updated_at timestamptz not null default now()
);
create table gbp_audits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  score integer not null check (score between 0 and 100), grade text not null,
  audit jsonb not null, advice jsonb, created_at timestamptz not null default now()
);

create index on services (client_id);
create index on faqs (client_id);
create index on conversations (client_id, last_message_at desc);
create index on messages (conversation_id, created_at);
create index on bookings (client_id, start_at);
create index on creatives (client_id, created_at desc);
create index on gbp_audits (client_id, created_at desc);

create function touch_conversation() returns trigger language plpgsql as $$
begin update conversations set last_message_at = new.created_at where id = new.conversation_id; return new; end $$;
create trigger messages_touch after insert on messages for each row execute function touch_conversation();

create function count_ai_message() returns trigger language plpgsql as $$
begin
  if new.role = 'ai' then
    insert into usage_monthly (client_id, month, messages_count)
    values (new.client_id, date_trunc('month', new.created_at)::date, 1)
    on conflict (client_id, month) do update set messages_count = usage_monthly.messages_count + 1;
  end if;
  return new;
end $$;
create trigger messages_usage after insert on messages for each row execute function count_ai_message();

create function seed_handover_rules() returns trigger language plpgsql as $$
begin
  insert into handover_rules (client_id, rule_key) values (new.id,'asks_person'), (new.id,'urgent_problem'), (new.id,'upset');
  return new;
end $$;
create trigger clients_seed_rules after insert on clients for each row execute function seed_handover_rules();

-- Store an incoming customer message (find/create customer and open conversation, ignore repeats).
create function ingest_customer_message(p_client uuid, p_phone text, p_name text, p_wa_message_id text, p_text text, p_after_hours boolean default false)
returns table (out_conversation_id uuid, out_customer_id uuid, out_status text, out_duplicate boolean)
language plpgsql as $$
declare v_customer uuid; v_conv uuid; v_status text;
begin
  if p_wa_message_id is not null then
    select m.conversation_id into v_conv from messages m where m.client_id = p_client and m.wa_message_id = p_wa_message_id limit 1;
    if v_conv is not null then
      select cv.customer_id, cv.status into v_customer, v_status from conversations cv where cv.id = v_conv;
      return query select v_conv, v_customer, v_status, true; return;
    end if;
  end if;
  insert into customers (client_id, phone, name) values (p_client, p_phone, p_name)
  on conflict (client_id, phone) do update set name = coalesce(customers.name, excluded.name)
  returning id into v_customer;
  select cv.id, cv.status into v_conv, v_status from conversations cv
   where cv.client_id = p_client and cv.customer_id = v_customer and cv.status <> 'closed' and cv.last_message_at > now() - interval '24 hours'
   order by cv.last_message_at desc limit 1;
  if v_conv is null then
    insert into conversations (client_id, customer_id, after_hours) values (p_client, v_customer, p_after_hours) returning id, status into v_conv, v_status;
  end if;
  insert into messages (client_id, conversation_id, role, body, wa_message_id) values (p_client, v_conv, 'customer', p_text, p_wa_message_id);
  return query select v_conv, v_customer, v_status, false;
end $$;

create function record_reply(p_conversation uuid, p_role text, p_text text, p_handover boolean default false, p_reason text default null)
returns uuid language plpgsql as $$
declare v_client uuid; v_id uuid;
begin
  if p_role not in ('ai','owner') then raise exception 'role must be ai or owner'; end if;
  select cv.client_id into v_client from conversations cv where cv.id = p_conversation;
  if v_client is null then raise exception 'unknown conversation'; end if;
  insert into messages (client_id, conversation_id, role, body) values (v_client, p_conversation, p_role, p_text) returning id into v_id;
  if p_handover then update conversations set status = 'handed_over', handover_reason = p_reason where id = p_conversation; end if;
  return v_id;
end $$;

create function recent_messages(p_conversation uuid, p_limit integer default 10)
returns table (role text, body text, created_at timestamptz) language sql stable as $$
  select x.role, x.body, x.created_at from (select m.role, m.body, m.created_at from messages m where m.conversation_id = p_conversation order by m.created_at desc limit p_limit) x order by x.created_at asc;
$$;

-- Create a booking; raises 'slot_taken' on overlap. One booking at a time per client.
create function create_booking(p_client uuid, p_customer uuid, p_name text, p_service text, p_start timestamptz, p_minutes integer default 30, p_source text default 'ai')
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_client::text));
  if exists (select 1 from bookings b where b.client_id = p_client and b.status = 'booked'
      and b.start_at < p_start + make_interval(mins => p_minutes)
      and b.start_at + make_interval(mins => b.duration_min) > p_start) then
    raise exception 'slot_taken';
  end if;
  insert into bookings (client_id, customer_id, customer_name, service, start_at, duration_min, source)
  values (p_client, p_customer, p_name, p_service, p_start, p_minutes, p_source) returning id into v_id;
  return v_id;
end $$;
