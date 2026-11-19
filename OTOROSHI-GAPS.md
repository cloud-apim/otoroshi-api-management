# Otoroshi gaps found while implementing

Running list of the data-plane gaps hit while building the prototype, to fix **upstream** (in
Otoroshi or an extension) — never by a workaround in the product's data model. Each entry says
what was observed, where in the source, what the product does meanwhile, and the proposed fix.

Reference: Otoroshi `18.0.1` (the docker stack runs `otoroshi.jar` 18.0.1; source lines from the
`18.1.0-dev` checkout in `../otoroshi`). Severity: **high** = security or contract, **medium** =
the product has to compensate, **low** = friction.

Size of the fix in Otoroshi, tests included — an estimate from the work each issue describes: **S**
≈ half a day to a day, **M** ≈ two to three days, **L** ≈ a week. **Unblocks**: the item of
[PROGRESS.md](./PROGRESS.md) waiting for it.

| # | Issue | Gap | Severity | Size | Unblocks | Product meanwhile |
|---|---|---|---|---|---|---|
| G-1 | [#2940](https://github.com/MAIF/otoroshi/issues/2940) | A `pending` ApiSubscription gets an **enabled** apikey | high | S | — | never projects a pending subscription |
| G-2 | [#2941](https://github.com/MAIF/otoroshi/issues/2941) | Deleting an ApiSubscription **revokes nothing** | high | S | — | deletes the keys first, then the subscription |
| G-3 | [#2942](https://github.com/MAIF/otoroshi/issues/2942) | An `Api` without a published plan has **open routes** | high | M | — | warns and asks for an explicit acknowledgement before deploying |
| G-4 | [#2943](https://github.com/MAIF/otoroshi/issues/2943) | On jwt / mtls / oauth2-remote / keyless plans, **any valid token passes**, subscribed or not | high | M, after G-17 | R-15 | flags it on the plan (warning `any_token_passes`) |
| G-5 | [#2944](https://github.com/MAIF/otoroshi/issues/2944) | Resource filtering (restrictions) only exists on **apikey** plans | medium | M | — | flags it as not enforced on other kinds |
| G-6 | [#2945](https://github.com/MAIF/otoroshi/issues/2945) | No plan attribute for **selection rule**, **counter failure strategy**, **circuit breaker granularity** | medium | L | R-14 | stored, projected as plan metadata, flagged as not enforced |
| G-7 | [#2946](https://github.com/MAIF/otoroshi/issues/2946) | `ApiDeployment` cannot carry the **external snapshot id**, and keeps only 5 entries | medium | S | R-33 | snapshot id written in `Api.metadata` |
| G-8 | [#2947](https://github.com/MAIF/otoroshi/issues/2947) | The catalog-deploy path is borrowed by a control plane via a **naming convention** | medium | S | — | writes `created_by=remote_catalog=otoroshi-apim-deployment` |
| G-9 | [#2948](https://github.com/MAIF/otoroshi/issues/2948) | `GatewayEvent` does not carry `apiRef` (plan, subscription) | low | S | — | attribution via the key's metadata + a client id cache at ingestion |
| G-10 | [#2949](https://github.com/MAIF/otoroshi/issues/2949) | A `PUT` on an entity that does not exist is refused as **unauthorized**; the upsert (`POST` on the id) has its `Otoroshi-Entity-Updated` header inverted | low | S | — | the `Api` is written with the upsert; the derived objects through their own controllers, `GET` then `POST` or `PUT` |
| G-11 | [#2950](https://github.com/MAIF/otoroshi/issues/2950) | A new route / apikey becomes routable only after a few seconds, with no way to know when | low | L | — | tests poll; the console says "deployed" once the write is accepted |
| G-12 | [#2951](https://github.com/MAIF/otoroshi/issues/2951) | Otoroshi's request tester with the **policy execution trace** is only reachable with a backoffice session, not through the Admin API | medium | M | R-24 | the console replays requests through the gateway without the trace |
| G-13 | [#2952](https://github.com/MAIF/otoroshi/issues/2952) | A **deprecated** plan loses its extractor: its consumers are no longer identified | high | S | R-16 | validation warning on the plan |
| G-14 | [#2953](https://github.com/MAIF/otoroshi/issues/2953) | A plan's key template only has an **absolute** `validUntil`: no validity relative to the subscription | low | S | — | not offered (the field was removed from the model) |
| G-15 | [#2954](https://github.com/MAIF/otoroshi/issues/2954) | **oauth2-remote** plans check neither the **issuer** nor the **audience** of the token | high | S | — | warns on the plan (`token_claims_not_checked`) |
| G-16 | [#2955](https://github.com/MAIF/otoroshi/issues/2955) | On **mtls** plans the subject and issuer lists combine with **OR**, over a trust store shared by the whole gateway | medium | M | — | derives the issuer list from the plan's CAs when none is given; warns when a subject list stands alone |
| G-17 | [#2937](https://github.com/MAIF/otoroshi/issues/2937) | The `ApiSubscription` of a **jwt, mtls or oauth2-remote** plan carries **no consumer identity**: suspending or closing it changes nothing at the gateway | high | M | — | the application declares its client id and certificates; the client id is carried as metadata of the ApiSubscription; calls are attributed at ingestion; the certificates of an application are trusted only while it has an active mtls subscription |
| G-18 | [#2938](https://github.com/MAIF/otoroshi/issues/2938) | The consumers minted for a **jwt, mtls, oauth2-remote or keyless** plan are keyed by the **plan id alone**, and outlive their Api: two Apis with a plan of the same id share them | high | M (key migration) | — | plan ids created in the console are unique; warning `plan_id_shared` on the draft and on the deployment; the end-to-end tests remove the keys the gateway minted for them |
| G-19 | [#2956](https://github.com/MAIF/otoroshi/issues/2956) | A data exporter sends the **url secrets** and the **personal data** of an event in clear — caller address, forwarding headers, signed-in user, user agent — and **samples** nothing: only a custom transform (wasm, workflow) can | medium | L | — | the ingester masks, pseudonymises and samples before it stores, as its policy says; the events reach it in clear |
| G-20 | [#2957](https://github.com/MAIF/otoroshi/issues/2957) | An admin key narrowed by `otoroshi-access-rights` **reads the secret of every admin key** of its teams, the super admin ones included: the narrowing does not hold | high | M | — | the setup makes the product a key of its own, with every right, rather than a narrowed one that would protect nothing |
| G-21 | [#2958](https://github.com/MAIF/otoroshi/issues/2958) | The **global configuration** is readable by super admins only: a narrowed key cannot read the TLS settings nor the `env` of the local vault | medium | M | — | the product's key keeps every right; with a narrowed key the vault references and the TLS checks would fail |

Total: 9 S + 9 M + 3 L. Quick wins among the high ones: G-1, G-2, G-13, G-15 (S each).

## Roadmap

Not everything in Otoroshi first: **the contract first**, the product meanwhile on what does not
depend on it, the rest along the way.

**Why not everything at once.**

- 16 gaps out of 21 block nothing in the product: it has a workaround or a warning. Only five
  unblock an item: G-4 (R-15), G-6 (R-14), G-7 (R-33), G-12 (R-24), G-13 (R-16).
- The three large ones (G-6, G-11, G-19, about three weeks on their own) are the least blocking:
  G-6 unblocks R-14, G-11 and G-19 nothing. Doing them first would freeze the product for little.
- The other way round, going on with the product without Otoroshi means building on a contract
  that is going to change, and doing it again.

**1. The contract, in Otoroshi.** The high gaps that change what the product projects:
G-1, G-2, G-13, G-15, then G-17, G-18, G-4 (in that order: G-4 builds on the identity G-17 gives
the subscription, G-18 touches the same key prefix), then G-3, G-7. 5 S + 4 M, about two weeks by
hand, about twelve hours with an agent. They are security holes for every user of the `Api`
entity of Otoroshi 18, product or not: worth it anyway.

**2. Meanwhile, the product on what does not depend on the projection:** R-39, R-30, R-13, R-36,
R-38, R-47, R-27, R-22, R-23, R-42, R-20, R-34 — several days of work with no conflict.

**3. Then the product follows the fixes.**

- Its workarounds go: the order of deletion (G-2), the client id carried as metadata (G-17), the
  warnings `any_token_passes`, `token_claims_not_checked`, `plan_id_shared`.
- R-15 and R-16, unblocked.
- The items that touch the projection: R-12, R-17, R-25, R-10.

**4. The rest, along the way:** G-5, G-6, G-12, G-16, G-21, the low ones, then G-11 and G-19. G-20
as well: nobody uses narrowed keys.

**The minimum version.** One version of Otoroshi only: the product requires the release that
carries the fixes of step 1, and drops its workarounds rather than keeping them for 18.0 — nothing
depends on the product with 18.0 yet, and a gap is fixed in Otoroshi, not in the model. The version
check of the setup moves from 18 to that release.

---

## G-1 — a pending subscription gets an enabled key — high

Upstream: [MAIF/otoroshi#2940](https://github.com/MAIF/otoroshi/issues/2940).

**Observed.** `ApiSubscription.generateNewApikeyFromPlan` mints the key with
`enabled = subscription.status != ApiSubscriptionDisabled` (`next/models/Api.scala:1114`). A
`pending` (or any custom) status therefore yields an **enabled** key: projecting a subscription
under review gives access before the review.

**Product meanwhile.** The approval workflow is the product's: a subscription is only
projected once `active` (status `enabled`), `suspended` becomes `disabled`. Pending ones are
never written to the gateway (`server/domain/subscriptions.js`, `sync_subscription`).

**Upstream fix.** Enable the key only when `status == enabled` (deny by default for pending and
custom statuses).

## G-2 — deleting a subscription revokes nothing — high

Upstream: [MAIF/otoroshi#2941](https://github.com/MAIF/otoroshi/issues/2941).

**Observed.** `ApiSubscription.deleteValidator` is a no-op (`next/models/Api.scala:1341`): the
apikeys referenced by `token_refs` stay in the datastore, enabled, still carrying their `apiRef`.

**Product meanwhile.** Closing / rejecting / deleting deletes the apikeys explicitly, then the
subscription (`removeFromGateway`, and `purge_api` when an api is deleted).

**Upstream fix.** Cascade-delete (or disable) the keys of `token_refs` on subscription delete,
like the `Closed` plan path already does on update.

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

## G-7 — ApiDeployment cannot carry the product snapshot — medium

Upstream: [MAIF/otoroshi#2946](https://github.com/MAIF/otoroshi/issues/2946).

**Observed.** `withDeployment` records `owner = metadata.created_by` and a `deploymentDefinition`
limited to routes, backends, flows and documentation (`next/models/Api.scala:2142`, `2178`), and
keeps the last **5** entries (`:2187`). Nothing ties a gateway-side deployment to the immutable
snapshot that produced it, and the plans are not in it.

**Product meanwhile.** The snapshot id and number go into `Api.metadata`
(`apim_snapshot_id`, `apim_snapshot_number`); the product keeps the full history itself.

**Upstream fix.** An optional `ref` (external snapshot id) on `ApiDeployment`, filled from the
write, and the plans in `deploymentDefinition`.

## G-8 — the catalog-deploy path is borrowed by convention — medium

Upstream: [MAIF/otoroshi#2947](https://github.com/MAIF/otoroshi/issues/2947).

**Observed.** Any `Api` write whose `metadata.created_by` starts with `remote_catalog=` is a
catalog deploy (`isWrittenByCatalog`, `next/models/Api.scala:2150`): `production_readonly` is
lifted and the api may be created already published. The product uses it with the id
`otoroshi-apim-deployment`, which no real remote catalog may use.

**Upstream fix.** A recognised marker for an external control plane (e.g.
`created_by=control_plane=<id>` or an explicit deploy flag), so this stops being a convention.

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

## G-10 — a PUT on a missing entity is refused as unauthorized — low

Upstream: [MAIF/otoroshi#2949](https://github.com/MAIF/otoroshi/issues/2949).

**Observed.** The generic api has an **upsert**: `POST /apis/<group>/<version>/<plural>/<id>`
creates the entity (`201`) or replaces it (`200`), with the same write hooks as a `POST` on the
collection or a `PUT` (`GenericApiController.upsert`, `api/api.scala:2592`; checked on 18.0.1: a
catalog-marked `Api` written through it is deployed as with a `PUT`). What stays:

- a `PUT` on an id that does not exist answers `401 unauthorized: resource does not exists`
  (`api/api.scala:2677`), a `POST` on the collection with an id already used
  `401 unauthorized: resource already exists` (`api/api.scala:2456`): a `404` and a `409` would say
  what happens;
- the `Otoroshi-Entity-Updated` header of the upsert is inverted: `hasChanged = oldEntity ==
  newEntity` (`api/api.scala:2636`) — `false` when the entity changed;
- the generic api does not enrich the certificates it writes (subject, issuer, validity read from
  the chain): `CertificatesController` does (`entity.enrich()`), the generic resource does not.

**Product meanwhile.** The `Api` is written with the upsert, one call (`oto.upsertApi`). The
derived objects — JWT verifiers, certificates, auth modules — go through their own controllers
(`/api/verifiers`, `/api/certificates`, `/api/auths`), which have no upsert: `GET`, then `PUT` or
`POST` (`oto.upsertEntity`); the certificates have to, to be enriched.

**Upstream fix.** A `404` and a `409` instead of the `401`s; the header the right way round,
comparing the stored entity before and after the write; the certificates enriched on the generic
api as on their controller.

## G-11 — no signal when a write becomes routable — low

Upstream: [MAIF/otoroshi#2950](https://github.com/MAIF/otoroshi/issues/2950).

**Observed.** After a deployment or a new apikey, the first calls get `404 no route found` /
`401` for a few seconds, until the proxy state picks the change up. Nothing tells a writer when the
change is live.

**Product meanwhile.** Tests poll the gateway; the console says "deployed" when the write is
accepted.

**Upstream fix.** Expose the proxy state version (or a "live since" timestamp per entity) on the
admin API so a control plane can wait for it.

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

## G-18 — consumers minted for a plan are keyed by the plan id alone — high

Upstream: [MAIF/otoroshi#2938](https://github.com/MAIF/otoroshi/issues/2938).

**Observed.** The extractors of `jwt`, `mtls`, `oauth2-remote` and `keyless` plans mint their
consumer as the apikey `<kind>_<planId>_<clientId>` — the prefix is set by `pluginsForPlan`
(`next/models/Api.scala:1815`, `:1868`, `:1894`, `:1917`). A plan id is only unique within its
Api. `ApikeyFromPlan.resolveOrCreate` resolves an existing key first, and `NgApiConsumerEnforcer`
(`next/plugins/apimgmt.scala:757`) enforces its restrictions and quotas without checking that the
key belongs to the api called (`authorizedOnApi` is not consulted). So two Apis with a plan of the
same id share the keys of their consumers: a call to one is counted against the quotas, the
restrictions and the `apiRef` of whichever Api minted the key first. Deleting an Api does not
delete these keys either (the `Api` resource has no delete validator): they stay, and the next Api
reusing the plan id picks them up. Seen on the development stack: the key
`jwt_plan_partner_agency-north`, minted for an Api deleted since, served the next run of the
reference test, on a new Api, with the old Api in its `apiRef`.

**Product meanwhile.** Plan ids created in the console are prefixed uuids, unique; declarative
documents choose theirs (`plan_petstore_discovery`). A plan of these kinds whose id and kind
another api also has gets the warning `plan_id_shared`: on the draft, against the drafts of the
other apis of the installation, and on the deployment plan, against the Apis of the gateway —
managed by the product or not. The keys left by a deleted Api cannot be seen without listing every
key of the gateway: nothing warns about them. The end-to-end tests remove the keys the gateway
minted for their api.

**Upstream fix** (detailed in the issue). The api id in the prefix (`<kind>_<apiId>_<planId>_`),
computed by one function shared with the subscription keys of G-17; `resolveOrCreate` never uses
an existing key whose `apiRef` names another api or plan; a one-shot migration moves the keys
already minted to the new ids, keeping their secret and their enabled flag; deleting an Api
deletes the keys minted for it, its ApiSubscriptions and their keys.

## G-19 — data exporters send personal data and url secrets in clear, unsampled — medium

Upstream: [MAIF/otoroshi#2956](https://github.com/MAIF/otoroshi/issues/2956).

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

**Product meanwhile.** The ingester masks the url secrets, pseudonymises (truncation of the
address, keyed hash of the address or of the user, path templates) and samples its raw path before
anything is stored, as its policy says (**Gateway → Ingestion**). What reaches it has transited in
clear on the exporter's connection; the other exporters of the gateway are not covered.

**Upstream fix.** A `privacy` block on the data exporter, applied before its projection:
`maskQuerySecrets` (parameter names matching a list, as the secret headers), `ip`
(`keep | truncate | hash | drop`, applied to `from` and to the forwarding headers), `user`
(`keep | hash | drop`), `userAgent` (`keep | drop`), and a keyed hash whose key is a vault reference,
so that two exporters can share pseudonyms or not. And a `sampling` block: a rate decided by
`reqId`, so that the events of one request stay together, with `keepErrors`. The same options
belong to the analytics module of the 18, which stores the same events.

## G-20 — a narrowed admin key reads the secrets of the other admin keys — high

Upstream: [MAIF/otoroshi#2957](https://github.com/MAIF/otoroshi/issues/2957).

Reproduced on 18.0.1; MAIF/otoroshi#2936 guards rewriting and deleting a stronger admin or apikey,
not reading its secret — the read path is unchanged at `a9685ede9` (read in the source, not run on a
build of it). Little exposure in practice: narrowed admin keys are seldom used.

**Observed.** An admin key (authorized on the admin api group) can be narrowed by its metadata
`otoroshi-access-rights`: tenants, teams, kinds of entities (`app/actions/api.scala:136`). Its calls
then run as a back office user with those rights. Reading an apikey checks only that the caller can
read it (`canUserRead`, `app/utils/controllers.scala:1026`) and writes it whole
(`ApiKeysController.writeEntity`, `app/controllers/adminapi/ApiKeysController.scala:716`, the
`clientSecret` at `app/models/apikey.scala:527`). Writing an admin key is guarded
(`canUserGrantApikeyRights`, `app/actions/api.scala:30`), reading it is not: a key narrowed to the
apikeys of the default team reads the secret of the super admin key of that team, and calls with
it. Seen on the development stack: a key limited to eight kinds read `apim-admin-client`'s secret.
Only personal admin keys are spared (`PersonalAdminApikey.canRead`).

**Product meanwhile.** The setup makes the product an admin key of its own, `apim_product_admin`,
with every right: distinct from the operator's, rotated without it (`--rotate-key`), named in the
audit of the gateway. It does not narrow it — the narrowing would protect nothing, and G-21 would
break the product.

**Upstream fix.** The secret of an apikey authorized on the admin api (the back office group or
descriptor) is never written to a caller who could not grant that key (`canUserGrantApikeyRights`
false): masked in the reads, the lists and the exports, like the personal admin keys. Then the
product's key can be narrowed to the tenant, the teams and the kinds it uses — apis and
apisubscriptions, apikeys, certificates, auth modules, jwt verifiers, data exporters, routes — and
read the global configuration (G-21).

## G-21 — the global configuration is readable by super admins only — medium

Upstream: [MAIF/otoroshi#2958](https://github.com/MAIF/otoroshi/issues/2958).

**Observed.** `GET /api/globalconfig` checks `RightsChecker.SuperAdminOnly`
(`app/controllers/adminapi/GlobalConfigController.scala:27`): a right on
`config.otoroshi.io/global-configs` does not open it. A narrowed key therefore cannot read the TLS
settings (`tlsSettings.clientAuth`, `trustedCAsServer`) nor the `env` the local vault resolves
`${vault://local/…}` against.

**Product meanwhile.** Its key keeps every right (G-20). With a narrowed key, the warnings about the
TLS client authentication of mtls plans and the vault references of the promotion would fail.

**Upstream fix.** Read access to the global configuration for a right on
`config.otoroshi.io/global-configs` (its secrets masked, as in the exports), and the `fields`
parameter it already takes for narrower reads.

