<h1 align="center">Otoroshi API Management</h1>

<p align="center">
  <strong>The API management console and developer portal for <a href="https://www.otoroshi.io/">Otoroshi</a>.</strong><br>
  Describe your APIs as products, publish them, let consumers subscribe — without ever opening the gateway.
</p>

> **Status: first prototype.** It implements the specification of
> [`otoroshi-api-management-specs`](../otoroshi-api-management-specs) against a real Otoroshi 18.
> The L0 exit criterion of the spec — the Atlas catalogue, 6 plans, 5 auth mechanisms, 4 approval
> modes, on one API and one set of routes, projected, reconciled and its drift detected — passes as
> an executable test (`test/reference-catalogue.test.js`).

**Documentation:** <https://cloud-apim.github.io/otoroshi-api-management/> — sources in [`documentation/`](./documentation), built with Docusaurus (`./doc.sh`).

## What it is

Two faces of one thing, plus the two services that carry them:

- **an API management console** (`/backoffice`) — producers describe APIs, plans, documentation;
  publish immutable snapshots and deploy them; review subscriptions; watch usage;
- **a developer portal** per workspace (`/<workspace>/`) — consumers browse the catalogue, read the
  documentation, try the API (Scalar), subscribe from their applications, get their credentials and
  follow their consumption;
- **an admin API** (`/api`) — the only way to do anything; the console uses the very same router;
- **an ingester** (`/ingest`) — receives Otoroshi events and stores them computed (attributed to
  api, plan, subscription, application) and, optionally, raw.

**The product is never in the request path**: it projects policies into Otoroshi through its Admin
API, and Otoroshi enforces them. If the product is down, traffic still flows.

## Quick start

Requirements: [Bun](https://bun.sh) 1.3, Docker, and an Otoroshi 18 jar (`../otoroshi.jar` by
default, or `OTOROSHI_JAR=/path/to/otoroshi.jar`).

```sh
bun install
bun run build                      # backoffice + portal
bun run infra:up                   # postgres, otoroshi 18 on :8080, an echo backend
docker compose -f docker/docker-compose.yml --profile apim up -d apim   # the product on :9000
```

- console: <http://localhost:9000/backoffice/> — `admin@otoroshi.io` / `password`
- portal: <http://localhost:9000/default/>
- admin api: `curl -H 'Authorization: Bearer apim-admin-token' localhost:9000/api/me`
- otoroshi: <http://otoroshi.oto.tools:8080> — `admin@otoroshi.io` / `password`

Running the product on the host (`bun --watch server/main.js`) works too, but the Otoroshi data
exporter then has to reach the host; inside the compose stack it reaches `http://apim:9000/ingest`.
Install the exporter from the console (Gateway → Connection & events) or
`POST /api/gateway/exporter`.

## A tour in five commands

```sh
export APIM_TOKEN=apim-admin-token
bun cli/apim.js apply default -f examples/petstore.yaml --publish --deploy
bun cli/apim.js apis list default
bun cli/apim.js apis deploy default petstore --dry-run   # the gateway diff, before acting
bun cli/apim.js subscriptions list default --status pending
bun cli/apim.js drift default
```

## Architecture

```
console (/backoffice) ─┐                     ┌─ portal (/<workspace>/, /front/api)
                       ▼                     ▼
                admin api (/api)  ──  domain: draft · snapshots · deployments · plans
                       │                      subscriptions · applications · audit
                       │  task queue (async, replayable)
                       ▼
            Otoroshi Admin API  — Api entity (catalog-marked write), ApiSubscription → apikey
                       │
         Otoroshi (data plane) ── data exporter ──▶ ingester (/ingest) ──▶ analytics db
```

One binary, started with a comma-separated list of roles (`APIM_ROLES`, default all four):

| Role | Serves |
|---|---|
| `api` | `/api` — the admin api, bearer tokens |
| `backoffice` | `/backoffice`, `/backoffice/api` — the console and the same admin api, with a session |
| `portal` | `/<workspace>/` and `/<workspace>/front/api` (or `<workspace>.<domain>` in hostname mode) |
| `ingester` | `/ingest` — GatewayEvent, LLMUsageAudit, McpAudit |

Two PostgreSQL databases: application data, and events + analytics.

### How the spec lands in the code

| Decision | Where |
|---|---|
| Draft → immutable snapshot → deployment (D-35) | `server/domain/apis.js`, `deployments.js` |
| Projection: catalog-marked `Api` write (D-38) | `server/otoroshi/projection.js`, `client.js` |
| A subscription is an apikey with `apiRef`, the application an `id_ref` (D-6, D-26) | `server/domain/subscriptions.js` |
| Selective sync: docs, terms, usage statements, pricing never projected (D-2) | `projection.js` |
| Async and replayable operations (D-4) | `server/domain/tasks.js` |
| Drift detection, adopt mode | `server/otoroshi/drift.js` |
| Transfer to an equivalent plan (D-30), new version = new api (D-29) | `subscriptions.js`, `apis.js` |
| Two storage paths, url masking on the raw one (D-33) | `server/domain/ingest.js` |
| One portal per workspace, resolved from the url (D-20) | `server/main.js`, `server/roles/portal-api.js` |
| Hand-written CSS, light/dark/system (D-12, D-39) | `web/shared/theme.css` |
| Scalar for OpenAPI and try-it, bundled, behind a proxy (D-42) | `web/portal`, `tryItProxy` |
| GitOps: admin api + CLI + declarative documents (D-28) | `cli/apim.js`, `server/domain/exchange.js` |

## Otoroshi gaps

Every data-plane gap hit while building this is logged in [`OTOROSHI-GAPS.md`](./OTOROSHI-GAPS.md),
to be fixed upstream — never worked around in the product's model.

## Repository layout

| Path | What |
|---|---|
| `server/` | Bun server: config, http router, domain, Otoroshi client and projection, roles |
| `web/shared/` | front kit: theme, router, components, charts |
| `web/backoffice/`, `web/portal/` | the two React + Vite apps |
| `cli/apim.js` | the command line |
| `test/` | unit tests, and the reference catalogue test against the real stack |
| `docker/` | the development stack |
| `examples/` | declarative api documents |

## Licence

Apache 2.0.
