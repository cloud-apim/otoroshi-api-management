# Otoroshi gaps found while implementing

Running list of the data-plane gaps hit while building the prototype, to fix **upstream** (in
Otoroshi or an extension) — never by a workaround in the product's data model. Each entry says
what was observed, where in the source, what the product does, and the fix.

Found on Otoroshi `18.0.1`, source lines from the `18.1.0-dev` checkout in `../otoroshi`. Severity:
**high** = security or contract, **medium** = the product had to compensate, **low** = friction.

## Where we are

G-1 to G-21 were fixed upstream on 2026-11-19, in `18.1.0-dev`, but three that are not by decision
of the owner (G-11, G-19, G-21). The product requires Otoroshi 18.1 (the setup check says so) and
dropped its workarounds rather than keeping them for 18.0: nothing depends on the product with 18.0.

On 2026-11-20 the product **followed** every fix: its workarounds and warnings are gone, the items
they blocked are done (R-14, R-15, R-16, R-24, R-33), and the end-to-end tests check the new
contract on the gateway. Found on the way: G-22 and G-23, reported upstream; G-24, G-26, G-27 and
G-28 in the Threat Protection Suite, checked on a gateway running its release 1.0.0 and reported to
it (G-25 is not a gap). Status: ✅ **followed** — the
product relies on the fix; ➖ **not fixed**, by decision; ⬜ **open**, reported upstream, not fixed
yet.

| # | Issue | Gap | Severity | Status | The product |
|---|---|---|---|---|---|
| G-1 | [#2940](https://github.com/MAIF/otoroshi/issues/2940) | A `pending` ApiSubscription got an **enabled** apikey | high | ✅ | projects a subscription once it is effective, its key enabled while it is active |
| G-2 | [#2941](https://github.com/MAIF/otoroshi/issues/2941) | Deleting an ApiSubscription **revoked nothing** | high | ✅ | deletes the subscription, Otoroshi revokes its keys |
| G-3 | [#2942](https://github.com/MAIF/otoroshi/issues/2942) | An `Api` without a published plan had **open routes** | high | ✅ | an api without a published or deprecated plan is closed; the draft says so (`no_served_plan`), the acknowledgement before deploying is gone |
| G-4 | [#2943](https://github.com/MAIF/otoroshi/issues/2943) | On jwt / mtls / oauth2-remote plans, **any valid token passed**, subscribed or not | high | ✅ | projects these plans with `subscription_required`: only the client ids of enabled subscriptions are served (R-15) |
| G-5 | [#2944](https://github.com/MAIF/otoroshi/issues/2944) | Resource filtering (restrictions) only existed on **apikey** plans | medium | ✅ | the resource filter is projected on every kind but oauth2-local, which carries none (`filter_not_enforced`) |
| G-6 | [#2945](https://github.com/MAIF/otoroshi/issues/2945) | No plan attribute for **selection rule**, **counter failure strategy**, **circuit breaker granularity** | medium | ✅ | projected as `selection`, `counter_failure`, `circuit_breaker_scope` (R-14) |
| G-7 | [#2946](https://github.com/MAIF/otoroshi/issues/2946) | `ApiDeployment` could not carry the **external snapshot id** | medium | ✅ | the snapshot is the `deployment_ref` of the `Api`, the ref of each deployment Otoroshi records (R-33) |
| G-8 | [#2947](https://github.com/MAIF/otoroshi/issues/2947) | The catalog-deploy path was borrowed by a control plane via a **naming convention** | medium | ✅ | the `Api` is managed as code, `created_by=external=otoroshi-api-management` |
| G-9 | [#2948](https://github.com/MAIF/otoroshi/issues/2948) | `GatewayEvent` did not carry `apiRef` (plan, subscription) | low | ✅ | each call is attributed from the `apiRef` of its event |
| G-10 | [#2949](https://github.com/MAIF/otoroshi/issues/2949) | A `PUT` on a missing entity was refused as **unauthorized**; the upsert said the opposite of what changed; certificates not enriched by the generic api | low | ✅ | the `Api` and every derived object are written with the upsert of the generic api |
| G-11 | [#2950](https://github.com/MAIF/otoroshi/issues/2950) | A new route / apikey becomes routable only after a few seconds, with no way to know when | — | ➖ | tests poll; the console says "deployed" once the write is accepted |
| G-12 | [#2951](https://github.com/MAIF/otoroshi/issues/2951) | Otoroshi's request tester with the **policy execution trace** was only reachable with a backoffice session | medium | ✅ | the console tries requests with it and shows the trace (R-24) |
| G-13 | [#2952](https://github.com/MAIF/otoroshi/issues/2952) | A **deprecated** plan lost its extractor: its consumers were no longer identified | high | ✅ | a deprecated plan is served: in the resolution order and in the checks of the selection (R-16) |
| G-14 | [#2953](https://github.com/MAIF/otoroshi/issues/2953) | A plan's key template only had an **absolute** `validUntil` | low | ✅ | an apikey plan offers a key validity in days, counted from the first enablement of the key |
| G-15 | [#2954](https://github.com/MAIF/otoroshi/issues/2954) | **oauth2-remote** plans checked neither the **issuer** nor the **audience** of the token | high | ✅ | the plan names its `issuer` and `audiences`; without either, the draft warns |
| G-16 | [#2955](https://github.com/MAIF/otoroshi/issues/2955) | On **mtls** plans the subject and issuer lists combined with **OR**, over a trust store shared by the whole gateway | medium | ✅ | the plan's CAs are its `trusted_ca_refs`, the DN lists combine with `all`; a plan without CA warns |
| G-17 | [#2937](https://github.com/MAIF/otoroshi/issues/2937) | The `ApiSubscription` of a **jwt, mtls or oauth2-remote** plan carried **no consumer identity** | high | ✅ | the subscription carries the application's `client_id`; Otoroshi provisions its consumer, enabled while the subscription is |
| G-18 | [#2938](https://github.com/MAIF/otoroshi/issues/2938) | The consumers minted for a **jwt, mtls, oauth2-remote or keyless** plan were keyed by the **plan id alone**, and outlived their Api | high | ✅ | nothing to do: the consumers are named after the api and the plan, and leave with the `Api` |
| G-19 | [#2956](https://github.com/MAIF/otoroshi/issues/2956) | A data exporter sends the **url secrets** and the **personal data** of an event in clear, and **samples** nothing | — | ➖ | the ingester masks, pseudonymises and samples before it stores |
| G-20 | [#2957](https://github.com/MAIF/otoroshi/issues/2957) | An admin key narrowed by `otoroshi-access-rights` **read the secret of every admin key** of its teams | high | ✅ | nothing to change: its key stays super admin, for the global configuration (G-21) |
| G-21 | [#2958](https://github.com/MAIF/otoroshi/issues/2958) | The **global configuration** is readable by super admins only — by design | — | ➖ | the product's key keeps every right |
| G-22 | [#2962](https://github.com/MAIF/otoroshi/issues/2962) | An extractor that does not identify the caller **sends an error event** for a call that then succeeds, or is refused: the call is counted twice, once as a `400` | medium | ⬜ | nothing: the dashboards count these events as errors |
| G-23 | [#2963](https://github.com/MAIF/otoroshi/issues/2963) | A key cannot serve **several subscriptions**: a key is its subscription's own, one api, one plan | medium | ⬜ | nothing: one key per subscription; R-12 waits for it |
| G-24 | [waf#60](https://github.com/cloud-apim/otoroshi-waf-extension/issues/60) | Threat Protection Suite: the global table of Threat Studio does not see the **plan plugins**: a second firewall runs on a plan already protected, the scores add up, and the policy of the table decides | high | ⬜ | nothing: the docs ask an operator to keep the global table off the apis protected per plan |
| G-25 | — | ~~Threat Protection Suite: a challenge answers a page, status 200~~ | — | ➖ | not a gap, by decision: a challenge is for a person in a browser |
| G-26 | [waf#61](https://github.com/cloud-apim/otoroshi-waf-extension/issues/61) | Threat Protection Suite: a security event names the **api, not the plan** | low | ⬜ | the plan, the subscription and the application from the key that called; the api only for a caller not identified |
| G-27 | [waf#62](https://github.com/cloud-apim/otoroshi-waf-extension/issues/62) | Threat Protection Suite: with the core rule set, **every call scores a firewall match** — its initialization rules count as matches | medium | ⬜ | nothing: a policy that refuses starts at 90 (the weight of a block), and the events of every call are kept |
| G-28 | [waf#63](https://github.com/cloud-apim/otoroshi-waf-extension/issues/63) | Threat Protection Suite: a firewall that **blocks on its own** sends no `CloudApimSecurityEvent`, only its trail event | medium | ⬜ | the docs advise the fabric of the extension — the firewall reports, the threat response decides — whose refusals are security events |

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

## G-3 — an Api without a published plan had open routes — high — followed

Upstream: [MAIF/otoroshi#2942](https://github.com/MAIF/otoroshi/issues/2942), fixed in 18.1: the
routes of every published or deprecated `Api` end with the `Api consumer enforcer`; without a
published or deprecated plan it only lets through the callers a plugin of the flows identified, and
refuses the others (`401`). An open api publishes a `keyless` plan.

**The product.** The warning `open_routes` and the acknowledgement asked before deploying are gone;
a draft without a published or deprecated plan gets `no_served_plan`: the api refuses every call.

## G-4 — any valid token passed on token and certificate plans — high — followed

Upstream: [MAIF/otoroshi#2943](https://github.com/MAIF/otoroshi/issues/2943), fixed in 18.1: a
`jwt`, `mtls` or `oauth2-remote` plan with `subscription_required` mints nothing, and serves only
the key an `enabled` subscription provisioned for the client id the caller is identified with
(G-17). Another caller is not identified by the plan: another plan of the api may identify it (a
`keyless` one), otherwise it gets `401`.

**The product.** Its plans of these kinds are projected with `subscription_required: true`: a
subscription is always required (D-6). The warning `any_token_passes` is gone (R-15). A `keyless`
plan stays open by nature: it is the anonymous tier.

## G-5 — resource filtering only on apikey plans — medium — followed

Upstream: [MAIF/otoroshi#2944](https://github.com/MAIF/otoroshi/issues/2944), fixed in 18.1: the
access mode of a `keyless`, `jwt`, `mtls` or `oauth2-remote` plan has `restrictions`, given to the
consumers it mints or provisions, and rewritten on the keys already minted when they change. An
`oauth2-local` plan carries none.

**The product.** The resource filter of a plan is projected as the `restrictions` of every kind; on
an `oauth2-local` plan the draft says it is not enforced (`filter_not_enforced`). Found on the way,
a bug of the product: the paths of the restrictions are regexes matched against the whole request
path, and the product wrote `/v1/pets*` — only `/v1/pet` and `/v1/pets`, not `/v1/pets/42`. They
are now `/v1/pets(/.*)?`, and `/v1/store` for an exact resource (`restrictionPath`).

## G-6 — no plan attribute for selection rule, counter failure, circuit breaker — medium — followed

Upstream: [MAIF/otoroshi#2945](https://github.com/MAIF/otoroshi/issues/2945), fixed in 18.1: a plan
has a `selection` (JSON path conditions on the request, the token, the certificate or the client
id; refused on apikey and oauth2-local plans), a `counter_failure` (`deny` or `allow`, and a
timeout), a `circuit_breaker_scope` (`route` or `consumer`). Between plans of the same kind, the
order of the plans decides.

**The product.** The selection rule of a plan is a list of conditions (`selection`: path, value),
the form the gateway reads; a plan without selection placed before one of the same kind is flagged
(`selection_shadowed`), and the resolution order follows the order of the plans. The counter
failure strategy is projected as `counter_failure.mode`, the circuit breaker granularity as
`circuit_breaker_scope` (`api` → `route`, `subscription` → `consumer`). The plan metadata
`apim_selection_rule`, `apim_counter_failure`, `apim_circuit_breaker` and the warning
`not_enforced` are gone (R-14). Checked end to end: a gold tier selected by a claim, before the
partner tier of the same identity provider.

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

## G-9 — GatewayEvent did not carry apiRef — low — followed

Upstream: [MAIF/otoroshi#2948](https://github.com/MAIF/otoroshi/issues/2948), fixed in 18.1: the
`identity` of a `GatewayEvent` carries the `apiRef` of the key that called, as the key said it at the
time of the call — `sub` empty for a consumer minted on the fly, `null` for a classic apikey.

**The product.** The ingester attributes each call from it: the api, the plan, and the subscription
with its application (`attribute`, `server/domain/ingest.js`); the client id of a credential the
product holds only when an event has no `apiRef` (an AI audit). The parsing of the
`<kind>_<planId>_` prefix of minted consumers is gone. Checked with real traffic: a jwt consumer
provisioned by a subscription is attributed to its plan, its subscription and its application.

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

## G-12 — the request tester with the execution trace was backoffice-only — medium — followed

Upstream: [MAIF/otoroshi#2951](https://github.com/MAIF/otoroshi/issues/2951), fixed in 18.1:
`POST /apis/apis.otoroshi.io/v1/apis/<id>/routes/<route>/_tryit` sends a request through a route of
a published or deprecated api, from the node itself (`127.0.0.1`), and answers the response and the
execution report of the call.

**The product.** The console's *Test* tab tries requests with it (`oto.tryRoute`, `POST …/test`):
the response, and the trace of the call — the consumer the plans identified, each plugin of each
step with its outcome and its duration (R-24). The raw report is never answered: it holds the
headers of the request, credentials included.

## G-13 — a deprecated plan lost its extractor — high — followed

Upstream: [MAIF/otoroshi#2952](https://github.com/MAIF/otoroshi/issues/2952), fixed in 18.1: a plan
is served — its extractor on the routes, its consumers enforced — when it is published or
deprecated.

**The product.** The warning `deprecated_without_extractor` is gone; deprecated plans are in the
resolution order and in the checks of the selection (`SERVED_STATUSES`), and still take no new
subscription (R-16). Checked end to end: the consumer of a deprecated jwt plan keeps calling.

## G-14 — no key validity relative to the subscription — low — followed

Upstream: [MAIF/otoroshi#2953](https://github.com/MAIF/otoroshi/issues/2953), fixed in 18.1: the key
template of an apikey plan has a `validity`, counted from the first time each key is enabled, and the
`validUntil` of a key is its own from then on.

**The product.** An apikey plan offers a key validity in days (`validityDays`), projected as the
`validity` of its key template.

## G-15 — oauth2-remote plans checked neither issuer nor audience — high — followed

Upstream: [MAIF/otoroshi#2954](https://github.com/MAIF/otoroshi/issues/2954), fixed in 18.1: an
`oauth2-remote` plan has an `issuer` (compared exactly) and `audiences` (one of them in `aud`); a
token refused for either is not identified by the plan.

**The product.** The plan names the issuer (filled by *Discover* from the discovery document) and
the audiences, projected as such; without either, the draft warns (`token_claims_not_checked`):
the plan would accept any token signed with the keys of the server. Checked end to end: a token the
same server issued for another audience is refused.

## G-16 — mtls subject and issuer lists combined with OR — medium — followed

Upstream: [MAIF/otoroshi#2955](https://github.com/MAIF/otoroshi/issues/2955), fixed in 18.1: an
`mtls` plan has `trusted_ca_refs` — certificates of the store the chain of a client certificate has
to lead to, validated with PKIX whatever the trust of the handshake — and `dn_match` (`all` or
`any`) for its two lists of patterns.

**The product.** The CAs of a plan, derived as certificates of the gateway, are its
`trusted_ca_refs`; the DN lists combine with `all`. The issuer patterns derived from the subjects
of the CAs, and the warnings `issuer_not_derived` and `subject_without_issuer`, are gone; a served
mtls plan without CA gets `no_trusted_ca`.

## G-17 — token and certificate subscriptions carried no consumer identity — high — followed

Upstream: [MAIF/otoroshi#2937](https://github.com/MAIF/otoroshi/issues/2937), fixed in 18.1: an
`ApiSubscription` to a `jwt`, `mtls` or `oauth2-remote` plan has a `client_id`; Otoroshi provisions
the key `<kind>_<api id>_<plan id>_<client id>` the plan resolves for that consumer (taking over one
minted on the fly), references it in `token_refs`, enables it only while the subscription is
`enabled`, and disables it when the subscription is deleted. The `client_id` is unique per plan and
never changes (`400`).

**The product.** The subscription carries the `client_id` the application declares
(`buildOtoroshiSubscription`); when the application declares another one, the subscription is made
again on the gateway (`sync_subscription`), the key of the previous one left disabled. Two
applications cannot subscribe to a plan with the same client id, nor take the client id of another
application subscribed to the same plan. Drift detection compares the client id and the state of the
provisioned key. The metadata `apim_client_id` is gone.

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

## G-22 — a non-identifying extractor sends an error event for a call that succeeds — medium — open

Upstream: [MAIF/otoroshi#2962](https://github.com/MAIF/otoroshi/issues/2962), with the fix proposed
below and the tests. Seen on 18.0.1 and on 18.1.0-dev.

**Observed.** On an `Api` with several plans, every extractor that does not identify the caller
builds an error response and lets the call go on — and building it sends a `GatewayEvent`:

- `ApikeyCalls` (apikey and oauth2-local plans), not mandatory: `ApiKeyHelper.passWithApiKeyFromCache`
  answers `400 invalid apikey tuple` (or `no apikey`) through `Errors.craftResponseResult`, which
  sends the event (`models/apikey.scala:2384`, `:2431`); the plugin then turns that `400` into
  `NgAllowed` (`next/plugins/apikey.scala:216`);
- `NgJwtApikeyExtractor` (jwt plans): `JwtVerifier.verify` calls `internalVerify` with
  `sendEvent = true` (`models/JWTVerifier.scala:1268`); a strict verifier answers
  `400 error.expected.token.not.found` (`:1386`) for a call that carries no token, or another
  error for a token of another kind; the extractor turns it into a non-strict failure
  (`next/plugins/apimgmt.scala`, `outcome`).

So a call made with an apikey on an api that also has a jwt plan produces two events: the error of
the jwt verifier (`400`, no identity, `duration: 0`, `backendDuration: -1`, the url of the backend,
its own `reqId`), then the call itself (`200`, the key). A jwt call produces the `400 invalid apikey
tuple` of `ApikeyCalls`, then itself. Seen on the development stack: about one call in ten of the
end-to-end tests was such an event.

A call **refused** in the end is counted twice as well: a call without a key, on an api whose plans
are apikey plans, gives the `400 no apikey` event of `ApikeyCalls` ("no apikey detected in the http
request"), then the `401` the client gets, from the consumer enforcer ("no consumer identified on the
call", `next/plugins/apimgmt.scala:1301`) — two `reqId`, the same url and time, a status the client
never saw. Captured again on the data exporter of 18.1.0-dev.

**The product.** Nothing: an error event is an event. The dashboards count these as calls and as
errors — the error rate of an api with several plans is overstated, and every refused call counts
twice.

**Fix to propose.** An extractor that only tries to identify the caller does not send the event of
the error it lets go: `sendEvent = false` on the verification of `NgJwtApikeyExtractor` and
`NgOidcApikeyExtractor`, and on `passWithApiKeyFromCache` when `ApikeyCalls` is not mandatory — the
call then has one event, its own, which already carries the reason of a refusal
(`apikey_rejection_reason`, `token_rejection_reason`) when the call is refused in the end.

## G-23 — a key cannot serve several subscriptions — medium — open

Reported upstream: [#2963](https://github.com/MAIF/otoroshi/issues/2963). Found on 18.1.0-dev
while implementing R-12 (one credential for several subscriptions of a consumer, D-31: the identity
grouped, the quotas never pooled), and reproduced on the development gateway.

**Observed.** A key minted for an `ApiSubscription` is its subscription's own: authorized on its api
(`authorizedEntities = Seq(ApiIdentifier(api.id))`), one `apiRef` `{api, plan, sub}`
(`generateNewApikeyFromPlan`, `next/models/Api.scala:1323`). A second subscription, to another api,
of the same owner, that names that key in its `token_refs`: the key is left alone — `onOwnKeys`
(`:1244`) skips a key whose `apiRef` is another subscription's, with a warning — and the second
subscription gets a new key of its own (`createNewApikeyFromPlan`, `:1384`), the first key still
listed in its `token_refs` although it serves nothing on its api: a call to the second api with it
is refused (`401`). Writing the first subscription again, or deleting the second, leaves the key
as it was. So one key cannot carry the subscriptions of a consumer to several apis — what
`authorizedEntities` allows for a classic apikey.

**The product.** One key per subscription. R-12 waits for this.

**Fix proposed upstream.** An opt-in sharing (`{"apikey": "<client id>", "shared": true}` in the
`token_refs` of a subscription of the same owner): the key knows the subscriptions it serves, each
call is enforced with the plan of the subscription of the api called — counters per key and plan,
no pooled quota —, the `apiRef` of the event is that subscription's, and the key goes with the
last of them; a foreign key without the flag is refused, or dropped from the `token_refs`.

## G-24 — the global table of Threat Studio does not see the plan plugins — high — open

Reported upstream: [waf#60](https://github.com/cloud-apim/otoroshi-waf-extension/issues/60). In the Threat Protection Suite (`../otoroshi-waf-extension`),
found while implementing R-25 (threat protection per plan, D-10), and checked on a gateway running
the release 1.0.0.

**Observed.** The global preset (`CloudApimSecuritySuiteGlobalPreset`, the table of Threat Studio)
protects every route a rule of its table claims, and stands down on a route that carries its own
protection when `skip_protected_routes` is on. It decides that from the plugins of the route only:
`carriesOwnProtection(route) = route.plugins.slots.exists(...)` (`plugins/globalpreset.scala:202`).
The plugins of a plan (`ApiPlanPlugins`) are composed into the chain at call time, after the plan is
selected (`next/models/plugins.scala:366` in Otoroshi), so the route of an Api whose plan carries the
preset looks unprotected to the table. On the development gateway, a table with one rule for every
route (`skip_protected_routes: true`) and three apis, three calls each:

| the api | the decisions of the threat response |
|---|---|
| the preset in the flow of the route, its own policy | 3 × `score 45 reached tier 1 (log)` — the table stands down |
| no protection | 3 × `score 45 reached tier 40 (log)` — the table protects it |
| the preset on its plan, its own policy | 3 × `score 90 reached tier 90 (ban)` — both firewalls ran, their scores added up, and the policy of the table decided |

With the default tiers of a policy that is not in dry run, every call of a plan protected that way
would be banned.

**The product.** It places the preset of the extension on the plan — it never adds a firewall of its
own. Nothing more: the docs ask an operator to keep the global table off the apis protected per plan.

**Why it cannot see it.** The order of a call on an Api (`next/proxy/engine.scala:2119-2173` in
Otoroshi): the chain of the route — its global plugins and its own — is built first, and the global
preset expands there, deciding whether it stands down; its plugins run, the extractors of the plans
among them, which identify the key, hence its `apiRef`, hence the plan; only then is the chain of
the plan composed, its own phases run, and merged with the one of the route for the rest of the call,
the global plugins kept as they were expanded. When the table decides, the plan of the call is not
known yet — it cannot be.

**Fix to propose.** Either a static decision — `carriesOwnProtection` also looks at the plans of the
Api of the route (`route.apiRef` → its plans' `plugins.plugins`, and the flows they reference), and
stands down when every plan carries a preset (when only some do, it cannot tell without the plan of
the call) — or a decision at call time: once in place, the modules of the table check whether the
merged chain of the call (`ContextualPluginsKey` in the attrs) already holds a preset, and do nothing
then; more exact, more intrusive.

## G-25 — a challenge answers a page with status 200 — not a gap

Withdrawn, by decision of the owner: a challenge is for a person in a browser, its page answered with
`200` as it should be (`plugins/threat.scala:461`). The plan screen only says that a policy can
challenge.

## G-26 — a security event names the api, not the plan — low — open

Reported upstream: [waf#61](https://github.com/cloud-apim/otoroshi-waf-extension/issues/61). In the Threat Protection Suite, found while implementing R-25,
and checked on a gateway running the release 1.0.0.

**Observed.** `CloudApimSecurityEvent` carries the route and the api of the route (`otoroshi.api_id`,
from `route.apiRef`, `security/events.scala:137`) and the client id of the key that called
(`source.apikey`), but not the plan the engine selected for the call, nor its subscription. On the
development gateway, the event of a refused attack: `otoroshi: {route_id, route_name, api_id,
tenant, teams, groups, node}`, `source: {ip, apikey, user}`, no plan. For a keyless plan, or a
caller refused before it was identified, the plan is lost.

**The product.** The ingester takes the plan, the subscription and the application from the key that
called when there is one (checked end to end: `test/threat-protection.test.js`); otherwise the event
is the api's only, shown as "no plan: caller not identified".

**Fix to propose.** Add the `apiRef` of the call to the event (`api`, `plan`, `sub`), as the
`GatewayEvent` of Otoroshi does in `identity.apiRef`: the plan the engine selected, empty when it
selected none.

## G-27 — with the core rule set, every call scores a firewall match — medium — open

Reported upstream: [waf#62](https://github.com/cloud-apim/otoroshi-waf-extension/issues/62). In the Threat Protection Suite, found on a gateway running the
release 1.0.0, with the firewall configuration of its getting started (`@import_preset crs`,
`SecRuleEngine On`).

**Observed.** Every call, a legitimate `GET /books?page=1` with a browser user agent included, gives a
`waf:match` signal, "rules matched without blocking (rules 900990, 901100, 901110, 901111, 901115)",
scored 45 (`waf_match_weight`). These are the setup and initialization rules of the core rule set
(`crs-setup.conf`, `REQUEST-901-INITIALIZATION`): `SecAction`s that run on every request to set
variables, not detections. The signal is published as soon as the engine reports events
(`CloudApimWafFabric.signalFor`, `plugins/waf.scala`: `result.events.isEmpty`). So every call starts at
45: the default tiers log it as a threat (tier 40), a security event per call, and leave 25 points to
the tarpit (tier 70) — one more signal, a bot score, and a legitimate client is slowed down.

**The product.** Nothing: the events of every call are kept as they come. The test policy refuses at
90 only (`test/threat-protection.test.js`).

**Fix to propose.** Leave out of the signal the rules that only set state — the `SecAction`s, the
rules with `nolog` or without a `msg`, the 9000xx and 9011xx ranges of the core rule set — and count
a match only for the rules that detected something.

## G-28 — a firewall that blocks on its own sends no security event — medium — open

Reported upstream: [waf#63](https://github.com/cloud-apim/otoroshi-waf-extension/issues/63). In the Threat Protection Suite, found on a gateway running the
release 1.0.0.

**Observed.** With a firewall configuration in blocking mode (`block: true`), an injection is refused
by the firewall itself (`400`), and the only event is its own `CloudApimWafTrailEvent`
(`plugins/waf.scala:365`): no `CloudApimSecurityEvent`, although the event says that "every module
emits this shape rather than its own" (`security/events.scala`). A consumer of the normalised events
(a SIEM, the product) does not see the blocks of the firewall. With the firewall reporting and the
threat response deciding (`block: false`, a policy that refuses at 90 with `waf_block_decisive`), the
refusal is a `CloudApimSecurityEvent` (`category: threat`, `action: deny`) — checked end to end.

**The product.** The docs advise that fabric; the exporter of the setup exports the normalised events
only.

**Fix to propose.** The firewall sends a `CloudApimSecurityEvent` (`category: waf`, `action: block`,
the rules in `signals`) when it blocks, beside its trail event.

