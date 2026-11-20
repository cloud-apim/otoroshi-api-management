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
  - R-39: the "via Otoroshi" console login verified end to end, through a basic auth module of the gateway in front of the console route the setup makes.
  - R-30: four instances on one database — two consoles with their workers, an ingester alone, a portal alone — each answers its roles and nothing else, a session made on one console is good on the other, sixty tasks run once each (`test/roles.test.js`). Found on the way: each instance kept up to 30 connections open, so a few instances exhausted PostgreSQL; the pools are set by instance now (`APIM_DATABASE_POOL`, `APIM_ANALYTICS_DATABASE_POOL`) and idle connections closed after 30 s.
  - R-36: the secrets the product keeps — credentials, the key of the gateway, the secrets of the identity providers and of the info token, the headers of the catalogs and of the audit exporters, the key of the pseudonyms — are sealed with AES-256-GCM and the key of the installation (`APIM_SECRETS_KEY`); a rotation lists the previous keys (`APIM_SECRETS_PREVIOUS_KEYS`), and every instance seals again at start what another key, or none, sealed. The setup check says when there is no key; a plan secret in clear is flagged (`secret_in_clear`): a vault reference keeps it out of the snapshots. Workspace exports leave the secret of the portal's identity provider out (`test/secrets.test.js`).
  - R-13: a producer gives a subscription an end date (console, admin api, cli); from that day it expires — on the gateway, its keys disabled — and a later date, or none, renews it with the same keys; the workers expire what is due every minute; a paid subscription takes none (`test/expiry.test.js`).
  - R-38: the interface tested in a headless Chromium (`test/ui.test.js`): every page of the console opens without an error or a 5xx, a producer makes an api and a plan from the console and saves the draft, the console speaks French, a consumer subscribes from the portal and sees its credentials. `mise run test` builds the interfaces first.
  - R-47: a move from a free plan to a paid one, once agreed, waits for the consumer's payment — the subscription on its free plan, its key working — and is applied when the Checkout of the paid plan is paid, with the same key; either side can drop it (`test/payments.test.js`).
  - R-27: remote catalogs from an object store — `s3://<bucket>/<prefix>`, AWS or any store that speaks its api (endpoint, region) — every yaml and json object under the prefix, the digest of the keys and etags as revision, the access key sealed at rest (`test/catalogs.test.js`, `test/secrets.test.js`, against a local store that speaks the api).
  - R-42: the pages a workspace writes for its portal — Markdown per language, at `/pages/<slug>`, in its navigation or reached by their link — edited in Workspace settings › Developer portal or by the admin API (`test/ui.test.js`).
  - R-22: the label and the help of a metadata field in other languages (`translations`), shown in the reader's language on the console and the portal — a request form asks its questions in French on a French portal (`test/ui.test.js`).
  - R-23: an api without an OpenAPI specification has a *Try it* tab on the portal — the request composer of the console, through the gateway, with the credentials of the consumer's own subscriptions (`test/ui.test.js`).
  - R-32: one request id from the caller to the backends — the `Otoroshi-Request-Id` the caller gets back is sent to the backends (`Otoroshi headers in` added to the flows, an api setting) and kept by the request log, where it is searched (`test/reference-catalogue.test.js`, `test/ingestion.test.js`).
  - R-9: the inventory of the Otoroshi entities (D-15, Q-6) — every kind the gateway declares, with what the product does with it — a table in the product (`server/otoroshi/inventory.js`) and in the documentation, checked against `GET /apis/entities` of the gateway (`test/inventory.test.js`).
  - R-17: adopt mode takes over the subscriptions of an Api and their keys too — an application per owner, the same subscription ids, the same client ids and secrets — and the first deployment updates them in place: the consumer keeps calling with its key (`test/adopt.test.js`). The plans of an adopted Api keep the new attributes of the contract (selection, counter failure, circuit breaker, issuer and audiences, trusted CAs, validity).
  - R-12 found a gap, **G-23**, reproduced on the gateway and reported upstream ([#2963](https://github.com/MAIF/otoroshi/issues/2963)): a key is its subscription's own — a second subscription that names it gets a key of its own — so one credential for the subscriptions of a consumer to several apis waits for Otoroshi.
  - R-20: the catalogue as a discovery system, on three axes — editorial (the categories of the portal, where each api stands across its versions, the featured ones, applied at once without a snapshot), the reviews of the consumers who subscribed (one per person and api, hidden by a producer, kept in the console), and the real usage (subscribed applications, calls of the last thirty days); the portal filters by category and sorts on them; a workspace keeps reviews or usage off its portal (`test/discovery.test.js`, `test/ui.test.js`).
  - R-25: the Threat Protection Suite per plan (D-10) — a tab of the plan configures the preset of the extension (firewall, bots, IP reputation, fail2ban, sensitive data, error leakage, uploads, login guard, api contract) and references its policies, projected in the plugins of the plan and watched by the drift detection; a gateway without the extension, which would let the calls through unprotected, gets the draft and the deployment warned; the `CloudApimSecurityEvent` of the suite are exported, ingested and attributed to the api and, through the key that called, the plan, the subscription and the application — Observability › Security, and the analytics of an api (`test/threat-protection.test.js`, `test/ingestion.test.js`, `test/model.test.js`). Three gaps of the extension logged: **G-24** (the global table of Threat Studio ignores the plan plugins), **G-25** (a challenge answers a page with status 200), **G-26** (a security event does not name the plan).
  - R-34: usage-based billing (D-36) — a paid plan can bill the usage of its subscriptions with a metered price of Stripe, with its recurring price or alone; the calls counted from the computed path (success or served), pushed to the meter of the linked account in batches after the rollups, taken by id — exactly once, each report sent once with its id as identifier and replayed until it is; the calls kept until billed; the usage shown on the subscription (console, admin api, cli) and on the portal; a usage price refused on a provider that cannot meter (`test/payments.test.js`, `test/stripe.test.js`, `test/model.test.js`).
  - R-51: the analytics of the console to the level of the API management consoles of the market — one row of filters in the url (timeframes from 5 minutes to a year and a custom range, api, plan, application, status class; refresh and auto-refresh), requests per second, minimum, maximum and p95 latency, the responses over time split into successes, client and server errors (stacked columns), the latency over time, the hits of the first applications and apis (the others folded into "other"), the tops by calls, server errors and latency, the hosts (kept at ingestion) and the paths as called; buckets that follow the range (`date_bin`), empty ones shown; charts per the dataviz method, legend and table view everywhere (`test/ingestion.test.js`, `test/ui.test.js`).
  - R-52: the request log as a view of its own (Observability › Logs) — the filters of the dashboards and its own (method, path, client id, a free search that reaches the host), the detail of a call (where its time went), a CSV export of the filtered calls (formulas quoted, 50,000 at most), both traced in the audit trail; every dashboard opens it with its filters (`test/ingestion.test.js`, `test/ui.test.js`).
  - R-53: the analytics and the logs of the consumer's applications on the portal — the same filters (timeframes, application, api, status class), the figures, the responses and the latency over time, the hits by api and application, the tops; the request log of its applications, filtered by method and path, with the detail of a call and a CSV export traced in the audit trail; each application links to both (`test/payments.test.js`, `test/ui.test.js`).
  - R-25 checked on a gateway running the Threat Protection Suite 1.0.0 and the LLM extension 0.0.90 (their latest releases, on the classpath of the development gateway: `OTOROSHI_EXTENSIONS`): a legitimate call served, an injection refused by the threat response, its security event attributed to the api, the plan, the subscription and the application (`test/threat-protection.test.js`, which runs either case). On the way: **G-24** confirmed (the global table of Threat Studio runs a second firewall on a plan already protected, the scores add up), **G-26** confirmed, **G-27** (every call scores a firewall match with the core rule set) and **G-28** (a firewall that blocks on its own sends no security event) found; **G-25** withdrawn — a challenge is for a person in a browser. G-24, G-26, G-27 and G-28 reported to the extension (cloud-apim/otoroshi-waf-extension#60 to #63); the threat protection is left aside for now (owner). Also found on the way, in the product: the ingester read its attribution cache every 15 seconds, so the first calls of an api or a key made meanwhile were unattributed — an unknown api, subscription or key now reads it again, once a second at most (`test/ingestion.test.js`).
  - R-31: the AI audits checked with real calls on the gateway running the LLM extension — a chat completion through an api whose flow proxies a provider (a fake one, a route of the gateway answering as OpenAI), an MCP tool called through another api. What the real events showed: the audits are generic `AuditEvent`s (`audit: LLMUsageAudit | McpAudit`), so the exporter never sent them and the ingester did not know them — both fixed; the tokens are under `usage` (`generation_tokens`), the cost under `costs.total_cost` in dollars, the tool of an MCP call under `mcp_request_payload.params.name`; and an audit carries the prompt, the answer, the arguments and the result of a tool, and the whole key with its secret — the ingester now keeps the usage only, the key named, the address and the end user pseudonymised (`test/ai-usage.test.js`, `test/ingestion.test.js`).
  - R-55: an AsyncAPI specification (2.x or 3.x) in the draft and the snapshots of an api — a tab of the console, an outline of its channels — never projected; the portal renders it in an Events tab: its channels from the side of a consumer (what it sends, what it receives, whatever the version), the messages with their payloads and examples, its local references resolved, its servers the gateway (the brokers stay private); a specification the portal cannot read is said on the draft (`test/discovery.test.js`, `test/model.test.js`, `test/ui.test.js`).
  - R-10, first half: **dictionaries** (D-16) — a named set of values of a workspace, given here or refreshed from an external source (an url answering json, a json pointer, headers sealed, a failing source keeping its last values), projected into the global env of the gateway under the product's own part, `apim.dictionaries.<workspace>.<name>`, where the expression language of any plugin reads it (`${global_config.env.apim.dictionaries…}`): changed, what runs changes without redeploying the apis; what the gateway holds compared (in sync, changed on the gateway, missing); a page under APIs › Dictionaries, the admin api, the cli (`test/dictionaries.test.js`, which reads a value through a plugin of an api).
  - R-10, second half: **shared resources** (D-16) — an authorization server described once for the workspace (issuer, keys, discovery, user info, the client of the gateway), published by immutable versions; a jwt or oauth2-remote plan pins a version instead of describing its server, the snapshot freezes it, and the projection derives from it the very JWT verifier or auth module a description derives; a new version changes nothing until an api is upgraded, the apis behind listed; a resource still pinned is not deleted; checked with a real token of the identity provider of the stack (`test/shared-resources.test.js`, `test/model.test.js`).
  - The screens tour taken again (109 captures, `docs/screens.mdx`): the AsyncAPI tab and the events of the portal, the catalogue placement and the reviews, the threat protection of a plan, shared resources and dictionaries, the observability tops, the request log and a call, the security events, the analytics and the request log of the portal.
  - The demo feeds every dashboard (`scripts/demo-activity.js`, run by `mise run demo`): what the drift detection finds missing on the gateway is deployed again (the snapshot that ran) and provisioned again — the development gateway keeps nothing across a restart; an event-driven api with its AsyncAPI specification, a dictionary, a shared authorization server pinned behind its latest version, the categories and a review of the portal; calls through the gateway now, under the rate limits of the plans, and fourteen days of calls and security events fed to the ingester once.
  - R-35 settled by the owner: monetisation is in the MVP as implemented, optional; the team holds the billing account; a connector after Stripe waits for a need (Lago first). A paid plan is now published only once the workspace has linked its Stripe account (or with payments on): the draft says why, the publication is refused (`test/payments.test.js`).
  - R-29 settled by the owner: publishing a shared policy group or a shared resource republishes no api — the snapshot stays the document that was tested —, with two aids so that a fix travels: the teams of the apis behind are notified (one notification per team, the apis listed, a link to the group or the resource), and **Upgrade the N behind** moves them to the latest version, each by its own draft and, on demand, its own snapshot and deployment where it runs; an api managed by a source, not managed by the caller, or whose draft holds other unpublished changes is reported, not forced (`POST …/upgrade`, `apim policy-groups|shared-resources upgrade`, `test/pins.test.js`). The remote catalogs keep their mode per catalog, and the defaults as they are.
  - R-28 settled by the owner: the declarative format becomes a contract, with four changes. The version is `spec.version`, as in a Kubernetes resource (`metadata.version` still read, the two differing refused). The policy groups and the shared resources a document pins are named — an id still accepted —, the export writes names, so a document moves between installations; a name is unique in a workspace. A document that lists its pages is their truth (a page it no longer lists is deleted; without `pages`, they are left alone). The content of a page can be a file beside the document, read by `apim apply` and by the remote catalogs (git, S3, HTTP), within the source (`test/declarative.test.js`, `test/catalogs.test.js`).
  - R-26 settled by the owner: the gateway pill at the bottom of the sidebar and the Gateway page stay as they are, on one condition met — the settings of the gateway are the installation administrators' only: the connection, ingestion and setup tabs are hidden from anyone else (refused by the admin api already), and the status a non-admin reads drops the url of the gateway, its errors and the volumes of the installation, its drift counted on their own workspaces (`test/permissions.test.js`).
  - The banner of an api says what the drift detection saw since its deployment: "no longer on the gateway" (a restart without storage, a hand in its console) or "changed on the gateway", with a redeploy of the snapshot that ran; `on_gateway` still means "the product put it there" (`deployment.gateway`, `test/derived-objects.test.js`).
  - Every list is searchable and paged, in the console and the portal — top-level pages, the lists of a detail page, a card, a modal or a drawer (`web/shared/lists.jsx`: `useLocalPaging`, `usePaging`, `local` for a modal, the page brought back when the list shrinks; the reference is the applications list). Searched and paged on the server where they grow: the people (`GET /users`, formerly cut at 200), the deployment history of an api (formerly cut at 50), the usage billed for a subscription (its sums now over every batch, not the last 200), the security events (`q`), the notifications of the portal. Editable ordered compositions (the plugins of a flow, the pages and categories of the portal settings, key/value editors) stay as they are.
  - G-22 extended: a call refused in the end is exported twice as well (the `400 no apikey` of an extractor, then the `401` the client gets), captured again on the data exporter.

## Next, in the proposed order

1. **R-48** — compaction of old rollups (only if the volume calls for it).

Then the large ones: R-19, and the event-driven apis (R-54).

The full list, grouped by area, is in [What remains to implement](#what-remains-to-implement).

## Remaining effort at a glance

Effort: **S** ≈ R-49 or R-50, **M** ≈ R-8 or R-41, **L** ≈ R-7.

**Doable (6)**

| # | Effort | What |
|---|---|---|
| R-54 | L | Event-driven apis: the events of the event brokers extension (owner's request) |
| R-48 | S | Compaction of old rollups (only if the volume calls for it) |
| R-37 | M | Accessibility audit of both faces — not a priority (owner) |
| R-21 | M | Dynamic client registration at the IdP — not a priority (owner) |
| R-18 | M | Token and AI budget plans (out of the MVP for now) |
| R-19 | L | Custom portal templates |


**Blocked on Otoroshi (1):** R-12 (G-23, a key serving several subscriptions).

**Owner decisions:** none left open.

**Waiting for a go:** building the real image (downloads).

**Out of the MVP by decision:** AI and MCP apis as product types, event-driven apis, api scoring.

**Total doable:** 1 S + 3 M + 2 L ≈ 8 M. Without R-18, R-37, R-21 and R-19 (out of the MVP, or not a priority): ≈ 3 M (R-54, R-48).

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
| R-12 | §4, D-31 | A **credential covering several subscriptions** (one key for several apis of the same consumer, `authorizedEntities` on several apis) — the model's "parent / child" credential; quotas stay per credential | — | G-23 |
| R-18 | D-41 | **Token and budget plans**: project `LlmTokensRateLimitingValidator` and `AiBudget` (the schema is ready, the feature is out of the MVP, D-32) | M | ➖ |

### Developer portal

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-19 | §8 | **Portal templates**: customer templates edited in the console or synchronised from files, beyond the default template and its theme settings | L | |
| R-21 | §8 | Not a priority (owner). **Dynamic client registration** at the IdP when an application is created, with the security posture of the client type | M | |

### Analytics and audit

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-54 | D-32 | **Event-driven apis** (owner's request, 2026-11-20): take into account the events of the `otoroshi-event-brokers-extension` (Kafka, RabbitMQ, Pulsar, Redis, MQTT, Artemis behind routes: an HTTP ingester, HTTP/SSE/websocket consumers, webhooks), so that an api can be event-driven in time — its ingestion, its analytics, its plans. To instruct first: today the extension sends `EventBrokerConnectionEvent` and `EventBrokerWebhookDeliveryFailedAlert` only, nothing per event published or consumed — what a usage, a quota or a bill of an event api would count; to verify on a gateway running the extension, and to log as a gap if so | L | |

### Monetisation

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-48 | D-33 | A daily **compaction** of the hourly rollups past a few months, should their volume call for it | S | |

### Robustness and security

| # | Spec | What is missing | Size | Upstream |
|---|---|---|---|---|
| R-37 | — | Not a priority (owner). An **accessibility** audit of both faces (labels and focus are there, no audit done) | M | |

### Out of the MVP, by decision (kept for later)

| # | Spec | Item |
|---|---|---|
| — | D-32 | AI and MCP apis as product types (the events are captured from day one) |
| — | D-32, D-34 | Event-driven apis — needs per-message events in the event-brokers extension first |
| — | D-32, Q-7 | Api scoring, quality review before publication |
| — | Q-12 | A payment connector after Stripe — Lago self-hosted first (flat and usage, sovereign, AGPL called as a service), when a need comes; the connector interface is there (Stripe, the fake one) |
| — | Q-11 | Declarative kinds beyond `Api` (`PolicyGroup`, `SharedResource`, `Dictionary`), when the need comes: they live in the workspace export meanwhile |

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
| D-10 WAF in the extension | ✅ | the Threat Protection Suite per plan (its preset in the plan plugins, its policies referenced), its security events attributed to the api and the plan in Observability › Security; the three gaps of the extension logged (G-24, G-25, G-26); the check with the extension running: R-25 |
| D-11 i18n | ✅ | multilingual docs ✅, portal en/fr ✅, the portal's texts (title, tagline, home) per language ✅, console en/fr ✅ (texts keyed by their English, `mise run check` fails on a text without French); the admin api's messages stay in English (owner), the pages of the portal per language ✅, the labels and help of the metadata fields per language ✅ |
| D-12 light / dark / system | ✅ | console and portal |
| D-14 no need to open Otoroshi | ✅ | complete APIM; certificates and auth modules derived; one executable — the server and its roles, the console and the portal embedded, the migrations, the command line (`otoroshi-apim <command>`), built for linux and macos, x64 and arm64 (`mise run build:binary`, `build:binaries`, `test/binary.test.js`); the setup of the gateway (`otoroshi-apim setup`, `apim gateway setup`, Gateway › Setup), given an Otoroshi admin key, idempotent, part by part, a dry run first: the product's own admin key, the data exporter, the routes of the console (behind an auth module with the info token, if asked) and of the portals, the TLS client authentication for mtls plans; its checks — `test/setup.test.js`; the product's key is not narrowed: G-20, and it reads the global configuration, super admin only by design (G-21) |
| D-15 derived objects | ✅ | JWT verifiers ✅ derived from the plan description (JWKS or HMAC, iss, aud), marked, in the deployment diff and the drift, removed with the api — reference catalogue test; trusted CAs of mtls plans ✅ derived as certificates (the trusted CAs of their plan, `trusted_ca_refs`), auth modules of oauth2-remote plans ✅ derived from the described authorization server (with discovery); both marked, in the deployment diff and the drift, removed after the Api — `test/derived-objects.test.js` against the real gateway, a token of the dev IdP passing; client certificates of applications ✅ derived while an mtls subscription is active; the inventory of every kind of the gateway ✅ |
| D-16 named compositions | ✅ | shared policy groups (pinned versions, upgrade), shared resources (an authorization server, pinned versions, derived like a description), dictionaries (projected into the global env, read by the expression language) |
| D-17 testing | ✅ | portal: Scalar + proxy for an api with its specification, the composer shared with the console otherwise ✅; console ✅ with the trace of the policies (the request tester of the gateway) |
| D-18 typed metadata, one mechanism | ✅ | 5 scopes, request form, publication blocked by a missing required field |
| D-19 workspace + teams, global users | ✅ | an admin only sees the members of its workspaces |
| D-20 one portal per workspace, resolved from the url | ✅ | by root path, by hostname, or one workspace at the root (`APIM_TENANCY=single`: no prefix, no selector); the forms served before are recorded and their urls redirected (`301`/`308`) to the same page — `test/portal-exposure.test.js`, `test/portal-forms.test.js`; `portal_url` given by the admin api |
| D-22 described / deployed state, diff before acting | ✅ | dry-run before every deployment |
| D-24 `default` location + ownership marking | ✅ | |
| D-25 authentication | ✅ | OIDC console and portal verified against a dev IdP; "via Otoroshi" verified end to end: a person signed in on a basic auth module of the gateway, in front of the console route the setup makes, is the user of the console (`test/setup.test.js`) |
| D-26 application, expected `client_id`, `id_ref` | ✅ | client certificates read and checked (console and portal), derived as certificates of the gateway while an mtls subscription is active (`test/derived-objects.test.js`); a subscription of a token or certificate plan carries no consumer identity on Otoroshi (G-17, MAIF/otoroshi#2937): its ApiSubscription carries the application's client id as metadata meanwhile |
| D-27 console navigation | ✅ | gateway status at the bottom of the sidebar (left open by D-37, settled by the owner on 2026-11-20, R-26: the pill and a Gateway page as they are, the state of the gateway for everyone, scoped to their workspaces, its settings — connection, ingestion, setup — for the installation administrators only): failed projections, waiting ones and drift counted apart, leading to the first of them; a failed task says what it works on, is retried or dismissed, and dismissed by itself when its object is gone |
| D-28 administrable by program | ✅ | admin API ✅, CLI ✅, remote catalogs http/git/s3 ✅, Kubernetes ✅: CRDs Api / Application / Subscription and their controller (role `controller`, credentials in a Secret, ownership, finalizers, status), kustomize manifests and the Helm chart (linted, rendered) validated by a k3s api server — `test/kubernetes.test.js` |
| D-29 a version is a new api | ✅ | |
| D-30 transfer to an equivalent plan | ✅ | same key, same history; a degrading move waits for the consumer's consent; a consumer asks, the producer applies; in-app notifications, read and marked done by each person (a page lists them all) — `test/queue-and-notifications.test.js` |
| D-31 no aggregated quota | ✅ | one credential for several apis: R-12, waiting for G-23 |
| D-32 MVP scope, captured events | ✅ | GatewayEvent, CloudApimSecurityEvent, LLMUsageAudit and McpAudit verified with real traffic (`test/ai-usage.test.js`, `test/threat-protection.test.js`); the events of the event brokers extension: R-54 |
| D-33 two storage paths | ✅ | computed (exhaustive) + raw (optional): the raw path sampled by request, its errors kept, its headers optionally left out; personal data pseudonymised before anything is stored, in both paths — the address truncated (the default), hashed (HMAC, a key the product keeps) or left out, the signed-in user hashed (the default) or left out, the user agent, the paths templated; the calls rolled up by the hour (by id: late events counted, nothing twice), each path kept for its days; the dashboards read the rollups past the last purge, with exact counts — `test/ingestion.test.js`, `test/ingest-policy.test.js`; the exporters themselves: G-19 |
| D-35 draft → immutable snapshot | ✅ | rollback = redeploying a snapshot; its two points to instruct settled by the owner on 2026-11-20 (R-29): a shared policy group or resource published again republishes nothing — its teams are told, and upgrade the apis behind on demand, each by its own draft, snapshot and deployment —, and a remote catalog chooses its mode (draft by default, publish, deploy; a Kubernetes resource deploys by default) |
| D-36 ready for monetisation | ✅ | in the MVP, optional (R-35); a paid plan is published only with a linked account; Stripe ✅ through Stripe Connect (a workspace links its own account, its id only): Checkout with the price of the plan, signed webhooks kept once and handled by the queue, past due within the grace of the plan then suspended, resumed once paid, closed when cancelled, reconciliation every hour, the customer portal, closing and moving cancel or change the price at Stripe; the team pays — `test/payments.test.js`, `test/stripe.test.js`; free → paid move through a Checkout ✅; usage billing ✅ (R-34); a connector after Stripe: out of the MVP, Lago first |
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
| Adopt mode | ✅ the api taken over without being overwritten, with its subscriptions and their keys as they are (`test/adopt.test.js`) |
| Dry-run before a mass projection | ✅ deployments and catalog syncs |

## Spec §8, not yet drafted in the spec

| Topic | Status |
|---|---|
| Default portal template | ✅; customer templates: R-19 |
| Analytics and reporting | ✅ attribution at ingestion, console and portal dashboards; one request id from the caller to the backends, found in the request log |
| Lifecycle audit trail, changes and reads | ✅; webhook exporters ✅ (cursor, at least once, catch-up verified after an outage) |
| The catalogue as a discovery system | ✅ editorial categories and featured apis, consumer reviews, real usage; filtered and sorted on them (`test/discovery.test.js`) |
| IdP integration beyond validation | ⬜ R-21, not a priority (owner) |
| Deployment history tied to the snapshot | ✅ each deployment Otoroshi records carries the snapshot as its ref (`deployment_ref`); the console lists them by snapshot |

## Open questions of the spec

| Question | Status |
|---|---|
| Q-6 inventory of D-15 | ✅ [Inventory of the Otoroshi entities](./documentation/docs/gateway/inventory.mdx): every kind the gateway declares, projected, derived, made by the setup, minted, consumed or not used — checked against the gateway (`test/inventory.test.js`) |
| Q-8 computed path content, raw path lightening | ✅ hourly rollups by catalogue dimension, method, templated path and status class, durations as a histogram; calls 30 days, rollups 400, AI usage 90, raw 7 — set in the console; the cleaning at ingestion, its upstream counterpart logged as G-19 |
| Q-11 declarative format | ✅ settled by the owner on 2026-11-20 (R-28): one document per api-version, the version in `spec.version` (`metadata.version` still read), plans inside, pages beside — their truth when listed, their content inline or a file beside the document —, the policy groups and shared resources it pins by name (unique in a workspace) |
| Q-12 monetisation | ✅ settled by the owner on 2026-11-20 (R-35): in the MVP as implemented, optional (off without a Connect client id, without effect on a workspace that links no account); the team holds the billing account; a second connector after Stripe out of the MVP, Lago self-hosted first when a need comes |

## Reference catalogue test

✅ `test/reference-catalogue.test.js`: a reference catalogue (6 plans, 5 auth mechanisms, 4 approval modes, one api, one set of routes) projected on Otoroshi 18.0.1, reconciled, drift detected then repaired — including the JWT verifier derived from the Partner plan. 14 tests, stable; the test leaves nothing behind.

## Documentation

✅ Docusaurus site in `documentation/` (the same base as the other extensions: local search, dark by default), 20 pages, built with no broken link; the `documentation` GitHub workflow builds it and publishes it to GitHub Pages on every push to `main` (pull requests build only).

✅ **Screens tour** (`documentation/docs/screens.mdx`): 95 captures of every screen of the console and the portal, drawers, modals and menus included, light and dark, English and French, in `documentation/static/img/screens/`. Produced by `bun run screenshots` (headless Chromium), which also regenerates the page: run it again after every change of the interface. File names are stable (`console-api-flows.png`), so the concept pages show screens of the tour; the order is the order of capture.

## Otoroshi gaps

Logged as they were found in [`OTOROSHI-GAPS.md`](./OTOROSHI-GAPS.md) (G-1 to G-21), each with its upstream issue. All fixed upstream in `18.1.0-dev` (2026-11-19) but G-11 (not feasible in a distributed cluster), G-19 (the ingester's job) and G-21 (by design), not fixed by decision. The product requires 18.1 and follows the fixes gap by gap: the [table](./OTOROSHI-GAPS.md#where-we-are) says which are followed and which are still to follow.
