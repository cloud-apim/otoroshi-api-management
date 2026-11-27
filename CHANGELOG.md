# Changelog

The notes of each release: the section of a version is the body of its GitHub release
(`.github/workflows/release.yaml`).

## Unreleased

- **Webhooks.** The events of a workspace — what its audit trail records — sent to the endpoints its
  administrators declare, each one taking the types it names (**Workspace settings › Webhooks**, the
  admin API, `otoroshi-apim webhooks`): signed as Standard Webhooks, tried again at 5 s, 5 min, 30 min,
  2 h, 5 h, 10 h and 10 h, then kept 30 days and replayed by hand, the administrators told; an endpoint
  answering 410 or failing for five days turned off; private networks refused unless allowed.

- **Email.** The notifications of a workspace sent by email, once its administrators turn it on —
  to the people of its portal, to its producers, kind by kind (**Workspace settings › Email**) —,
  through the transport of the installation: SMTP, Mailgun, Mailjet or SendGrid (**Global settings ›
  Email**, or `APIM_EMAIL_*`), with a test email and the list of the emails sent.

- **Announcements of an API**, like a blog: posts on its page in the portal, for all its versions,
  its subscribers told in their notifications (console, admin API, `otoroshi-apim announcements`).
  A version deprecated or archived is told to its subscribers too.

- **The usage in finer grain.** On the portal, the usage of one key — a filter of the analytics and
  the request log, and **Usage of this key** on each subscription —, and its history set per portal
  (**Developer portal › Settings › Usage history**: 90 days by default, up to the retention of the
  rollups). In the console, the dashboards and the request log filtered by an endpoint of the API —
  a method and a templated path —, from the calls and from the rollups.

## 0.1.1 — beta

The beta on the release of Otoroshi 18.1: one API key for every API of an application, the requests
to review easier to reach, a person deleted on request, a quickstart and a tutorial played as written.

### What it needs

- **[Otoroshi 18.1](https://github.com/MAIF/otoroshi/releases/tag/v18.1.0)** or later, the jar of its release — no longer a build of its
  `master` — and an admin key with every right.
- **PostgreSQL 14** or later, two databases, as for 0.1.0.
- Its extensions, optional: the **Threat Protection Suite 1.1.0** and the **LLM extension 0.0.91**
  or later, built for Otoroshi 18.1 — the earlier releases do not start on it.

### What changes

- **One API key for every API of an application**: its subscriptions to apikey plans share one
  client id and one secret, each with the quotas, the restrictions and the plugins of its own plan —
  nothing pooled. Chosen on the application (console, portal, admin API `shared_credential`, the
  Kubernetes `Application`), for the subscriptions made from then on; a new secret is taken by
  every API, suspending or closing a subscription cuts its API only.
- **The subscription requests to review lead to themselves** in the console: a notice above the list
  of APIs, the *pending* badge of an API opening its requests, a notice on the page of the API and a
  count on its Subscriptions tab. A request to an API of no team is notified to the administrators
  of its workspace — it was notified to nobody.
- **A person can be deleted** by an installation administrator — Global settings › Users,
  `DELETE /api/users/<id or email>`, `otoroshi-apim users delete` —, with their personal
  applications, whose keys the gateway revokes.
- **The documentation**: a quickstart that makes an installation as in production, a tutorial end to
  end — a producer exposes an API, a consumer subscribes and calls it —, a page for the development
  of the product.

### Fixed

- A producer could adopt an API of the gateway into a team that is not theirs.
- A subscription deleted from the product while the gateway was unreachable kept its key working on
  the gateway: it is removed once the gateway answers.
- `otoroshi-apim subscriptions transfer` announced the new plan of a move that waits for the
  consumer's consent or for a payment: it says it waits.
- The documentation checked the extensions with `sha256sum -c`, which cannot read their checksum
  files (the digest alone): its commands build the line to check.

### Known limitations

- **REST APIs only.** The other types — event-driven, MCP, AI, then GraphQL and gRPC — come next.
- **The Threat Protection Suite** has four gaps open
  ([waf#60 to #63](https://github.com/cloud-apim/otoroshi-waf-extension/issues)): the known
  limitations of the documentation say what the product does meanwhile.
- The accessibility of the console and the portal has not been audited.

### Upgrades

From 0.1.0: the gateway on the release of Otoroshi 18.1, then the new executable or image — its
migrations run at start, in place. The applications keep one key per subscription until they choose
one key for every API.

## 0.1.0 — beta

The first release, for beta testers: the API management console and the developer portal of
Otoroshi, one executable or one image, with its documentation.

### What it needs

- **Otoroshi 18.1** — until it is released, built from the `master` branch of Otoroshi — and an
  admin key with every right.
- **PostgreSQL 14** or later, two databases created beforehand (the application, the analytics).
- Its documentation is attached to the release (`otoroshi-api-management-docs-0.1.0.zip`): a static
  site, served from its root by any static web server (`python3 -m http.server`, its `README.txt`).
- The configuration of the documentation, *Install › Configuration*: an instance that lacks a
  variable it needs names it and does not start. `DEV=true` is for the development stack of the
  repository only.

### What it does

- **APIs as products**: a draft, published as immutable snapshots, deployed to the gateway —
  routes, backends, flows of plugins, versions, deprecation, rollback by redeploying a snapshot.
- **Plans**: keyless, API key, JWT, OAuth2 (local and remote) and mTLS; quotas and rate limits,
  resource filters, selection by claims, approval, visibility, terms; shared policy groups and
  shared resources pinned by version; dictionaries.
- **Consumers**: applications, subscriptions and their credentials, approval workflows, end dates,
  moves between plans; paid plans through Stripe Connect.
- **The developer portal**, one per workspace: the catalogue and its discovery (categories,
  reviews, usage), the documentation and its reference (OpenAPI, AsyncAPI), *try it*,
  subscriptions, credentials, usage; its design — a theme, a home of blocks, pages written as
  Markdoc templates, previewed before they are published.
- **Observability**: the events of the gateway ingested and attributed to APIs, plans and
  applications, pseudonymised, rolled up and kept by retention; dashboards, the request log and
  its export, the security events of the Threat Protection Suite, the AI and MCP audits kept.
- **Administration by program**: the admin API (the console is its client), the CLI, declarative
  documents, remote catalogs from git, S3 or HTTP, Kubernetes resources and their controller,
  promotion of snapshots between installations.
- **Operations**: workspaces, teams and roles, sign-in with OpenID Connect, an audit trail and its
  exporters, secrets sealed at rest, drift detection and adoption of existing Otoroshi APIs, the
  setup of the gateway (the product's key, the data exporter, the routes of the console and the
  portals); instances split by role; the Helm chart and Kubernetes manifests.

### Known limitations

- **REST APIs only.** The other types — event-driven, MCP, AI, then GraphQL and gRPC — come next.
- **One credential per subscription**: a key cannot serve the subscriptions of a consumer to
  several APIs yet (Otoroshi, [#2964](https://github.com/MAIF/otoroshi/issues/2964)).
- **The extensions of the gateway** must be built for the same Otoroshi: the Threat Protection
  Suite and the LLM extension released so far do not run on Otoroshi `master`. Without them, a plan
  that asks for the threat protection is warned, and no AI or MCP audit comes in. With the
  extension, four gaps of the threat protection are open
  ([waf#60 to #63](https://github.com/cloud-apim/otoroshi-waf-extension/issues)).
- The accessibility of the console and the portal has not been audited.

### Upgrades

The migrations run at start. From this release on, a migration that shipped is never changed: a
later release migrates the databases of this one in place.
