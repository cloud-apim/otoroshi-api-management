# Otoroshi gaps found while implementing

Running list of the data-plane gaps hit while building the prototype, to fix **upstream** (in
Otoroshi or an extension) — never by a workaround in the product's data model. Each entry says
what was observed, where in the source, what the product does, and the fix.

Found on Otoroshi `18.0.1`, source lines from the `18.1.0-dev` checkout in `../otoroshi`. Severity:
**high** = security or contract, **medium** = the product had to compensate, **low** = friction.

## Where we are

Every gap was fixed upstream on 2026-11-19, in `18.1.0-dev`, but three that are not by decision of
the owner (G-11, G-19, G-21). The product requires Otoroshi 18.1 (the setup check says so) and
drops its workarounds rather than keeping them for 18.0: nothing depends on the product with 18.0.

The product now **follows** the fixes, gap by gap: its workarounds and warnings go, the items they
blocked are done. Status: ✅ **followed** — the product relies on the fix; 🔜 **to follow** — fixed
upstream, the product still does what the last column says; ➖ **not fixed**, by decision.

| # | Issue | Gap | Severity | Status | The product |
|---|---|---|---|---|---|
| G-1 | [#2940](https://github.com/MAIF/otoroshi/issues/2940) | A `pending` ApiSubscription got an **enabled** apikey | high | ✅ | projects a subscription once it is effective, its key enabled while it is active |
| G-2 | [#2941](https://github.com/MAIF/otoroshi/issues/2941) | Deleting an ApiSubscription **revoked nothing** | high | ✅ | deletes the subscription, Otoroshi revokes its keys |
| G-3 | [#2942](https://github.com/MAIF/otoroshi/issues/2942) | An `Api` without a published plan has **open routes** | high | 🔜 | warns and asks for an explicit acknowledgement before deploying |
| G-4 | [#2943](https://github.com/MAIF/otoroshi/issues/2943) | On jwt / mtls / oauth2-remote / keyless plans, **any valid token passes**, subscribed or not | high | 🔜 | flags it on the plan (warning `any_token_passes`); R-15 waits for it |
| G-5 | [#2944](https://github.com/MAIF/otoroshi/issues/2944) | Resource filtering (restrictions) only exists on **apikey** plans | medium | 🔜 | flags it as not enforced on other kinds |
| G-6 | [#2945](https://github.com/MAIF/otoroshi/issues/2945) | No plan attribute for **selection rule**, **counter failure strategy**, **circuit breaker granularity** | medium | 🔜 | stored, projected as plan metadata, flagged as not enforced; R-14 waits for it |
| G-7 | [#2946](https://github.com/MAIF/otoroshi/issues/2946) | `ApiDeployment` could not carry the **external snapshot id** | medium | ✅ | the snapshot is the `deployment_ref` of the `Api`, the ref of each deployment Otoroshi records (R-33) |
| G-8 | [#2947](https://github.com/MAIF/otoroshi/issues/2947) | The catalog-deploy path was borrowed by a control plane via a **naming convention** | medium | ✅ | the `Api` is managed as code, `created_by=external=otoroshi-api-management` |
| G-9 | [#2948](https://github.com/MAIF/otoroshi/issues/2948) | `GatewayEvent` does not carry `apiRef` (plan, subscription) | low | 🔜 | attribution via the key's metadata + a client id cache at ingestion |
| G-10 | [#2949](https://github.com/MAIF/otoroshi/issues/2949) | A `PUT` on a missing entity was refused as **unauthorized**; the upsert said the opposite of what changed; certificates not enriched by the generic api | low | ✅ | the `Api` and every derived object are written with the upsert of the generic api |
| G-11 | [#2950](https://github.com/MAIF/otoroshi/issues/2950) | A new route / apikey becomes routable only after a few seconds, with no way to know when | — | ➖ | tests poll; the console says "deployed" once the write is accepted |
| G-12 | [#2951](https://github.com/MAIF/otoroshi/issues/2951) | Otoroshi's request tester with the **policy execution trace** is only reachable with a backoffice session | medium | 🔜 | the console replays requests through the gateway without the trace; R-24 waits for it |
| G-13 | [#2952](https://github.com/MAIF/otoroshi/issues/2952) | A **deprecated** plan loses its extractor: its consumers are no longer identified | high | 🔜 | validation warning on the plan; R-16 waits for it |
| G-14 | [#2953](https://github.com/MAIF/otoroshi/issues/2953) | A plan's key template only has an **absolute** `validUntil` | low | 🔜 | not offered (the field was removed from the model) |
| G-15 | [#2954](https://github.com/MAIF/otoroshi/issues/2954) | **oauth2-remote** plans check neither the **issuer** nor the **audience** of the token | high | 🔜 | warns on the plan (`token_claims_not_checked`) |
| G-16 | [#2955](https://github.com/MAIF/otoroshi/issues/2955) | On **mtls** plans the subject and issuer lists combine with **OR**, over a trust store shared by the whole gateway | medium | 🔜 | derives the issuer list from the plan's CAs when none is given; warns when a subject list stands alone |
| G-17 | [#2937](https://github.com/MAIF/otoroshi/issues/2937) | The `ApiSubscription` of a **jwt, mtls or oauth2-remote** plan carries **no consumer identity** | high | 🔜 | the client id is carried as metadata of the ApiSubscription; calls are attributed at ingestion |
| G-18 | [#2938](https://github.com/MAIF/otoroshi/issues/2938) | The consumers minted for a **jwt, mtls, oauth2-remote or keyless** plan were keyed by the **plan id alone**, and outlived their Api | high | ✅ | nothing to do: the consumers are named after the api and the plan, and leave with the `Api` |
| G-19 | [#2956](https://github.com/MAIF/otoroshi/issues/2956) | A data exporter sends the **url secrets** and the **personal data** of an event in clear, and **samples** nothing | — | ➖ | the ingester masks, pseudonymises and samples before it stores |
| G-20 | [#2957](https://github.com/MAIF/otoroshi/issues/2957) | An admin key narrowed by `otoroshi-access-rights` **read the secret of every admin key** of its teams | high | ✅ | nothing to change: its key stays super admin, for the global configuration (G-21) |
| G-21 | [#2958](https://github.com/MAIF/otoroshi/issues/2958) | The **global configuration** is readable by super admins only — by design | — | ➖ | the product's key keeps every right |

---

## G-1 — a pending subscription got an enabled key — high — followed

Upstream: [MAIF/otoroshi#2940](https://github.com/MAIF/otoroshi/issues/2940), fixed in 18.1: the key
of a subscription is enabled only while the subscription is `enabled`; the keys stored before are
disabled once at startup.

**The product.** Its approval workflow is its own: a subscription is projected once it is effective
(`active` → `enabled`, `suspended` → `disabled`), never while it waits for a producer or a payment
(`server/domain/subscriptions.js`, `sync_subscription`).

## G-2 — deleting a subscription revoked nothing — high — followed

Upstream: [MAIF/otoroshi#2941](https://github.com/MAIF/otoroshi/issues/2941), fixed in 18.1:
deleting a subscription deletes the keys of its `token_refs` (apikey, oauth2-local) or disables the
key it provisioned (jwt, mtls, oauth2-remote); a subscription whose keys could not be revoked is
kept, and the deletion answers a `500`.

**The product.** Closing, rejecting or deleting deletes the `ApiSubscription`, and only it
(`removeFromGateway`).

## G-3 — an Api without a published plan has open routes — high

Upstream: [MAIF/otoroshi#2942](https://github.com/MAIF/otoroshi/issues/2942).

**Observed.** `applyPlansPolicies` only adds `NgApiConsumerEnforcer` when at least one plan is
`published` (`next/models/Api.scala:1957`). Deprecating or closing the last plan opens the api to
anyone.

**Product meanwhile.** Validation warning `open_routes`; the deploy dialog requires an explicit
"I understand: the routes will be open" acknowledgement.

**Upstream fix.** An `Api` in `published` state with no published plan should deny by default
(or require an explicit `open: true` / a keyless plan to be open).

## G-4 — any valid token passes on non-apikey plans — high

Upstream: [MAIF/otoroshi#2943](https://github.com/MAIF/otoroshi/issues/2943).

**Observed.** On `jwt`, `mtls`, `oauth2-remote` and `keyless` plans the extractor mints the
consumer itself on the first call (`createIfMissing`, e.g. `next/models/Api.scala:1870`). Any
token signed by the verifier — or any certificate matching the DN regexes — is served and counted,
whether a subscription exists or not. Verified in the reference catalogue test: a JWT with an arbitrary
`client_id` passes on its jwt plan.

**Product meanwhile.** Warning `any_token_passes` on the plan; the application declares its
expected `client_id` so that what the gateway sees can be reconciled, but nothing stops an
unsubscribed caller.

**Upstream fix.** A plan option "subscription required": the extractor resolves the minted
consumer against the existing `ApiSubscription`s of the plan (by client id) and refuses when there
is none — instead of `createIfMissing`.

## G-5 — resource filtering only on apikey plans — medium

Upstream: [MAIF/otoroshi#2944](https://github.com/MAIF/otoroshi/issues/2944).

**Observed.** `ApiPlan.apikeyTemplate` (`next/models/Api.scala:789`) only carries a full template
(with `restrictions`) for the `apikey` kind; the other kinds get a template with tags and metadata
only, so a jwt / mtls / oauth2 / keyless plan cannot restrict the resources it gives access to.

**Product meanwhile.** Restrictions are projected on apikey plans; on the other kinds the console
says the filter is not enforced.

**Upstream fix.** Let every plan kind carry `restrictions` (and the rest of the key template)
applied to the consumer it mints.

## G-6 — no plan attribute for selection rule, counter failure, circuit breaker — medium

Upstream: [MAIF/otoroshi#2945](https://github.com/MAIF/otoroshi/issues/2945).

**Observed.** `ApiPlan` has no field for: an expression that disambiguates two plans of the same
kind whose extractors can both succeed; what to do when the distributed quota counter is
unreachable (let pass / refuse); a circuit breaker per subscription instead of per api. All three are enforcement, hence projected.

**Product meanwhile.** Stored in the plan, projected as `metadata.apim_selection_rule`,
`apim_counter_failure`, `apim_circuit_breaker`, and flagged as not enforced.

**Upstream fix.** Three plan attributes read by the extractors / `NgApiConsumerEnforcer` /
backend client.

## G-7 — ApiDeployment could not carry the product snapshot — medium — followed

Upstream: [MAIF/otoroshi#2946](https://github.com/MAIF/otoroshi/issues/2946), fixed in 18.1: an
`ApiDeployment` has a `ref`, taken from the `deployment_ref` metadata of an api managed as code, and
the plans in its definition; the history size is configurable
(`OTOROSHI_APIS_DEPLOYMENTS_HISTORY_SIZE`, 5 by default).

**The product.** The snapshot deployed is the `deployment_ref` of the `Api`: each deployment
Otoroshi records carries it as its `ref`, and the console lists the gateway's deployments by
snapshot (R-33). The product keeps the full history itself.

## G-8 — the catalog-deploy path was borrowed by convention — medium — followed

Upstream: [MAIF/otoroshi#2947](https://github.com/MAIF/otoroshi/issues/2947), fixed in 18.1: an
outside tool marks the apis it manages as code with `created_by=external=<tool id>`; each write of
such an api is a deploy, and a remote catalog never takes it over.

**The product.** Its `Api`s carry `created_by=external=otoroshi-api-management`
(`OWNER_MARKER`, `server/otoroshi/client.js`).

## G-9 — GatewayEvent does not carry apiRef — low

Upstream: [MAIF/otoroshi#2948](https://github.com/MAIF/otoroshi/issues/2948).

**Observed.** `GatewayEvent` carries the route (with `Otoroshi-Api-Ref` in its metadata) and the
identity (client id, and the key's metadata), not the key's `apiRef = {api, plan, sub}`.

**Product meanwhile.** The ingester attributes each call from a client id → subscription cache,
falls back on the key metadata the product projects (`apim_subscription_id`, `id_ref`), and parses
the `<kind>_<planId>_` prefix of gateway-minted consumers. Verified: real calls are attributed to
api, plan, subscription and application.

**Upstream fix.** Add `apiRef` to the exported identity (or the event) — attribution without
re-correlation, for every consumer of the data exporters.

## G-10 — writes of the generic api — low — followed

Upstream: [MAIF/otoroshi#2949](https://github.com/MAIF/otoroshi/issues/2949), fixed in 18.1: a
`PUT` on a missing entity answers `404`, a `POST` of an id already used `409`; the
`Otoroshi-Entity-Updated` header of the upsert says whether the stored entity changed; the generic
api computes the fields of a certificate from its chain on every write, as its controller does.

**The product.** The `Api`, the JWT verifiers, the auth modules and the certificates are written with
the upsert of the generic api, `POST /apis/<group>/<version>/<plural>/<id>`, one call each
(`oto.upsertApi`, `oto.upsertEntity`, `DERIVED_PATHS`).

## G-11 — no signal when a write becomes routable — not fixed

Upstream: [MAIF/otoroshi#2950](https://github.com/MAIF/otoroshi/issues/2950), closed. **Not fixed (owner)**: in a
distributed cluster — several nodes, several clocks — knowing when a write is live everywhere
would take a shared store.

**Observed.** After a deployment or a new apikey, the first calls get `404 no route found` /
`401` for a few seconds, until the proxy state picks the change up. Nothing tells a writer when the
change is live.

**The product.** Tests poll the gateway; the console says "deployed" when the write is accepted —
and stays so.

## G-12 — the request tester with the execution trace is backoffice-only — medium

Upstream: [MAIF/otoroshi#2951](https://github.com/MAIF/otoroshi/issues/2951).

**Observed.** Otoroshi records an `NgExecutionReport` (every step and plugin, with timings) for a
request carrying `Otoroshi-Try-It-Request-Id` only when that id was enabled by
`TryItController.call` (`next/controllers/tryit.scala`), routed as `POST /bo/api/tryit`
(`conf/routes:97`) behind `BackOfficeActionAuth`. An Admin API key cannot reach it, so a control
plane cannot replay a request through an api "in diagnostic mode, with the trace of the policies"
— the console half of testing.

**Product meanwhile.** The console composer replays the request through the gateway (real
routing, real plans, real keys) and shows status, headers, body and latency, and says that the
policy trace needs this upstream change.

**Upstream fix.** Expose the request tester on the Admin API (e.g. `POST /api/routes/_tryit`, and a
variant taking an `Api` id + route id), returning the response and the execution report — or let
an admin apikey enable a report id for the next request.

## G-13 — a deprecated plan loses its extractor — high

Upstream: [MAIF/otoroshi#2952](https://github.com/MAIF/otoroshi/issues/2952).

**Observed.** `applyPlansPolicies` builds the extractors and the enforcer from the **published**
plans only (`next/models/Api.scala:1949`). A plan moved to `deprecated` — meant as "still served,
closed to new subscriptions" — gets no extractor any more: the consumers of a deprecated jwt, mtls,
oauth2-remote or keyless plan are no longer identified, and those of a deprecated apikey plan only
keep working while another published apikey or oauth2-local plan still installs `ApikeyCalls`.
Found by reading the source while documenting; not reproduced on the gateway yet.

**Product meanwhile.** A validation warning on every deprecated plan whose extractor no published
plan installs (`deprecated_without_extractor`).

**Upstream fix.** Install the extractors of `published` **and** `deprecated` plans (deprecation
closes subscriptions, not access); keep `closed` and `staging` out.

## G-14 — no key validity relative to the subscription — low

Upstream: [MAIF/otoroshi#2953](https://github.com/MAIF/otoroshi/issues/2953).

**Observed.** The key template of a plan (`ApikeyAccessModeConfiguration.validUntil`,
`next/models/Api.scala:529`) is an absolute date, applied as is to every key the plan mints.
"Keys of this plan are valid 90 days from the subscription" cannot be expressed; a `validUntil`
written on a key afterwards is overwritten by the next plan update (`updateApikeyFromPlan`).

**Product meanwhile.** Not offered: the unused `validityDays` field was removed from the model.

**Upstream fix.** A relative validity (`validity: 90d`) in the plan's key template, turned into
`validUntil` when the key is minted.

## G-15 — oauth2-remote plans check neither issuer nor audience — high

Upstream: [MAIF/otoroshi#2954](https://github.com/MAIF/otoroshi/issues/2954).

**Observed.** An `oauth2-remote` plan installs `NgOidcApikeyExtractor`, which validates the token
with `LocalJwtVerifier().copy(enabled = true, algoSettings = oidcModule.jwtVerifier.get)`
(`next/plugins/apimgmt.scala:681`). The default strategy of `LocalJwtVerifier` is
`PassThrough(VerificationSettings(Map.empty))` (`models/JWTVerifier.scala:1921`): only the
signature and the dates are checked. A token the same authorization server issued for another
client or another audience is accepted by the plan. `OAuth2RemoteAccessModeConfiguration`
(`next/models/Api.scala:461`) has no field to express the expected issuer or audience.

**Product meanwhile.** A validation warning on every published oauth2-remote plan
(`token_claims_not_checked`); the plan describes no issuer or audience it could not enforce.

**Upstream fix.** `issuer` and `audience` in `OAuth2RemoteAccessModeConfiguration` (defaulting to
the auth module's discovery document and client id), turned into the verification settings of the
extractor's verifier.

## G-16 — mtls subject and issuer lists combine with OR — medium

Upstream: [MAIF/otoroshi#2955](https://github.com/MAIF/otoroshi/issues/2955).

**Observed.** `NgClientCertApikeyExtractor.matches` accepts a certificate when its subject matches
**one of the subject patterns or** its issuer matches one of the issuer patterns
(`next/plugins/apimgmt.scala:486`). A plan cannot require both "issued by this CA" and "a subject
of this shape". Meanwhile the server trust store holds every certificate of the gateway plus the
JDK CAs (`ssl/ssl.scala:1428`, `includeJdkCa`): a client certificate from any trusted authority
whose subject matches a subject pattern passes.

**Product meanwhile.** When an mtls plan lists trusted CAs and no issuer pattern, the projection
derives the issuer patterns from the subjects of those CAs (exact match). A plan with subject
patterns and no issuer pattern gets a validation warning (`subject_without_issuer`).

**Upstream fix.** Combine the two lists with AND when both are given (or a `match: all | any`
switch), and an optional per-plan list of trusted CA certificate ids checked on the chain.

## G-17 — token and certificate subscriptions carry no consumer identity — high

Upstream: [MAIF/otoroshi#2937](https://github.com/MAIF/otoroshi/issues/2937).

**Observed.** On `jwt`, `mtls` and `oauth2-remote` plans, an `ApiSubscription` creates nothing
and carries no identity of its consumer — `owner_ref` is the application, `token_refs` stays
empty. `ApiSubscription.handleSubscriptionChanged` (`next/models/Api.scala:1188`) only creates
(`createNewApikeyFromPlan`) and updates (`updateApikeyFromPlan`) keys for `apikey` and
`oauth2-local` subscriptions. The extractor builds the consumer at call time as
`<kind>_<planId>_<clientId>` — the prefix is set by `pluginsForPlan`
(`next/models/Api.scala:1868`, `:1894`, `:1917`) — without looking at any subscription. So
suspending or closing such a subscription changes nothing at the gateway, and a call cannot be tied
to the subscription it was made under — even once G-4 refuses unsubscribed callers, there is
nothing to resolve them against.

**What makes the fix small.** `ApikeyFromPlan.resolveOrCreate` (`next/plugins/apimgmt.scala:200`)
never mints over an existing key, and refuses a disabled one (401 and `RevokedApiKeyUsageAlert`).
A key `<kind>_<planId>_<clientId>` saved ahead of the first call, enabled or not, therefore decides
for that consumer.

**Why the product does not save that key itself.** It would rely on the extractor's naming
convention, not on a contract; it would copy what `generateNewApikeyFromPlan` builds from a plan
(quotas, throttling, restrictions, rotation) and keep it in step with every plan change, which
Otoroshi only does for `apikey` and `oauth2-local` subscriptions; and a closed subscription would
have to leave its key disabled forever, since a deleted one is minted again at the next call. It
is the data plane's job.

**Product meanwhile.** The application declares its expected client id and its client
certificates. The ApiSubscription of a jwt, mtls or oauth2-remote plan carries that client id as
the metadata `apim_client_id`, re-projected when the application changes it and checked for
drift: ignored by Otoroshi today, in place once it reads one. The ingester attributes
`<kind>_<planId>_<clientId>` consumers to the subscription of the application that declared that
client id. The certificates of an application are derived as certificates of the gateway only
while it has an active subscription to an mtls plan: suspending or closing removes the trust in a
self-signed certificate (one signed by a CA the gateway trusts is not affected).

**Upstream fix** (detailed in the issue). A `client_id` field on `ApiSubscription`, as the plan
reads it, immutable, unique per plan. On create, Otoroshi saves the key `<plan prefix><client_id>`
with `generateNewApikeyFromPlan` — or takes over the one minted on the fly — and references it in
`token_refs`; on update and on plan changes the key follows the plan and the status (enabled only
when the subscription is); deleting the subscription leaves its key disabled. Every key minted for
these plans, on the fly or by a subscription, carries the metadata `api_id`, `plan_id`,
`access_mode` (`jwt`, `mtls`, `oauth2-remote`) and `plan_consumer: "true"`, written after the
template's. G-4's "subscription required" then only turns `create_if_missing` off: an unknown
client id has no key and is refused.

## G-18 — consumers minted for a plan were keyed by the plan id alone — high — followed

Upstream: [MAIF/otoroshi#2938](https://github.com/MAIF/otoroshi/issues/2938), fixed in 18.1: the
consumers of jwt, mtls, oauth2-remote and keyless plans are named `<kind>_<api id>_<plan id>_<client
id>` (the keys minted before are renamed once at startup); a key whose `apiRef` names another api or
plan is refused; deleting an Api deletes its subscriptions, their keys and the keys its plans minted.

**The product.** Nothing to do any more: the warning `plan_id_shared` and the cleanup of minted keys
in the tests are gone. Deleting an api from the product deletes its `Api`, and Otoroshi the rest.
Undeploying disables the `Api` (no route) instead of deleting it: deleting it would take its
subscriptions and their keys along, and the consumers would get new keys at the next deployment.

## G-19 — data exporters send personal data and url secrets in clear, unsampled — not fixed

Upstream: [MAIF/otoroshi#2956](https://github.com/MAIF/otoroshi/issues/2956), closed. **Not fixed (owner)**: masking,
pseudonymising and sampling are the job of whoever stores the events — here the ingester —, and
other uses of the same events need these data.

**Observed.** Since the 18, `GatewayEvent.writes` masks the credential headers and, by name, the
secret fields of the configurations it embeds (`app/events/analytics.scala:478`, unless
`OTOROSHI_EVENTS_MASK_SECRETS` is off). The rest goes out as it is: `url` with its query
(`analytics.scala:493`) — an `api_key` or a `token` passed as a parameter included —, `from`
(`:495`), the `X-Forwarded-For` / `X-Real-IP` / `Forwarded` headers, the identity of a user signed in
on a private app (its email), the user agent and the geolocation derived from the address. A data
exporter can filter events (`acceptEvent`, `app/events/OtoroshiEventsActor.scala:225`) and project
fields (`project`, `:382`), but has no notion of pseudonymisation nor of sampling: only a custom
transform, a wasm plugin or a workflow (`customTransformAsync`, `:489`), can do it, written by each
operator. So every exporter of the gateway — Kafka, Elastic, a webhook, a file — receives the same
personal data in clear, and keeps everything.

**The product.** The ingester masks the url secrets, pseudonymises (truncation of the
address, keyed hash of the address or of the user, path templates) and samples its raw path before
anything is stored, as its policy says (**Gateway → Ingestion**). What reaches it has transited in
clear on the exporter's connection; the other exporters of the gateway are not covered.

## G-20 — a narrowed admin key read the secrets of the other admin keys — high — followed

Upstream: [MAIF/otoroshi#2957](https://github.com/MAIF/otoroshi/issues/2957), fixed in 18.1: the
secret of an apikey authorized on the admin api is not shown to a caller that could not have granted
it.

**The product.** Nothing to change: the setup makes the product an admin key of its own,
`apim_product_admin`, distinct from the operator's, rotated without it (`--rotate-key`), named in the
audit of the gateway — and super admin, since it reads the global configuration (G-21).

## G-21 — the global configuration is readable by super admins only — by design

Upstream: [MAIF/otoroshi#2958](https://github.com/MAIF/otoroshi/issues/2958). **Not fixed: the expected and intended
behaviour (owner).**

**Observed.** `GET /api/globalconfig` checks `RightsChecker.SuperAdminOnly`
(`app/controllers/adminapi/GlobalConfigController.scala:27`): a right on
`config.otoroshi.io/global-configs` does not open it. A narrowed key therefore cannot read the TLS
settings (`tlsSettings.clientAuth`, `trustedCAsServer`) nor the `env` the local vault resolves
`${vault://local/…}` against.

**The product.** Its key is a super admin key, and stays one: the warnings about the TLS client
authentication of mtls plans and the vault references of the promotion read the global
configuration.

