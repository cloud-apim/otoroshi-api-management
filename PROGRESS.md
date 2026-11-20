# Progress

Where the implementation of [`otoroshi-api-management-specs`](../otoroshi-api-management-specs)
stands, decision by decision, and **what remains to implement against the spec**.
**Kept up to date with every commit.**

Legend: ✅ done and verified · 🟡 partial · ⬜ to do · ➖ not applicable / out of the MVP
Sizes: **S** a few hours · **M** one or two days · **L** several days.

Last update: 2026-11-20.

---

## Now

- **The upstream fixes are followed** (2026-11-20, Otoroshi `18.1.0-dev`, [where we are](./OTOROSHI-GAPS.md#where-we-are)): the product requires Otoroshi 18.1, its workarounds and warnings are gone, R-14, R-15, R-16, R-24 and R-33 are done. Run the stack with `OTOROSHI_JAR=<absolute path to ../otoroshi/otoroshi/target/scala-3.8.4/otoroshi.jar> mise run up` until a release carries the fixes. The suite passed on that jar unchanged first (152/152: the new behaviours are opt-in), then followed the fixes one by one:
  - G-10: the derived certificates are written with the upsert of the generic api, which computes their subject and dates from the chain.
  - Otoroshi 18.1 required by the setup check. G-8: the `Api` is managed as code, `created_by=external=otoroshi-api-management`. G-7, R-33: the snapshot id is the `deployment_ref` of the `Api`, the ref of each deployment Otoroshi records; the console lists the gateway's deployments by snapshot.
  - G-1, G-2, G-18, G-20: closing a subscription deletes it, Otoroshi revokes its keys; deleting an api deletes its `Api`, Otoroshi its subscriptions and keys; the warning `plan_id_shared` and the cleanup of minted keys in the tests are gone. Undeploying now disables the `Api` rather than deleting it, so that the consumers keep their keys at the next deployment.
  - G-17, G-4, R-15: the subscription of a jwt, mtls or oauth2-remote plan carries the application's `client_id`, and Otoroshi provisions its consumer; these plans are projected with `subscription_required`: a valid token or certificate alone is not served. A client id changed by the application makes the subscription again on the gateway; two applications cannot subscribe to a plan with the same client id.
  - G-9: the ingester attributes each call from the `apiRef` of its event (api, plan, subscription, application), checked with real traffic; the parsing of minted consumer names is gone.
  - G-3, G-5, G-6, G-13, G-14, G-15, G-16, R-14, R-16: an api without a published or deprecated plan is closed (`no_served_plan`, no acknowledgement any more); deprecated plans are served; the resource filter is projected on every kind but oauth2-local; the selection is a list of JSON path conditions (`selection`), the counter failure strategy and the circuit breaker granularity are projected (`counter_failure`, `circuit_breaker_scope`); oauth2-remote plans name their `issuer` and `audiences`; mtls plans trust their CAs (`trusted_ca_refs`, `dn_match: all`); apikey plans offer a key validity in days. Checked end to end: a gold tier selected by a claim, a deprecated jwt plan with a filter, a token for another audience refused.
  - G-12, R-24: the console's *Test* tab tries requests with Otoroshi's request tester, and shows the trace of the call — the consumer the plans identified, each plugin with its outcome.
  - A bug of the product, found on the way: a subscription made again on the gateway (gone from it) kept its old credential active beside the new one; it is revoked now.
  - A bug of the product, found on the way: the restriction paths are regexes, and `/v1/pets*` did not allow `/v1/pets/42`; they are `/v1/pets(/.*)?` now.
  - Found on the way, logged as **G-22** ([#2962](https://github.com/MAIF/otoroshi/issues/2962), open, also on 18.0.1): on an api with several plans, an extractor that does not identify the caller sends an error event for a call that then succeeds — the dashboards count it as a `400`.
  - Left to do: the screens tour (`bun run screenshots`) is to run again — the plan editor, the *Test* tab, the deploy dialog and the technical details of a deployment changed. The development gateway keeps nothing across a restart (its `/data` stays empty): after `mise run up`, `mise run demo` deploys the demo again.

## Next, in the proposed order

1. **R-39** — the "via Otoroshi" console login end to end, behind the route and the auth module the setup makes.
2. **R-30** — the roles split across instances, several instances of a role.
3. **R-36** — secrets at rest.
4. **R-13** — subscription expiry.
5. **R-38** — UI tests.

Then the items that touch the projection: R-12, R-17, R-25, R-10.

The full list, grouped by area, is in [What remains to implement](#what-remains-to-implement).

## Remaining effort at a glance

Effort: **S** ≈ R-49 or R-50, **M** ≈ R-8 or R-41, **L** ≈ R-7.

**Doable (24)**

| # | Effort | What |
|---|---|---|
| R-39 | S | "Via Otoroshi" console login tested end to end |
| R-30 | S | Roles split across instances, several instances of a role |
| R-13 | S | Subscription expiry at a date |
| R-47 | S | Free → paid plan move through a Checkout |
| R-27 | S | Remote catalogs from S3 |
| R-31 | S | LLM/MCP ingestion checked with real events (needs the LLM extension) |
| R-32 | S | Correlation id carried to the backends |
| R-22 | S | Metadata field labels in several languages |
| R-23 | S | The shared request composer on the portal (apis without OpenAPI) |
| R-42 | S | Free pages of the portal |
| R-9 | S | Written inventory of the Otoroshi entities (derived or infrastructure) |
| R-48 | S | Compaction of old rollups (only if the volume calls for it) |
| R-36 | M | Secrets at rest encrypted or in a vault |
| R-38 | M | UI tests (the screens tour only today) |
| R-37 | M | Accessibility audit of both faces — not a priority (owner) |
| R-12 | M | One credential for several subscriptions |
| R-17 | M | Adopt: take over the existing subscriptions and keys too |
| R-20 | M | Catalogue as a discovery tool (categories, featured, reviews) |
| R-21 | M | Dynamic client registration at the IdP — not a priority (owner) |
| R-25 | M | Threat protection per plan, and its events in observability |
| R-34 | M | Usage-based billing (Stripe Billing Meters) |
| R-18 | M | Token and AI budget plans (out of the MVP for now) |
| R-10 | L | Named compositions: resources and dictionaries |
| R-19 | L | Custom portal templates |


**Owner decisions (4):** R-26 where the gateway health and the drift live in the console · R-28 the declarative format · R-29 two answers already implemented · R-35 who pays, and whether monetisation is in the MVP.

**Waiting for a go:** building the real image (downloads).

**Out of the MVP by decision:** AI and MCP apis as product types, event-driven apis, api scoring.

**Total doable:** 12 S + 10 M + 2 L ≈ 18 M. Without R-18, R-37, R-21 and R-19 (out of the MVP, or not a priority): ≈ 13 M.

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
| R-17 | §5 | **Adopt mode**, second half: take over the existing subscriptions and apikeys of an adopted Api, not only its description | M | |
| R-18 | D-41 | **Token and budget plans**: project `LlmTokensRateLimitingValidator` and `AiBudget` (the schema is ready, the feature is out of the MVP, D-32) | M | ➖ |

### Developer portal

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-19 | §8 | **Portal templates**: customer templates edited in the console or synchronised from files, beyond the default template and its theme settings | L | |
| R-20 | §8 | **Catalogue as a discovery system**: editorial categories and featured apis, consumer reviews, real usage — today search and tags only | M | |
| R-21 | §8 | Not a priority (owner). **Dynamic client registration** at the IdP when an application is created, with the security posture of the client type | M | |
| R-22 | D-11, D-18 | Metadata field **labels and help in several languages** (one language today) | S | |
| R-23 | D-17 | Testing on the portal is Scalar's; D-17 wants **one composer** for both faces — use the shared composer on the portal for apis without an OpenAPI specification | S | |
| R-42 | D-11 | **Pages of the portal** beyond its home: pages a workspace writes (multilingual markdown, like the home and the documentation pages), in the portal's navigation | S | |

### Console

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-25 | D-10 | **Threat protection**: configure the Threat Protection Suite per plan from a dedicated screen (possible today as plan plugins), and render its security events in observability | M | D-10 notes: plan-level attribution of `CloudApimSecurityEvent` |
| R-26 | D-27 | Validate with the owner where the gateway health, the projection state and the drift live (proposed: bottom of the sidebar + a Gateway page) | — | |

### Industrialisation (GitOps, environments, operations)

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-27 | D-28 | Remote catalogs from an **object store** (S3) — http and git exist | S | |
| R-28 | Q-11 | The declarative format is implemented (one document per api-version, plans inside, pages beside) — **to validate by the owner** before it becomes a contract | — | |
| R-29 | D-36 "to instruct" | Two answers implemented, **to validate by the owner**: publishing a shared policy group does not republish the apis (they pin a version); a remote catalog chooses per catalog whether it writes drafts, publishes or deploys | — | |
| R-30 | §3 | Run the roles **split across instances** (ingester alone, portal alone…) and with several instances of a role — the task queue claims atomically, never tested | S | |

### Analytics and audit

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-31 | D-32 | Verify **LLMUsageAudit and McpAudit** ingestion with real events from the LLM extension (coded, never fed) | S | |
| R-32 | §8 | A **correlation id** carried beyond the gateway, to follow a request through the backends | S | |

### Monetisation

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-47 | D-36, D-30 | A move from a **free plan to a paid one** through a Checkout, the subscription staying on its plan until it is paid — refused today: the consumer subscribes to the paid plan | S | |
| R-48 | D-33 | A daily **compaction** of the hourly rollups past a few months, should their volume call for it | S | |
| R-34 | D-36 | **Usage-based billing**: push the computed counters per subscription in batches (Stripe Billing Meters); refuse a usage plan on a connector that cannot meter | M | R-7 |
| R-35 | Q-12 | Who holds the billing account (team, proposed) and whether monetisation is in the MVP — **owner decision** | — | |

### Robustness and security

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-36 | D-9, D-24 | **Secrets at rest**: credential secrets, IdP secrets and catalog tokens are stored in clear in the product database — encrypt them, or reference a vault | M | |
| R-37 | — | Not a priority (owner). An **accessibility** audit of both faces (labels and focus are there, no audit done) | M | |
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
| D-6 a subscription is an apikey | ✅ | `apiRef` + `id_ref` verified on the gateway, on every kind: the subscription of a jwt, mtls or oauth2-remote plan carries the client id of the application, and the gateway serves only the consumers of enabled subscriptions (`test/reference-catalogue.test.js`, `test/derived-objects.test.js`) |
| D-8 PostgreSQL ×2 | ✅ | `server/db/migrations.js` |
| D-9 n°1 everything the UI does goes through the API | ✅ | the same router on `/api` and `/backoffice/api` |
| D-9 n°2 escape hatch to the projected entity | ✅ | "Technical details", link to the Otoroshi backoffice |
| D-9 n°3 nothing essential hidden | ✅ | warnings: an api closed without a served plan, a plan without selection shadowing another, an oauth2-remote plan without issuer nor audience, an mtls plan without CA, a filter an oauth2-local plan cannot hold; the resolution order |
| D-9 n°4 reversibility | ✅ | export / import ✅; uninstalling leaves a working configuration, taken over by hand with Otoroshi alone (revoke, subscribe, change a plan, remove the marker) — `test/product-down.test.js`, documented in *When the product is down* |
| D-9 n°5 Apache 2.0 | ✅ | `LICENSE`, `NOTICE` |
| D-10 WAF in the extension | 🟡 | usable as plugins in a flow or a policy group; no dedicated screen: R-25 |
| D-11 i18n | 🟡 | multilingual docs ✅, portal en/fr ✅, the portal's texts (title, tagline, home) per language ✅, console en/fr ✅ (texts keyed by their English, `mise run check` fails on a text without French); the admin api's messages stay in English (owner); metadata labels: R-22; more portal pages: R-42 |
| D-12 light / dark / system | ✅ | console and portal |
| D-14 no need to open Otoroshi | ✅ | complete APIM; certificates and auth modules derived; one executable — the server and its roles, the console and the portal embedded, the migrations, the command line (`otoroshi-apim <command>`), built for linux and macos, x64 and arm64 (`mise run build:binary`, `build:binaries`, `test/binary.test.js`); the setup of the gateway (`otoroshi-apim setup`, `apim gateway setup`, Gateway › Setup), given an Otoroshi admin key, idempotent, part by part, a dry run first: the product's own admin key, the data exporter, the routes of the console (behind an auth module with the info token, if asked) and of the portals, the TLS client authentication for mtls plans; its checks — `test/setup.test.js`; the product's key is not narrowed: G-20, and it reads the global configuration, super admin only by design (G-21) |
| D-15 derived objects | 🟡 | JWT verifiers ✅ derived from the plan description (JWKS or HMAC, iss, aud), marked, in the deployment diff and the drift, removed with the api — reference catalogue test; trusted CAs of mtls plans ✅ derived as certificates (issuer pattern derived from them when none is given), auth modules of oauth2-remote plans ✅ derived from the described authorization server (with discovery); both marked, in the deployment diff and the drift, removed after the Api — `test/derived-objects.test.js` against the real gateway, a token of the dev IdP passing; client certificates of applications ✅ derived while an mtls subscription is active; inventory: R-9 |
| D-16 named compositions | 🟡 | shared policy groups ✅ (pinned versions, upgrade); resources and dictionaries: R-10 |
| D-17 testing | 🟡 | portal (Scalar + proxy) ✅; console ✅ with the trace of the policies (the request tester of the gateway); one composer: R-23 |
| D-18 typed metadata, one mechanism | ✅ | 5 scopes, request form, publication blocked by a missing required field |
| D-19 workspace + teams, global users | ✅ | an admin only sees the members of its workspaces |
| D-20 one portal per workspace, resolved from the url | ✅ | by root path, by hostname, or one workspace at the root (`APIM_TENANCY=single`: no prefix, no selector); the forms served before are recorded and their urls redirected (`301`/`308`) to the same page — `test/portal-exposure.test.js`, `test/portal-forms.test.js`; `portal_url` given by the admin api |
| D-22 described / deployed state, diff before acting | ✅ | dry-run before every deployment |
| D-24 `default` location + ownership marking | ✅ | |
| D-25 authentication | ✅ | OIDC console and portal verified against a dev IdP; Otoroshi mode unit-tested: R-39 |
| D-26 application, expected `client_id`, `id_ref` | ✅ | client certificates read and checked (console and portal), derived as certificates of the gateway while an mtls subscription is active (`test/derived-objects.test.js`); a subscription of a token or certificate plan carries no consumer identity on Otoroshi (G-17, MAIF/otoroshi#2937): its ApiSubscription carries the application's client id as metadata meanwhile |
| D-27 console navigation | ✅ | gateway status at the bottom of the sidebar (left open by D-37: R-26): failed projections, waiting ones and drift counted apart, leading to the first of them; a failed task says what it works on, is retried or dismissed, and dismissed by itself when its object is gone |
| D-28 administrable by program | 🟡 | admin API ✅, CLI ✅, remote catalogs http/git ✅, Kubernetes ✅: CRDs Api / Application / Subscription and their controller (role `controller`, credentials in a Secret, ownership, finalizers, status), kustomize manifests and the Helm chart (linted, rendered) validated by a k3s api server — `test/kubernetes.test.js`; object store: R-27 |
| D-29 a version is a new api | ✅ | |
| D-30 transfer to an equivalent plan | ✅ | same key, same history; a degrading move waits for the consumer's consent; a consumer asks, the producer applies; in-app notifications, read and marked done by each person (a page lists them all) — `test/queue-and-notifications.test.js` |
| D-31 no aggregated quota | ✅ | multi-api credential: R-12 |
| D-32 MVP scope, captured events | 🟡 | GatewayEvent verified with real traffic; LLMUsageAudit and McpAudit: R-31 |
| D-33 two storage paths | ✅ | computed (exhaustive) + raw (optional): the raw path sampled by request, its errors kept, its headers optionally left out; personal data pseudonymised before anything is stored, in both paths — the address truncated (the default), hashed (HMAC, a key the product keeps) or left out, the signed-in user hashed (the default) or left out, the user agent, the paths templated; the calls rolled up by the hour (by id: late events counted, nothing twice), each path kept for its days; the dashboards read the rollups past the last purge, with exact counts — `test/ingestion.test.js`, `test/ingest-policy.test.js`; the exporters themselves: G-19 |
| D-35 draft → immutable snapshot | ✅ | rollback = redeploying a snapshot |
| D-36 ready for monetisation | 🟡 | Stripe ✅ through Stripe Connect (a workspace links its own account, its id only): Checkout with the price of the plan, signed webhooks kept once and handled by the queue, past due within the grace of the plan then suspended, resumed once paid, closed when cancelled, reconciliation every hour, the customer portal, closing and moving cancel or change the price at Stripe; the team pays — `test/payments.test.js`, `test/stripe.test.js`; free → paid move: R-47; usage billing: R-34 |
| D-37 one installation, one cluster | ✅ | promotion to the next installation: a snapshot exported as a document (its digest, without what names the api locally), taken by the next installation as one of its own snapshots — dry run (diff with what runs, gateway changes, vault references resolved or not), deploy, draft replaced; the values of each environment are Otoroshi vault references — `test/promotion.test.js` between two installations |
| D-38 projection marked as the product's | ✅ | the `Api` is managed as code (`created_by=external=otoroshi-api-management`): Otoroshi records each deployment, with the snapshot as its ref |
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
| IdP integration beyond validation | ⬜ R-21, not a priority (owner) |
| Deployment history tied to the snapshot | ✅ each deployment Otoroshi records carries the snapshot as its ref (`deployment_ref`); the console lists them by snapshot |

## Open questions of the spec

| Question | Status |
|---|---|
| Q-6 inventory of D-15 | ⬜ R-9 |
| Q-8 computed path content, raw path lightening | ✅ hourly rollups by catalogue dimension, method, templated path and status class, durations as a histogram; calls 30 days, rollups 400, AI usage 90, raw 7 — set in the console; the cleaning at ingestion, its upstream counterpart logged as G-19 |
| Q-11 declarative format | 🟡 implemented, to validate: R-28 |
| Q-12 monetisation | ⬜ owner decision: R-35; connector: R-7 |

## Reference catalogue test

✅ `test/reference-catalogue.test.js`: a reference catalogue (6 plans, 5 auth mechanisms, 4 approval modes, one api, one set of routes) projected on Otoroshi 18.0.1, reconciled, drift detected then repaired — including the JWT verifier derived from the Partner plan. 14 tests, stable; the test leaves nothing behind.

## Documentation

✅ Docusaurus site in `documentation/` (the same base as the other extensions: local search, dark by default), 20 pages, built with no broken link; the `documentation` GitHub workflow builds it and publishes it to GitHub Pages on every push to `main` (pull requests build only).

✅ **Screens tour** (`documentation/docs/screens.mdx`): 95 captures of every screen of the console and the portal, drawers, modals and menus included, light and dark, English and French, in `documentation/static/img/screens/`. Produced by `bun run screenshots` (headless Chromium), which also regenerates the page: run it again after every change of the interface. File names are stable (`console-api-flows.png`), so the concept pages show screens of the tour; the order is the order of capture.

## Otoroshi gaps

Logged as they were found in [`OTOROSHI-GAPS.md`](./OTOROSHI-GAPS.md) (G-1 to G-21), each with its upstream issue. All fixed upstream in `18.1.0-dev` (2026-11-19) but G-11 (not feasible in a distributed cluster), G-19 (the ingester's job) and G-21 (by design), not fixed by decision. The product requires 18.1 and follows the fixes gap by gap: the [table](./OTOROSHI-GAPS.md#where-we-are) says which are followed and which are still to follow.
