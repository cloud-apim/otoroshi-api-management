// Schema of the two databases: application data, and Otoroshi events + analytics.
//
// The application side gets real tables because it carries heavy content, relations and reporting
// queries. An API has three objects with three lifetimes: the draft (mutable, one per api),
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
  -- ACL tags: user:<email>, team:<id>, role:<name>
  tags jsonb not null default '[]',
  -- installation administrator (bootstrap admins)
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

-- installation-level settings: the gateway, portal exposure, ingestion
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- the tenant: same word on every surface
create table workspaces (
  id text primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  -- the workspace portal: identity, theme, languages, self-signup
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
  -- the implicit one-person team of an individual developer
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

-- an api is a version: there is no level above it
create table apis (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  team_id text references teams(id) on delete set null,
  slug text not null,
  name text not null,
  version text not null default '1.0.0',
  description text not null default '',
  tags jsonb not null default '[]',
  -- catalogue visibility, never projected: public | authenticated | restricted
  visibility text not null default 'public',
  -- restricted visibility ACL, as tags: user:<email>, team:<id>, role:<name>
  acl jsonb not null default '[]',
  -- created (never published) | published | deprecated | archived
  lifecycle text not null default 'created',
  previous_version_id text references apis(id) on delete set null,
  -- the only editable object
  draft jsonb not null,
  draft_updated_at timestamptz not null default now(),
  draft_updated_by text,
  -- who owns the source of truth of this object: null = edited by hand
  managed_by text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug, version)
);

-- multilingual documentation pages of the draft. Frozen into the snapshot at publication.
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

-- immutable, dated, attributed publications. Append-only.
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

-- the deployment state references a snapshot, not an api. One row per deployment attempt.
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

-- groups the identity of a consumer, never its counters
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
  -- usage statement, terms acceptance, form answers: never projected
  request jsonb not null default '{}',
  -- reviewer, decision, message to the requester
  review jsonb not null default '{}',
  -- payment state and provider reference
  payment jsonb not null default '{}',
  dates jsonb not null default '{}',
  -- projection state on the gateway: status, otoroshi ids, error
  projection jsonb not null default '{}',
  -- transfer history
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

-- lifecycle audit trail, written by the admin api itself (changes and reads)
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

-- async, replayable product operations: a projection that cannot reach the gateway waits here
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
-- logins in flight (OIDC state, PKCE verifier, nonce): single use, short-lived
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
-- named compositions: a shared chain of Otoroshi plugins with its own lifecycle. The draft
-- is edited, a publication freezes an immutable version, and an api pins a version.
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
  {
    version: '0004_metadata_fields',
    sql: `
-- one metadata mechanism, the scope as a parameter: typed fields declared per workspace,
-- values stored on each object, never projected on the gateway
create table metadata_fields (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  scope text not null, -- workspace | api | plan | subscription | application
  key text not null,
  label text not null,
  type text not null default 'string', -- string | text | number | boolean | date | url | email | enum
  options jsonb not null default '[]',
  required boolean not null default false,
  -- subscription scope: asked to the requester in the subscription form; application scope: editable on the portal
  portal boolean not null default false,
  help text not null default '',
  position int not null default 0,
  unique (workspace_id, scope, key)
);
`,
  },
  {
    version: '0005_remote_catalogs',
    sql: `
-- remote catalogs: an external source of truth for a set of apis
create table remote_catalogs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null, -- http | git
  url text not null,
  ref text,           -- git branch or tag
  path text,          -- git sub directory
  headers jsonb not null default '{}',
  mode text not null default 'draft', -- draft | publish | deploy
  prune boolean not null default false,
  interval_seconds int not null default 300,
  enabled boolean not null default true,
  last_sync jsonb,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`,
  },
  {
    version: '0006_audit_exporters',
    sql: `
-- the audit trail leaves the product the way Otoroshi's events do: exporters. Each one keeps a
-- cursor on the trail, so a delivery is at least once and an unreachable target loses nothing.
create table audit_exporters (
  id text primary key,
  name text not null,
  workspace_id text references workspaces(id) on delete cascade, -- null: every workspace
  kind text not null default 'webhook',
  url text not null,
  headers jsonb not null default '{}',
  actions jsonb not null default '[]', -- action prefixes, empty: everything
  enabled boolean not null default true,
  batch_size int not null default 100,
  cursor bigint not null default 0,
  last_error text,
  last_delivery_at timestamptz,
  delivered bigint not null default 0,
  created_at timestamptz not null default now()
);
`,
  },
  {
    version: '0007_notifications_transfers',
    sql: `
-- in-app notifications, addressed to a team (every member sees them) or to a user
create table notifications (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  team_id text references teams(id) on delete cascade,
  user_id text references users(id) on delete cascade,
  face text not null default 'portal', -- portal | console
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_team on notifications(team_id, created_at desc);

-- a transfer waiting for someone: the consumer's consent, or the producer's decision
alter table subscriptions add column pending_transfer jsonb;
`,
  },
  {
    version: '0008_promotion',
    sql: `
-- a snapshot promoted from another installation: where it was published, and its digest
alter table api_snapshots add column origin jsonb;
`,
  },
  {
    version: '0009_notification_states',
    sql: `
-- a notification addressed to a team is read, and done, by each of its members on their own
create table notification_states (
  notification_id text not null references notifications(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  read_at timestamptz,
  done_at timestamptz,
  primary key (notification_id, user_id)
);
-- what was read so far was read for everyone it was addressed to
insert into notification_states (notification_id, user_id, read_at)
  select n.id, n.user_id, n.read_at from notifications n where n.read_at is not null and n.user_id is not null
  union
  select n.id, m.user_id, n.read_at from notifications n join team_members m on m.team_id = n.team_id where n.read_at is not null
on conflict do nothing;
`,
  },
  {
    version: '0010_managed_consumers',
    sql: `
-- an application or a subscription a Kubernetes resource describes: kubernetes:<namespace>/<kind>/<name>
alter table applications add column managed_by text;
alter table subscriptions add column managed_by text;
create index applications_managed_by on applications(managed_by) where managed_by is not null;
create index subscriptions_managed_by on subscriptions(managed_by) where managed_by is not null;
`,
  },
  {
    version: '0011_payments',
    sql: `
-- the payment connector of a workspace: its provider, its credentials, the secret of its webhook
alter table workspaces add column payments jsonb not null default '{}';
-- the billing account of a team at a provider: the team pays, the invoice groups its applications
create table payment_customers (
  team_id text not null references teams(id) on delete cascade,
  provider text not null,
  customer_ref text not null,
  created_at timestamptz not null default now(),
  primary key (team_id, provider)
);
-- the events of a provider, each handled once: a provider redelivers what it is not sure was received
create table payment_events (
  id text not null,
  provider text not null,
  workspace_id text references workspaces(id) on delete cascade,
  type text not null,
  subscription_id text,
  received_at timestamptz not null default now(),
  outcome text,
  error text,
  data jsonb not null default '{}',
  primary key (provider, id)
);
create index payment_events_workspace on payment_events(workspace_id, received_at desc);
`,
  },
  {
    version: '0012_payments_connect',
    sql: `
-- the payments go through Stripe Connect: a workspace links its own Stripe account (its id only),
-- and the events of every linked account come on one endpoint
alter table payment_events add column account text;
alter table payment_events add column processed_at timestamptz;
`,
  },
  {
    version: '0013_catalog_options',
    sql: `
-- what a kind of catalog needs beside its url: the endpoint and the region of an object store
alter table remote_catalogs add column options jsonb not null default '{}';
`,
  },
  {
    version: '0014_metadata_translations',
    sql: `
-- the label and the help of a metadata field in other languages: { "fr": { "label": …, "help": … } }
alter table metadata_fields add column translations jsonb not null default '{}';
`,
  },
  {
    version: '0015_discovery',
    sql: `
-- the catalogue as a discovery system: the editorial placement of an api (its categories, chosen
-- among the ones of its workspace, and whether it is featured), and the reviews of its consumers
alter table apis add column categories jsonb not null default '[]';
alter table apis add column featured boolean not null default false;
create table api_reviews (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  -- an api across its versions
  api_slug text not null,
  user_id text not null references users(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text not null default '',
  hidden boolean not null default false,
  hidden_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, api_slug, user_id)
);
`,
  },
  {
    version: '0016_usage_reports',
    sql: `
-- the usage of the subscriptions to a plan with a usage price, pushed to the meter of the payment
-- provider in batches: one report per subscription and batch of calls (by id, like the rollups),
-- sent once — its id is the identifier the provider dedupes on — and replayed until it is
create table usage_reports (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  subscription_id text not null references subscriptions(id) on delete cascade,
  plan_id text not null,
  from_id bigint not null,
  to_id bigint not null,
  value bigint not null,
  meter_event_name text not null,
  account text,
  customer text,
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (subscription_id, to_id)
);
create index usage_reports_pending on usage_reports(created_at) where status = 'pending';
`,
  },
  {
    version: '0017_dictionaries',
    sql: `
-- the dictionaries of a workspace: a named set of values, static or refreshed from an external
-- source, given to the expression language of the gateway (its global env, under apim.dictionaries)
create table dictionaries (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  description text not null default '',
  source jsonb not null default '{"kind": "static"}',
  entries jsonb not null default '{}',
  refreshed jsonb not null default '{}',
  projection jsonb not null default '{}',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
`,
  },
  {
    version: '0018_resources',
    sql: `
-- the resources of a workspace: a dependency a plan consumes — an authorization server — named,
-- versioned like a shared policy group, referenced by the plans by a pinned version
create table resources (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  description text not null default '',
  kind text not null,
  draft jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table resource_versions (
  id text primary key,
  resource_id text not null references resources(id) on delete cascade,
  number int not null,
  content jsonb not null,
  comment text not null default '',
  published_by text,
  published_at timestamptz not null default now(),
  unique (resource_id, number)
);
`,
  },
];

export const analyticsMigrations = [
  {
    version: '0001_init',
    sql: `
-- the computed path: mandatory and exhaustive, attributed to the catalogue at ingestion
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

-- AI and MCP usage: collected from day one although the features are out of the MVP
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

-- the raw path: optional, where sampling and masking belong
create table raw_events (
  id bigserial primary key,
  at timestamptz not null,
  type text not null,
  payload jsonb not null
);
create index raw_events_at on raw_events(at);
`,
  },
  {
    version: '0002_rollups_and_retention',
    sql: `
-- the computed path, kept longer than its calls: hourly rollups, one row per hour and grain. The
-- dimensions are never null ('' for none), so that a grain is a key; the durations are a histogram
-- (bucket of DURATION_BOUNDS -> calls), the percentiles are read from it
alter table calls add column path_template text;
alter table calls add column received_at timestamptz not null default now();
create index calls_at on calls(at);
alter table ai_usage add column received_at timestamptz not null default now();

create table call_rollups (
  hour timestamptz not null,
  workspace_id text not null default '',
  api_id text not null default '',
  plan_id text not null default '',
  subscription_id text not null default '',
  application_id text not null default '',
  method text not null default '',
  path text not null default '',
  status_class int not null default 0,
  calls bigint not null,
  errors bigint not null,
  duration_sum bigint not null,
  overhead_sum bigint not null,
  bytes_in bigint not null,
  bytes_out bigint not null,
  durations jsonb not null default '{}',
  primary key (hour, workspace_id, api_id, plan_id, subscription_id, application_id, method, path, status_class)
);
create index call_rollups_ws_hour on call_rollups(workspace_id, hour);

create table ai_rollups (
  hour timestamptz not null,
  workspace_id text not null default '',
  api_id text not null default '',
  subscription_id text not null default '',
  type text not null default '',
  provider text not null default '',
  model text not null default '',
  tool text not null default '',
  events bigint not null,
  input_tokens bigint not null,
  output_tokens bigint not null,
  cost_micro_usd bigint not null,
  primary key (hour, workspace_id, api_id, subscription_id, type, provider, model, tool)
);

-- how far the rollups went: the last id rolled up, per table
create table rollup_state (
  name text primary key,
  last_id bigint not null default 0,
  updated_at timestamptz not null default now()
);
`,
  },
  {
    version: '0003_security_events',
    sql: `
-- the security events of the Threat Protection Suite (CloudApimSecurityEvent), attributed to the
-- catalogue like the calls: the api from the event, the plan, the subscription and the application
-- from the key that called when there was one
create table security_events (
  id bigserial primary key,
  at timestamptz not null,
  received_at timestamptz not null default now(),
  workspace_id text,
  api_id text,
  otoroshi_api_id text,
  route_id text,
  plan_id text,
  subscription_id text,
  application_id text,
  client_id text,
  category text not null,
  action text not null,
  outcome text,
  severity int,
  score int,
  from_ip text,
  incident_id text,
  message text,
  payload jsonb not null default '{}'
);
create index security_events_ws_at on security_events(workspace_id, at);
create index security_events_at on security_events(at);
`,
  },
  {
    version: '0004_calls_host',
    sql: `
-- the host a call was made on (the domain of the api, or a vault reference resolved by the gateway)
alter table calls add column host text;
`,
  },
];
