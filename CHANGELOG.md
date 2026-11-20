# Changelog

The notes of each release: the section of a version is the body of its GitHub release
(`.github/workflows/release.yaml`).

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
  several APIs yet (Otoroshi, [#2963](https://github.com/MAIF/otoroshi/issues/2963)).
- **The extensions of the gateway** must be built for the same Otoroshi: the Threat Protection
  Suite and the LLM extension released so far do not run on Otoroshi `master`. Without them, a plan
  that asks for the threat protection is warned, and no AI or MCP audit comes in. With the
  extension, four gaps of the threat protection are open
  ([waf#60 to #63](https://github.com/cloud-apim/otoroshi-waf-extension/issues)).
- The accessibility of the console and the portal has not been audited.

### Upgrades

The migrations run at start. From this release on, a migration that shipped is never changed: a
later release migrates the databases of this one in place.
