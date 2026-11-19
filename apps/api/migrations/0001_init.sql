-- Ledgerproof core schema.
-- Design: docs/plans/0001-core-ledger.md and docs/decisions/.

-- The API connects as a member of this role. It does not own the tables and has no
-- BYPASSRLS, so row-level security applies to every query it runs.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ledger_app') then
    create role ledger_app nologin;
  end if;
end
$$;

create table tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

create table api_keys (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id),
  key_hash   bytea not null unique,  -- sha256 of the full key; the key itself is never stored
  label      text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table accounts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id),
  reference      text not null check (length(reference) between 1 and 200),
  currency       text not null check (currency ~ '^[A-Z]{3}$'),
  allow_negative boolean not null default false,
  balance        bigint not null default 0,
  created_at     timestamptz not null default now(),
  unique (tenant_id, reference),
  -- Target for the composite foreign keys on transfers.
  unique (tenant_id, id, currency),
  -- Backstop for the application's balance check: even a buggy code path cannot overdraw.
  constraint balance_non_negative check (allow_negative or balance >= 0)
);

create table transfers (
  seq             bigint generated always as identity unique,  -- stable order for history and cursors
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id),
  from_account_id uuid not null,
  to_account_id   uuid not null,
  amount          bigint not null check (amount > 0),
  currency        text not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 255),
  request_hash    text not null,
  description     text check (length(description) <= 500),
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  -- At most one transfer per key per tenant, whatever the application does.
  unique (tenant_id, idempotency_key),
  check (from_account_id <> to_account_id),
  -- A transfer can only reference accounts of its own tenant and its own currency,
  -- even from a connection that bypasses row-level security.
  foreign key (tenant_id, from_account_id, currency) references accounts (tenant_id, id, currency),
  foreign key (tenant_id, to_account_id, currency) references accounts (tenant_id, id, currency)
);

create index transfers_from_idx on transfers (tenant_id, from_account_id, seq);
create index transfers_to_idx on transfers (tenant_id, to_account_id, seq);

-- Row-level security -------------------------------------------------------------

-- NULL when no tenant is set. nullif handles the empty string that a transaction-scoped
-- set_config leaves behind after COMMIT on a pooled connection.
create function app_tenant_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

alter table tenants   enable row level security;
alter table accounts  enable row level security;
alter table transfers enable row level security;
alter table api_keys  enable row level security;  -- no policy: the app role sees nothing here

create policy tenant_isolation on tenants
  using (id = app_tenant_id());

create policy tenant_isolation on accounts
  using (tenant_id = app_tenant_id())
  with check (tenant_id = app_tenant_id());

create policy tenant_isolation on transfers
  using (tenant_id = app_tenant_id())
  with check (tenant_id = app_tenant_id());

-- API key lookup happens before the tenant is known, so it runs as the owner through
-- this function. The app role can call it but cannot read the api_keys table.
create function authenticate_api_key(p_key_hash bytea) returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select tenant_id from api_keys where key_hash = p_key_hash and revoked_at is null
$$;

-- Privileges for the app role ------------------------------------------------------

revoke all on function authenticate_api_key(bytea) from public;
grant execute on function authenticate_api_key(bytea) to ledger_app;

grant usage on schema public to ledger_app;
grant select on tenants to ledger_app;
grant select, insert on accounts to ledger_app;
grant update (balance) on accounts to ledger_app;  -- the only column the app may change
grant select, insert on transfers to ledger_app;   -- no update or delete: history is append-only
