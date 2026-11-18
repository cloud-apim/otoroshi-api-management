# Progress

Where the implementation of [`otoroshi-api-management-specs`](../otoroshi-api-management-specs)
stands, decision by decision, and **what remains to implement against the spec**.
**Kept up to date with every commit.**

Legend: ✅ done and verified · 🟡 partial · ⬜ to do · ➖ not applicable / out of the MVP
Sizes: **S** a few hours · **M** one or two days · **L** several days.

Last update: 2026-11-18.

---

## Now

- Nothing in progress: the next item is the first one of the order below.

## Next, in the proposed order

1. **R-6** — Kubernetes: manifests, Helm chart, CRDs (D-28).
2. **R-7** — Stripe connector (D-36, Q-12).
3. **R-8** — raw path retention, sampling, pseudonymisation (D-33, Q-8).
4. **R-41** — a setup mode of the binary, given an Otoroshi admin api key (D-14).

The full list, grouped by area, is in [What remains to implement](#what-remains-to-implement).

## Known issues

- Demo data: the `default` workspace declares a required plan metadata field `sla` (a D-18 demonstration); the plans of Books and Petstore fill it.

---

## What remains to implement

Everything below is grounded in the product decisions (`D-n`), their open questions (`Q-n`) and the
topics not drafted yet. Items that depend on a
fix in Otoroshi cite the gap (`G-n`, see [`OTOROSHI-GAPS.md`](./OTOROSHI-GAPS.md)): the product
waits for the data plane rather than working around it.

### Model and projection

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-9 | D-15, Q-6 | The **object-by-object inventory** of Otoroshi entities: derived from the api description, or infrastructure consumed as is — a written table checked against the Otoroshi source | S | |
| R-10 | D-16 | Named compositions, the two remaining ones: **resources** (an OAuth2 server, a token cache, a directory a policy consumes, referenced by the plan) and **dictionaries** (named value sets refreshed from an external source, injected in the expression language) | L | |
| R-12 | §4, D-31 | A **credential covering several subscriptions** (one key for several apis of the same consumer, `authorizedEntities` on several apis) — the model's "parent / child" credential; quotas stay per credential | M | |
| R-13 | §4 | Subscription **expiry** (`ending_at`): a subscription that ends at a date, keys disabled then | S | G-14 for a validity per key |
| R-14 | §4, G-6 | Enforce the **selection rule**, **counter failure strategy** and **circuit breaker granularity** of a plan — stored and projected as metadata today | — | G-6 |
| R-15 | D-6, G-4 | Require a **subscription on jwt / mtls / oauth2-remote / keyless plans** — today any valid token passes | — | G-4 |
| R-16 | G-13 | Keep the consumers of a **deprecated plan** served (only published plans get an extractor) | — | G-13 |
| R-17 | §5 | **Adopt mode**, second half: take over the existing subscriptions and apikeys of an adopted Api, not only its description | M | |
| R-18 | D-41 | **Token and budget plans**: project `LlmTokensRateLimitingValidator` and `AiBudget` (the schema is ready, the feature is out of the MVP, D-32) | M | ➖ |

### Developer portal

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-19 | §8 | **Portal templates**: customer templates edited in the console or synchronised from files, beyond the default template and its theme settings | L | |
| R-20 | §8 | **Catalogue as a discovery system**: editorial categories and featured apis, consumer reviews, real usage — today search and tags only | M | |
| R-21 | §8 | **Dynamic client registration** at the IdP when an application is created, with the security posture of the client type | M | |
| R-22 | D-11, D-18 | Metadata field **labels and help in several languages** (one language today) | S | |
| R-23 | D-17 | Testing on the portal is Scalar's; D-17 wants **one composer** for both faces — use the shared composer on the portal for apis without an OpenAPI specification | S | |
| R-42 | D-11 | **Pages of the portal** beyond its home: pages a workspace writes (multilingual markdown, like the home and the documentation pages), in the portal's navigation | S | |

### Console

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-45 | D-11 | The **messages of the admin api** in the language of the console: its errors and the validation warnings (plans, deployments, promotions) are in English | M | |
| R-24 | D-17, G-12 | The console replay **with the policy execution trace** | S once G-12 is fixed | G-12 |
| R-25 | D-10 | **Threat protection**: configure the Threat Protection Suite per plan from a dedicated screen (possible today as plan plugins), and render its security events in observability | M | D-10 notes: plan-level attribution of `CloudApimSecurityEvent` |
| R-26 | D-27 | Validate with the owner where the gateway health, the projection state and the drift live (proposed: bottom of the sidebar + a Gateway page) | — | |

### Industrialisation (GitOps, environments, operations)

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-6 | D-28 | **Kubernetes**: deployment manifests and a Helm chart; **CRDs** for the product's own entities (Api document, applications, subscriptions) with a controller | L | |
| R-27 | D-28 | Remote catalogs from an **object store** (S3) — http and git exist | S | |
| R-28 | Q-11 | The declarative format is implemented (one document per api-version, plans inside, pages beside) — **to validate by the owner** before it becomes a contract | — | |
| R-29 | D-36 "to instruct" | Two answers implemented, **to validate by the owner**: publishing a shared policy group does not republish the apis (they pin a version); a remote catalog chooses per catalog whether it writes drafts, publishes or deploys | — | |
| R-30 | §3 | Run the roles **split across instances** (ingester alone, portal alone…) and with several instances of a role — the task queue claims atomically, never tested | S | |
| R-41 | D-14, D-15 | A **setup mode** of the binary (`apim setup`, given an Otoroshi admin api key): creates or repairs everything the product needs on the gateway, idempotently, all of it or a part (`--only exporter,routes,…`), re-runnable at will and with `--dry-run` showing the diff first. Parts: the product's own admin api key on Otoroshi (narrowed rights), the data exporter to the ingester, the routes that expose the console and each portal (hostnames of R-3, TLS, the info-token auth module and its route for the "via Otoroshi" console login), the shared certificates the product relies on (key pair for `oauth2-local`), a health check of what it found (version, cluster, listener asking for client certificates for mtls plans). Marked like every product entity, reported in the gateway status | M | |

### Analytics and audit

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-8 | D-33, Q-8 | **Raw path**: retention, sampling, lightening policy; **pseudonymisation** of personal data (ip, email, identifiers); what the computed path aggregates and at which granularity (rollups) | M | or upstream in the data exporters |
| R-31 | D-32 | Verify **LLMUsageAudit and McpAudit** ingestion with real events from the LLM extension (coded, never fed) | S | |
| R-32 | §8 | A **correlation id** carried beyond the gateway, to follow a request through the backends | S | |
| R-33 | §8, G-7 | Tie Otoroshi's deployment history to the product snapshot from the gateway side | — | G-7 |

### Monetisation

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-7 | D-36, Q-12 | A **payment connector** behind a narrow interface, Stripe Checkout first: checkout session, idempotent signed webhooks (`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed` → grace → suspension, `customer.subscription.deleted`), periodic reconciliation with the provider, customer portal link — a test connector stands in today | L | |
| R-34 | D-36 | **Usage-based billing**: push the computed counters per subscription in batches (Stripe Billing Meters); refuse a usage plan on a connector that cannot meter | M | R-7 |
| R-35 | Q-12 | Who holds the billing account (team, proposed) and whether monetisation is in the MVP — **owner decision** | — | |

### Robustness and security

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-36 | D-9, D-24 | **Secrets at rest**: credential secrets, IdP secrets and catalog tokens are stored in clear in the product database — encrypt them, or reference a vault | M | |
| R-37 | — | An **accessibility** audit of both faces (labels and focus are there, no audit done) | M | |
| R-38 | — | **UI tests**: the screens tour exercises every screen without assertions; the API is covered by tests, the UI is not | M | |
| R-39 | D-25 | Test the **Otoroshi authentication mode** end to end behind a real route with an auth module (unit-tested only) | S | |

### Out of the MVP, by decision (kept for later)

| # | Spec | Item |
|---|---|---|
| — | D-32 | AI and MCP apis as product types (the events are captured from day one) |
| — | D-32, D-34 | Event-driven apis — needs per-message events in the event-brokers extension first |
| — | D-32, Q-7 | Api scoring, quality review before publication |

---

## Status by spec decision

| Decision | Status | Where / how it is verified |
|---|---|---|
| D-1 Otoroshi's `Api` entity | ✅ | `server/otoroshi/projection.js`; reference catalogue test |
| D-2 selective synchronisation | ✅ | docs, terms, usage statements, pricing, metadata never projected; `test/model.test.js` |
| D-3 the api created end to end, routes included | ✅ | resources → routes, backends, flows: plugins named and configured from the gateway's catalog (default configuration, order, regex paths), plan flows; configuration as a form generated from the catalog's form description (`config_schema` / `config_flow`) or as JSON; JSON, YAML and Markdown (documentation pages, portal home) in a code editor (Monaco, bundled, loaded on first use) |
| D-4 never in the request path | ✅ | replayable task queue `server/domain/tasks.js`; `test/product-down.test.js`: with the product and its databases stopped, keys, tokens and quotas are enforced by the gateway alone; with the gateway unreachable, the portal serves its catalogue and a subscription waits, then is projected |
| D-5 the policy lives in the plan | ✅ | plan editor; limits and filtering projected on the plan |
| D-6 a subscription is an apikey | ✅ | `apiRef` + `id_ref` verified on the gateway — limits: G-1, G-4, G-17; the consumers minted for a plan are keyed by its id alone (G-18): warning `plan_id_shared` on the draft and the deployment (`test/shared-plan-ids.test.js`) |
| D-8 PostgreSQL ×2 | ✅ | `server/db/migrations.js` |
| D-9 n°1 everything the UI does goes through the API | ✅ | the same router on `/api` and `/backoffice/api` |
| D-9 n°2 escape hatch to the projected entity | ✅ | "Technical details", link to the Otoroshi backoffice |
| D-9 n°3 nothing essential hidden | ✅ | warnings: open routes, any token passes, attributes not enforced, deprecated plans, resolution order |
| D-9 n°4 reversibility | ✅ | export / import ✅; uninstalling leaves a working configuration, taken over by hand with Otoroshi alone (revoke, subscribe, change a plan, remove the marker) — `test/product-down.test.js`, documented in *When the product is down* |
| D-9 n°5 Apache 2.0 | ✅ | `LICENSE`, `NOTICE` |
| D-10 WAF in the extension | 🟡 | usable as plugins in a flow or a policy group; no dedicated screen: R-25 |
| D-11 i18n | 🟡 | multilingual docs ✅, portal en/fr ✅, the portal's texts (title, tagline, home) per language ✅, console en/fr ✅ (texts keyed by their English, `mise run check` fails on a text without French); the admin api's messages in English: R-45; metadata labels: R-22; more portal pages: R-42 |
| D-12 light / dark / system | ✅ | console and portal |
| D-14 no need to open Otoroshi | 🟡 | complete APIM; certificates and auth modules derived; the gateway's own settings (TLS client auth, exposure routes): R-41 |
| D-15 derived objects | 🟡 | JWT verifiers ✅ derived from the plan description (JWKS or HMAC, iss, aud), marked, in the deployment diff and the drift, removed with the api — reference catalogue test; trusted CAs of mtls plans ✅ derived as certificates (issuer pattern derived from them when none is given), auth modules of oauth2-remote plans ✅ derived from the described authorization server (with discovery); both marked, in the deployment diff and the drift, removed after the Api — `test/derived-objects.test.js` against the real gateway, a token of the dev IdP passing; client certificates of applications ✅ derived while an mtls subscription is active; inventory: R-9 |
| D-16 named compositions | 🟡 | shared policy groups ✅ (pinned versions, upgrade); resources and dictionaries: R-10 |
| D-17 testing | 🟡 | portal (Scalar + proxy) ✅; console ✅ without the policy trace (G-12, R-24); one composer: R-23 |
| D-18 typed metadata, one mechanism | ✅ | 5 scopes, request form, publication blocked by a missing required field |
| D-19 workspace + teams, global users | ✅ | an admin only sees the members of its workspaces |
| D-20 one portal per workspace, resolved from the url | ✅ | by root path, by hostname, or one workspace at the root (`APIM_TENANCY=single`: no prefix, no selector); the forms served before are recorded and their urls redirected (`301`/`308`) to the same page — `test/portal-exposure.test.js`, `test/portal-forms.test.js`; `portal_url` given by the admin api |
| D-22 described / deployed state, diff before acting | ✅ | dry-run before every deployment |
| D-24 `default` location + ownership marking | ✅ | |
| D-25 authentication | ✅ | OIDC console and portal verified against a dev IdP; Otoroshi mode unit-tested: R-39 |
| D-26 application, expected `client_id`, `id_ref` | ✅ | client certificates read and checked (console and portal), derived as certificates of the gateway while an mtls subscription is active (`test/derived-objects.test.js`); a subscription of a token or certificate plan carries no consumer identity on Otoroshi (G-17, MAIF/otoroshi#2937): its ApiSubscription carries the application's client id as metadata meanwhile |
| D-27 console navigation | ✅ | gateway status at the bottom of the sidebar (left open by D-37: R-26): failed projections, waiting ones and drift counted apart, leading to the first of them; a failed task says what it works on, is retried or dismissed, and dismissed by itself when its object is gone |
| D-28 administrable by program | 🟡 | admin API ✅, CLI ✅, remote catalogs http/git ✅; CRDs and Kubernetes: R-6; object store: R-27 |
| D-29 a version is a new api | ✅ | |
| D-30 transfer to an equivalent plan | ✅ | same key, same history; a degrading move waits for the consumer's consent; a consumer asks, the producer applies; in-app notifications, read and marked done by each person (a page lists them all) — `test/queue-and-notifications.test.js` |
| D-31 no aggregated quota | ✅ | multi-api credential: R-12 |
| D-32 MVP scope, captured events | 🟡 | GatewayEvent verified with real traffic; LLMUsageAudit and McpAudit: R-31 |
| D-33 two storage paths | 🟡 | computed + raw with url masking ✅; retention, sampling, pseudonymisation: R-8 |
| D-35 draft → immutable snapshot | ✅ | rollback = redeploying a snapshot |
| D-36 ready for monetisation | 🟡 | schema ✅, test connector ✅; Stripe: R-7, usage billing: R-34 |
| D-37 one installation, one cluster | ✅ | promotion to the next installation: a snapshot exported as a document (its digest, without what names the api locally), taken by the next installation as one of its own snapshots — dry run (diff with what runs, gateway changes, vault references resolved or not), deploy, draft replaced; the values of each environment are Otoroshi vault references — `test/promotion.test.js` between two installations |
| D-38 catalog-marked projection | ✅ | Otoroshi records each deployment |
| D-39 hand-written CSS | ✅ | chart palette validated |
| D-41 unit of measure of a plan | ✅ | tokens / budget refused without an LLM backend; projection: R-18 |
| D-42 Scalar bundled behind a proxy | ✅ | |
| ➖ D-7, D-21, D-23 (replaced), D-13, D-34, D-40 | ➖ | |

## Synchronisation boundary rules (spec §5)

| Rule | Status |
|---|---|
| Idempotent, replayable projection | ✅ |
| Explicit ownership (marker, `managed_by`) | ✅ |
| Drift detection (apis, keys, derived objects), readable | ✅ |
| Adopt mode | 🟡 the api is taken over without being overwritten; its subscriptions are not: R-17 |
| Dry-run before a mass projection | ✅ deployments and catalog syncs |

## Spec §8, not yet drafted in the spec

| Topic | Status |
|---|---|
| Default portal template | ✅; customer templates: R-19 |
| Analytics and reporting | ✅ attribution at ingestion, console and portal dashboards; correlation id: R-32 |
| Lifecycle audit trail, changes and reads | ✅; webhook exporters ✅ (cursor, at least once, catch-up verified after an outage) |
| The catalogue as a discovery system | 🟡 search and tags: R-20 |
| IdP integration beyond validation | ⬜ R-21 |
| Deployment history tied to the snapshot | 🟡 through the `Api` metadata: R-33 |

## Open questions of the spec

| Question | Status |
|---|---|
| Q-6 inventory of D-15 | ⬜ R-9 |
| Q-8 computed path content, raw path lightening | 🟡 boundary implemented; content and retention: R-8 |
| Q-11 declarative format | 🟡 implemented, to validate: R-28 |
| Q-12 monetisation | ⬜ owner decision: R-35; connector: R-7 |

## Reference catalogue test

✅ `test/reference-catalogue.test.js`: a reference catalogue (6 plans, 5 auth mechanisms, 4 approval modes, one api, one set of routes) projected on Otoroshi 18.0.1, reconciled, drift detected then repaired — including the JWT verifier derived from the Partner plan. 14 tests, stable; the test leaves nothing behind.

## Documentation

✅ Docusaurus site in `documentation/` (the same base as the other extensions: local search, dark by default), 20 pages, built with no broken link; the `documentation` GitHub workflow builds it and publishes it to GitHub Pages on every push to `main` (pull requests build only).

✅ **Screens tour** (`documentation/docs/screens.mdx`): 89 captures of every screen of the console and the portal, drawers, modals and menus included, light and dark, English and French, in `documentation/static/img/screens/`. Produced by `bun run screenshots` (headless Chromium), which also regenerates the page: run it again after every change of the interface. File names are stable (`console-api-flows.png`), so the concept pages show screens of the tour; the order is the order of capture.

## Otoroshi gaps

Logged as they are found in [`OTOROSHI-GAPS.md`](./OTOROSHI-GAPS.md) (G-1 to G-18), to be fixed in the data plane.
