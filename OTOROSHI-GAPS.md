# Otoroshi gaps found while implementing

Running list of the data-plane gaps hit while building the prototype, to fix **upstream** (in
Otoroshi or an extension) — never by a workaround in the product's data model. Each entry says
what was observed, where in the source, what the product does meanwhile, and the proposed fix.

Reference: Otoroshi `18.0.1` (the docker stack runs `otoroshi.jar` 18.0.1; source lines from the
`18.1.0-dev` checkout in `../otoroshi`). Severity: **high** = security or contract, **medium** =
the product has to compensate, **low** = friction.

| # | Gap | Severity | Product meanwhile |
|---|---|---|---|
| G-1 | A `pending` ApiSubscription gets an **enabled** apikey | high | never projects a pending subscription |
| G-2 | Deleting an ApiSubscription **revokes nothing** | high | deletes the keys first, then the subscription |
| G-3 | An `Api` without a published plan has **open routes** | high | warns and asks for an explicit acknowledgement before deploying |
| G-4 | On jwt / mtls / oauth2-remote / keyless plans, **any valid token passes**, subscribed or not | high | flags it on the plan (warning `any_token_passes`) |
| G-5 | Resource filtering (restrictions) only exists on **apikey** plans | medium | flags it as not enforced on other kinds |
| G-6 | No plan attribute for **selection rule**, **counter failure strategy**, **circuit breaker granularity** | medium | stored, projected as plan metadata, flagged as not enforced |
| G-7 | `ApiDeployment` cannot carry the **external snapshot id**, and keeps only 5 entries | medium | snapshot id written in `Api.metadata` |
| G-8 | The catalog-deploy path is borrowed by a control plane via a **naming convention** | medium | writes `created_by=remote_catalog=otoroshi-apim-deployment` |
| G-9 | `GatewayEvent` does not carry `apiRef` (plan, subscription) | low | attribution via the key's metadata + a client id cache at ingestion |
| G-10 | A `PUT` on an entity that does not exist is refused (`resource does not exists`) | low | `GET` then `POST` or `PUT` |
| G-11 | A new route / apikey becomes routable only after a few seconds, with no way to know when | low | tests poll; the console says "deployed" once the write is accepted |
| G-12 | Otoroshi's request tester with the **policy execution trace** is only reachable with a backoffice session, not through the Admin API | medium | the console replays requests through the gateway without the trace |
| G-13 | A **deprecated** plan loses its extractor: its consumers are no longer identified | high | validation warning on the plan |
| G-14 | A plan's key template only has an **absolute** `validUntil`: no validity relative to the subscription | low | not offered (the field was removed from the model) |
| G-15 | **oauth2-remote** plans check neither the **issuer** nor the **audience** of the token | high | warns on the plan (`token_claims_not_checked`) |
| G-16 | On **mtls** plans the subject and issuer lists combine with **OR**, over a trust store shared by the whole gateway | medium | derives the issuer list from the plan's CAs when none is given; warns when a subject list stands alone |

---

## G-1 — a pending subscription gets an enabled key — high

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

**Observed.** `ApiSubscription.deleteValidator` is a no-op (`next/models/Api.scala:1341`): the
apikeys referenced by `token_refs` stay in the datastore, enabled, still carrying their `apiRef`.

**Product meanwhile.** Closing / rejecting / deleting deletes the apikeys explicitly, then the
subscription (`removeFromGateway`, and `purge_api` when an api is deleted).

**Upstream fix.** Cascade-delete (or disable) the keys of `token_refs` on subscription delete,
like the `Closed` plan path already does on update.

## G-3 — an Api without a published plan has open routes — high

**Observed.** `applyPlansPolicies` only adds `NgApiConsumerEnforcer` when at least one plan is
`published` (`next/models/Api.scala:1957`). Deprecating or closing the last plan opens the api to
anyone.

**Product meanwhile.** Validation warning `open_routes`; the deploy dialog requires an explicit
"I understand: the routes will be open" acknowledgement.

**Upstream fix.** An `Api` in `published` state with no published plan should deny by default
(or require an explicit `open: true` / a keyless plan to be open).

## G-4 — any valid token passes on non-apikey plans — high

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

**Observed.** `ApiPlan.apikeyTemplate` (`next/models/Api.scala:789`) only carries a full template
(with `restrictions`) for the `apikey` kind; the other kinds get a template with tags and metadata
only, so a jwt / mtls / oauth2 / keyless plan cannot restrict the resources it gives access to.

**Product meanwhile.** Restrictions are projected on apikey plans; on the other kinds the console
says the filter is not enforced.

**Upstream fix.** Let every plan kind carry `restrictions` (and the rest of the key template)
applied to the consumer it mints.

## G-6 — no plan attribute for selection rule, counter failure, circuit breaker — medium

**Observed.** `ApiPlan` has no field for: an expression that disambiguates two plans of the same
kind whose extractors can both succeed; what to do when the distributed quota counter is
unreachable (let pass / refuse); a circuit breaker per subscription instead of per api. All three are enforcement, hence projected.

**Product meanwhile.** Stored in the plan, projected as `metadata.apim_selection_rule`,
`apim_counter_failure`, `apim_circuit_breaker`, and flagged as not enforced.

**Upstream fix.** Three plan attributes read by the extractors / `NgApiConsumerEnforcer` /
backend client.

## G-7 — ApiDeployment cannot carry the product snapshot — medium

**Observed.** `withDeployment` records `owner = metadata.created_by` and a `deploymentDefinition`
limited to routes, backends, flows and documentation (`next/models/Api.scala:2142`, `2178`), and
keeps the last **5** entries (`:2187`). Nothing ties a gateway-side deployment to the immutable
snapshot that produced it, and the plans are not in it.

**Product meanwhile.** The snapshot id and number go into `Api.metadata`
(`apim_snapshot_id`, `apim_snapshot_number`); the product keeps the full history itself.

**Upstream fix.** An optional `ref` (external snapshot id) on `ApiDeployment`, filled from the
write, and the plans in `deploymentDefinition`.

## G-8 — the catalog-deploy path is borrowed by convention — medium

**Observed.** Any `Api` write whose `metadata.created_by` starts with `remote_catalog=` is a
catalog deploy (`isWrittenByCatalog`, `next/models/Api.scala:2150`): `production_readonly` is
lifted and the api may be created already published. The product uses it with the id
`otoroshi-apim-deployment`, which no real remote catalog may use.

**Upstream fix.** A recognised marker for an external control plane (e.g.
`created_by=control_plane=<id>` or an explicit deploy flag), so this stops being a convention.

## G-9 — GatewayEvent does not carry apiRef — low

**Observed.** `GatewayEvent` carries the route (with `Otoroshi-Api-Ref` in its metadata) and the
identity (client id, and the key's metadata), not the key's `apiRef = {api, plan, sub}`.

**Product meanwhile.** The ingester attributes each call from a client id → subscription cache,
falls back on the key metadata the product projects (`apim_subscription_id`, `id_ref`), and parses
the `<kind>_<planId>_` prefix of gateway-minted consumers. Verified: real calls are attributed to
api, plan, subscription and application.

**Upstream fix.** Add `apiRef` to the exported identity (or the event) — attribution without
re-correlation, for every consumer of the data exporters.

## G-10 — PUT on a missing entity is refused — low

**Observed.** `PUT /apis/apis.otoroshi.io/v1/apis/<id>` on an id that does not exist answers
`unauthorized: resource does not exists` (`api/api.scala:2677`); creation has to be a `POST`.

**Product meanwhile.** `GET` then `POST` or `PUT` (`oto.upsertApi`).

**Upstream fix.** An upsert semantics on `PUT` (as `kubectl apply` does), or at least a `404` with
an explicit message instead of `unauthorized`.

## G-11 — no signal when a write becomes routable — low

**Observed.** After a deployment or a new apikey, the first calls get `404 no route found` /
`401` for a few seconds, until the proxy state picks the change up. Nothing tells a writer when the
change is live.

**Product meanwhile.** Tests poll the gateway; the console says "deployed" when the write is
accepted.

**Upstream fix.** Expose the proxy state version (or a "live since" timestamp per entity) on the
admin API so a control plane can wait for it.

## G-12 — the request tester with the execution trace is backoffice-only — medium

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

**Observed.** The key template of a plan (`ApikeyAccessModeConfiguration.validUntil`,
`next/models/Api.scala:529`) is an absolute date, applied as is to every key the plan mints.
"Keys of this plan are valid 90 days from the subscription" cannot be expressed; a `validUntil`
written on a key afterwards is overwritten by the next plan update (`updateApikeyFromPlan`).

**Product meanwhile.** Not offered: the unused `validityDays` field was removed from the model.

**Upstream fix.** A relative validity (`validity: 90d`) in the plan's key template, turned into
`validUntil` when the key is minted.

## G-15 — oauth2-remote plans check neither issuer nor audience — high

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

