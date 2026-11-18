// Schema of the two databases (D-8): application data, and Otoroshi events + analytics.
//
// The application side gets real tables because it carries heavy content, relations and reporting
// queries. An API has three objects with three lifetimes (D-35): the draft (mutable, one per api),
// the snapshots (immutable, append-only) and the deployment state (which snapshot runs on the gateway).

export const appMigrations = [
  {
    version: '0001_init',
    sql: `
create table users (
  id text primary key,
  email text not null unique,
  name text not null,
  password_hash text,
  -- ACL tags: user:<email>, team:<id>, role:<name> (spec §6)
  tags jsonb not null default '[]',
  -- installation administrator (bootstrap admins, D-25)
  is_admin boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  kind text not null, -- backoffice | portal
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table api_tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz
);

-- installation-level settings: the gateway (D-37), portal exposure (D-20), ingestion
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- the tenant (D-19): same word on every surface
create table workspaces (
  id text primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  -- the workspace portal: identity, theme, languages, self-signup (D-20)
  portal jsonb not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null, -- admin | producer | consumer
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table teams (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  description text not null default '',
  -- the implicit one-person team of an individual developer (Q-1)
  personal boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table team_members (
  team_id text not null references teams(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'member', -- owner | member
  primary key (team_id, user_id)
);

-- an api is a version (D-29): there is no level above it
create table apis (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  team_id text references teams(id) on delete set null,
  slug text not null,
  name text not null,
  version text not null default '1.0.0',
  description text not null default '',
  tags jsonb not null default '[]',
  -- catalogue visibility, never projected (D-2): public | authenticated | restricted
  visibility text not null default 'public',
  -- restricted visibility ACL, as tags: user:<email>, team:<id>, role:<name>
  acl jsonb not null default '[]',
  -- created (never published) | published | deprecated | archived
  lifecycle text not null default 'created',
  previous_version_id text references apis(id) on delete set null,
  -- the only editable object (D-35)
  draft jsonb not null,
  draft_updated_at timestamptz not null default now(),
  draft_updated_by text,
  -- who owns the source of truth of this object (D-28): null = edited by hand
  managed_by text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug, version)
);

-- multilingual documentation pages of the draft (D-11). Frozen into the snapshot at publication.
create table api_doc_pages (
  id text primary key,
  api_id text not null references apis(id) on delete cascade,
  parent_id text,
  slug text not null,
  position int not null default 0,
  title jsonb not null default '{}',   -- { "<lang>": "title" }
  content jsonb not null default '{}', -- { "<lang>": "markdown" }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (api_id, slug)
);

-- immutable, dated, attributed publications (D-35). Append-only.
create table api_snapshots (
  id text primary key,
  api_id text not null references apis(id) on delete cascade,
  number int not null,
  content jsonb not null,
  comment text not null default '',
  published_by text,
  published_at timestamptz not null default now(),
  unique (api_id, number)
);

-- the deployment state references a snapshot, not an api (D-35). One row per deployment attempt.
create table api_deployments (
  id text primary key,
  api_id text not null references apis(id) on delete cascade,
  snapshot_id text references api_snapshots(id) on delete set null,
  action text not null default 'deploy', -- deploy | undeploy
  status text not null, -- pending | deployed | failed
  requested_by text,
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  result jsonb not null default '{}'
);

-- groups the identity of a consumer, never its counters (D-26, D-31)
create table applications (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  team_id text not null references teams(id) on delete cascade,
  name text not null,
  description text not null default '',
  -- expected client_id for oauth2 / mtls plans: the only way to reconcile what the gateway sees
  client_id text,
  certificates jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- (application x plan) -> state + credentials
create table subscriptions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  api_id text not null references apis(id) on delete cascade,
  plan_id text not null,
  application_id text not null references applications(id) on delete cascade,
  auth_kind text not null,
  -- pending | pending_payment | active | rejected | suspended | closed
  status text not null,
  -- usage statement, terms acceptance, form answers: never projected (D-2)
  request jsonb not null default '{}',
  -- reviewer, decision, message to the requester
  review jsonb not null default '{}',
  -- payment state and provider reference (D-36)
  payment jsonb not null default '{}',
  dates jsonb not null default '{}',
  -- projection state on the gateway: status, otoroshi ids, error
  projection jsonb not null default '{}',
  -- transfer history (D-30)
  history jsonb not null default '[]',
  metadata jsonb not null default '{}',
  requested_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table credentials (
  id text primary key,
  subscription_id text not null references subscriptions(id) on delete cascade,
  application_id text not null references applications(id) on delete cascade,
  kind text not null, -- apikey | client_credentials
  client_id text not null,
  client_secret text,
  status text not null default 'active', -- active | revoked
  otoroshi jsonb not null default '{}',
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);
create index credentials_client_id on credentials(client_id);

-- lifecycle audit trail, written by the admin api itself (spec §8: changes and reads)
create table audit_events (
  id bigserial primary key,
  workspace_id text,
  at timestamptz not null default now(),
  actor jsonb not null default '{}',
  action text not null,
  entity_kind text,
  entity_id text,
  summary text not null default '',
  data jsonb not null default '{}',
  ip text
);
create index audit_events_ws_at on audit_events(workspace_id, at desc);

-- async, replayable product operations (D-4): a projection that cannot reach the gateway waits here
create table tasks (
  id text primary key,
  kind text not null,
  payload jsonb not null default '{}',
  dedupe_key text,
  status text not null default 'pending', -- pending | running | done | failed
  attempts int not null default 0,
  last_error text,
  run_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_pending on tasks(status, run_after);

-- the result of the last drift detection run, per projected object
create table drift_reports (
  id text primary key,
  workspace_id text,
  entity_kind text not null,
  entity_id text not null,
  otoroshi_kind text not null,
  otoroshi_id text not null,
  status text not null, -- in_sync | drifted | missing | unmanaged
  diff jsonb not null default '[]',
  checked_at timestamptz not null default now(),
  unique (entity_kind, entity_id, otoroshi_kind, otoroshi_id)
);
`,
  },
  {
    version: '0002_auth_states',
    sql: `
-- logins in flight (OIDC state, PKCE verifier, nonce): single use, short-lived (D-25)
create table auth_states (
  id text primary key,
  data jsonb not null,
  expires_at timestamptz not null
);
`,
  },
  {
    version: '0003_policy_groups',
    sql: `
-- named compositions (D-16): a shared chain of Otoroshi plugins with its own lifecycle. The draft
-- is edited, a publication freezes an immutable version, and an api pins a version (D-35).
create table policy_groups (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  description text not null default '',
  draft jsonb not null default '{"plugins": []}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table policy_group_versions (
  id text primary key,
  group_id text not null references policy_groups(id) on delete cascade,
  number int not null,
  plugins jsonb not null,
  comment text not null default '',
  published_by text,
  published_at timestamptz not null default now(),
  unique (group_id, number)
);
`,
  },
];

export const analyticsMigrations = [
  {
    version: '0001_init',
    sql: `
-- the computed path (D-33): mandatory and exhaustive, attributed to the catalogue at ingestion
create table calls (
  id bigserial primary key,
  at timestamptz not null,
  req_id text,
  workspace_id text,
  api_id text,              -- product api
  otoroshi_api_id text,
  route_id text,
  plan_id text,
  subscription_id text,
  application_id text,
  client_id text,
  method text,
  path text,
  status int,
  duration_ms int,
  overhead_ms int,
  backend_duration_ms int,
  bytes_in bigint,
  bytes_out bigint,
  err boolean not null default false,
  from_ip text,
  user_agent text
);
create index calls_api_at on calls(api_id, at);
create index calls_sub_at on calls(subscription_id, at);
create index calls_app_at on calls(application_id, at);
create index calls_ws_at on calls(workspace_id, at);

-- AI and MCP usage: collected from day one although the features are out of the MVP (D-32)
create table ai_usage (
  id bigserial primary key,
  at timestamptz not null,
  type text not null, -- LLMUsageAudit | McpAudit
  workspace_id text,
  api_id text,
  client_id text,
  subscription_id text,
  provider text,
  model text,
  tool text,
  input_tokens bigint,
  output_tokens bigint,
  cost_micro_usd bigint,
  payload jsonb not null default '{}'
);
create index ai_usage_at on ai_usage(at);

-- the raw path (D-33): optional, where sampling and masking belong
create table raw_events (
  id bigserial primary key,
  at timestamptz not null,
  type text not null,
  payload jsonb not null
);
create index raw_events_at on raw_events(at);
`,
  },
];
