<h1 align="center">Otoroshi API Management</h1>

<p align="center">
  <strong>The API management console and developer portal for <a href="https://www.otoroshi.io/">Otoroshi</a>.</strong><br>
  Describe your APIs as products, publish them, let consumers subscribe — without ever opening the gateway.
</p>

> **Status: first prototype**, running against a real Otoroshi 18.1.0-dev. An end-to-end test describes a
> reference catalogue — 6 plans, 5 auth mechanisms, 4 approval modes, on one API and one set of
> routes — projects it, reconciles it and detects its drift (`test/reference-catalogue.test.js`).

**Documentation:** <https://cloud-apim.github.io/otoroshi-api-management/> — sources in [`documentation/`](./documentation), built with Docusaurus and published to GitHub Pages by the `documentation` workflow on every push to `main`.

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

Requirements: [mise](https://mise.jdx.dev/) (it installs Bun and Node), Docker, and an Otoroshi jar, 18.1
or later — until it is released, built from the `master` branch of Otoroshi — (`../otoroshi.jar` by default, or `OTOROSHI_JAR=/path/to/otoroshi.jar`); its extensions,
optional, from a directory (`OTOROSHI_EXTENSIONS`, see the install documentation).

```sh
mise trust && mise install
mise run install                   # dependencies of the product and of the documentation
mise run up                        # builds the uis, starts postgres, otoroshi 18, the product… and waits
mise run demo                      # demo apis, a gitops workspace with its remote catalog, the data exporter
mise run open                      # the urls and credentials
```

`mise tasks` lists everything else: `test`, `test:unit`, `test:e2e`, `ci`, `watch`, `logs`,
`docs:dev`, `screenshots`, `cli`, `psql`, `image`, `reset`… Without mise, the same steps are
`bun install`, `bun run build` and `docker compose -f docker/docker-compose.yml --profile apim up -d`.

- console: <http://localhost:9000/backoffice/> — `admin@otoroshi.io` / `password`
- portal: <http://localhost:9000/default/>
- admin api: `curl -H 'Authorization: Bearer apim-admin-token' localhost:9000/api/me`
- otoroshi: <http://otoroshi.oto.tools:8080> — `admin@otoroshi.io` / `password`

Running the product on the host (`DEV=true bun --watch server/main.js`, or `mise run dev`) works too, but the Otoroshi data
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

## One executable

```sh
mise run build:binary            # dist/bin/otoroshi-apim: the server, the console, the portal and the command line
dist/bin/otoroshi-apim           # the server, with the roles of APIM_ROLES
dist/bin/otoroshi-apim apis list default
```

## Architecture

```
console (/backoffice) ─┐                     ┌─ portal (/<workspace>/, /front/api)
                       ▼                     ▼
                admin api (/api)  ──  domain: draft · snapshots · deployments · plans
                       │                      subscriptions · applications · audit
                       │  task queue (async, replayable)
                       ▼
            Otoroshi Admin API  — Api entity (written as code), ApiSubscription → apikey
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

### Where things live

| Concern | Where |
|---|---|
| Draft → immutable snapshot → deployment | `server/domain/apis.js`, `deployments.js` |
| Projection: `Api` written as code | `server/otoroshi/projection.js`, `client.js` |
| A subscription is an apikey with `apiRef`, the application an `id_ref` | `server/domain/subscriptions.js` |
| Selective sync: docs, terms, usage statements, pricing never projected | `projection.js` |
| Async and replayable operations | `server/domain/tasks.js` |
| Drift detection, adopt mode | `server/otoroshi/drift.js` |
| Transfer to an equivalent plan, new version = new api | `subscriptions.js`, `apis.js` |
| Two storage paths, url masking on the raw one | `server/domain/ingest.js` |
| One portal per workspace, resolved from the url | `server/main.js`, `server/roles/portal-api.js` |
| Hand-written CSS, light/dark/system | `web/shared/theme.css` |
| Scalar for OpenAPI and testing, bundled, behind a proxy | `web/portal`, `testProxy` |
| GitOps: admin api + CLI + declarative documents | `cli/apim.js`, `server/domain/exchange.js` |

## Roadmap

0.1.0 manages REST APIs on one Otoroshi cluster. Next:

- **LLM APIs** — an API in front of one or several AI providers, with budgets and plans counted in
  tokens (the LLM extension of Otoroshi).
- **MCP APIs** — MCP servers exposed, subscribed to and observed like any API (the LLM extension).
- **Event-driven APIs** — brokers behind the gateway, documented with AsyncAPI, their messages
  counted (the event brokers extension).
- **A European payment provider**, beside Stripe Connect, for the paid plans.
- **Several gateways for one installation** — one portal, one catalogue, APIs deployed on more than
  one Otoroshi cluster (today an installation drives exactly one).

And what is still missing among the important things:

- **One credential for several APIs** — a consumer subscribed to several APIs calls them with one
  key; waits for Otoroshi ([#2963](https://github.com/MAIF/otoroshi/issues/2963)).
- **Notifications outside the product** — email and outgoing webhooks: a subscription to review or
  accepted, a key about to expire, a version deprecated, a quota nearly spent. Today they live in
  the console and the portal only.
- **The product's own metrics** — its projection queue, drift, ingestion and errors, for
  Prometheus or OpenTelemetry; today a health check and `gateway status`.
- **API quality** — the specifications linted, an API scored and reviewed before it is published.
- **GraphQL and gRPC APIs.**
- **Dynamic client registration** — the application's client created at the identity provider.
- **Hardening for 1.0** — the suite run by the CI on every push, upgrades tested from one release
  to the next, an accessibility audit of both faces, a security review.

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
