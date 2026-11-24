<h1 align="center">Otoroshi API Management</h1>

<p align="center">
  <strong>The API management console and developer portal for <a href="https://www.otoroshi.io/">Otoroshi</a>.</strong><br>
  Describe your APIs as products, publish them, let consumers subscribe — without ever opening the gateway.
</p>

> **Status: 0.1.0, a beta.** It drives Otoroshi 18.1 — until 18.1 is released, built from the
> `master` branch of Otoroshi. An end-to-end test describes a reference catalogue — 6 plans, 5 auth
> mechanisms, 4 approval modes, on one API and one set of routes — projects it, reconciles it and
> detects its drift (`test/reference-catalogue.test.js`). What 0.1.0 does and does not do:
> [`CHANGELOG.md`](./CHANGELOG.md).

**Documentation:** sources in [`documentation/`](./documentation), built with Docusaurus —
`mise run docs:dev` reads them locally, every [release](https://github.com/cloud-apim/otoroshi-api-management/releases)
attaches them as a static site (a zip), and the `documentation` workflow publishes them to
<https://cloud-apim.github.io/otoroshi-api-management/> once GitHub Pages is enabled on the repository.
Start with the **tutorial**: an API exposed from the console, then subscribed to and called by a
consumer alone, a screen at each step.

## What it is

Two faces of one thing, plus the two services that carry them:

- **an API management console** (`/backoffice`) — producers describe APIs, plans, documentation;
  publish immutable snapshots and deploy them; review subscriptions; watch usage;
- **a developer portal** per workspace (`/<workspace>/`) — consumers browse the catalogue, read the
  documentation, try the API (Scalar), subscribe from their applications, get their credentials —
  a key per subscription, or one for every API of an application — and follow their consumption;
- **an admin API** (`/api`) — the only way to do anything; the console uses the very same router;
- **an ingester** (`/ingest`) — receives Otoroshi events and stores them computed (attributed to
  api, plan, subscription, application) and, optionally, raw.

**The product is never in the request path**: it projects policies into Otoroshi through its Admin
API, and Otoroshi enforces them. If the product is down, traffic still flows.

## Run it

The executable of a [release](https://github.com/cloud-apim/otoroshi-api-management/releases), beside
Otoroshi 18.1 and PostgreSQL: the **quickstart** of the documentation (`documentation/docs/quickstart.mdx`)
makes an installation on one machine, configured as in production, and calls a first API through the
gateway; **Install** covers a production one — roles, the image, Kubernetes and Helm.

## Develop it

The development stack of the repository — the documentation's **Development** page
(`documentation/docs/development.mdx`) says it all; in short:

Requirements: [mise](https://mise.jdx.dev/) (it installs Bun and Node), Docker, and an Otoroshi jar,
18.1 or later — until it is released, built from the `master` branch of Otoroshi: `../otoroshi.jar`
by default, or `OTOROSHI_JAR=/path/to/otoroshi.jar`. Its extensions, optional, come from a directory
(`OTOROSHI_EXTENSIONS`, see the install documentation).

```sh
mise trust && mise install
mise run install                   # dependencies of the product and of the documentation
mise run up                        # builds the uis, starts postgres, otoroshi, the product… and waits
mise run demo                      # demo apis, a gitops workspace with its remote catalog, the data exporter
mise run open                      # the urls and credentials
```

`mise tasks` lists everything else: `test`, `test:unit`, `test:e2e`, `ci`, `watch`, `logs`,
`docs:dev`, `screenshots`, `cli`, `psql`, `image`, `reset`… Without mise, the same steps are
`bun install`, `bun run build` and `docker compose -f docker/docker-compose.yml --profile apim up -d`.
The stack runs the product with `DEV=true`: the values of the development stack below stand in for
its configuration. Without it, the product starts for production and requires its configuration
(documentation › Install › Configuration).

- console: <http://localhost:9000/backoffice/> — `admin@otoroshi.io` / `password`
- portal: <http://localhost:9000/default/>
- admin api: `curl -H 'Authorization: Bearer apim-admin-token' localhost:9000/api/me`
- otoroshi: <http://otoroshi.oto.tools:8080> — `admin@otoroshi.io` / `password`

Running the product on the host works too — `mise run stop:apim`, then `mise run dev` —, but the
Otoroshi data exporter then has to reach the host; inside the compose stack it reaches `http://apim:9000/ingest`.
Install the exporter from the console (Gateway → Connection & events) or
`POST /api/gateway/exporter`.

## A tour in five commands

The command line is the executable, `otoroshi-apim <command>`; from the clone, `mise run cli
<command>` runs the same commands against the local product, its url and token already set.

```sh
mise run cli apply default -f examples/petstore.yaml --publish --deploy
mise run cli apis list default
mise run cli apis deploy default petstore --dry-run   # the gateway diff, before acting
mise run cli subscriptions list default --status pending
mise run cli drift default
```

## One executable

The server, the console, the portal, the migrations and the command line are one program. Each
[release](https://github.com/cloud-apim/otoroshi-api-management/releases) publishes it for linux and
macOS, x64 and arm64, and as the image `ghcr.io/cloud-apim/otoroshi-api-management`.

```sh
mise run build:binary                        # dist/bin/otoroshi-apim, for this machine
DEV=true APIM_PORT=9001 dist/bin/otoroshi-apim   # the server, with the roles of APIM_ROLES, beside the stack
APIM_URL=http://localhost:9000 APIM_TOKEN=apim-admin-token dist/bin/otoroshi-apim apis list default
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

One binary, started with a comma-separated list of roles (`APIM_ROLES`, by default the first four):

| Role | Serves |
|---|---|
| `api` | `/api` — the admin api, bearer tokens |
| `backoffice` | `/backoffice`, `/backoffice/api` — the console and the same admin api, with a session |
| `portal` | `/<workspace>/` and `/<workspace>/front/api` (or `<workspace>.<domain>` in hostname mode) |
| `ingester` | `/ingest` — GatewayEvent, CloudApimSecurityEvent, LLMUsageAudit, McpAudit |
| `controller` | no route: the Kubernetes resources of the product (Api, Application, Subscription), reconciled |

Two PostgreSQL databases: application data, and events + analytics.

### Where things live

| Concern | Where |
|---|---|
| Draft → immutable snapshot → deployment | `server/domain/apis.js`, `deployments.js` |
| Projection: `Api` written as code | `server/otoroshi/projection.js`, `client.js` |
| A subscription is an apikey with `apiRef`, the application an `id_ref`; one key for every API, a shared credential and an alias per subscription | `server/domain/subscriptions.js` |
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
- **Notifications outside the product** — email and outgoing webhooks: a subscription to review or
  accepted, a key about to expire, a version deprecated, a quota nearly spent. Today they live in
  the console and the portal only.
- **The product's own metrics** — its projection queue, drift, ingestion and errors, for
  Prometheus or OpenTelemetry; today a health check and `gateway status`.
- **API quality** — the specifications linted, an API scored and reviewed before it is published.
- **GraphQL and gRPC APIs.**

## Otoroshi gaps

Every data-plane gap hit while building this is logged in [`OTOROSHI-GAPS.md`](./OTOROSHI-GAPS.md),
to be fixed upstream — never worked around in the product's model.

## Repository layout

| Path | What |
|---|---|
| `server/` | Bun server: config, http router, domain, Otoroshi client and projection, roles |
| `web/shared/` | front kit: theme, router, components, charts |
| `web/backoffice/`, `web/portal/` | the two React + Vite apps |
| `cli/` | the command line, and the setup of the gateway |
| `test/` | unit tests, end-to-end tests against the real stack, the interface in a headless Chromium |
| `docker/` | the development stack |
| `deploy/` | the Helm chart and the Kubernetes manifests |
| `documentation/` | the user documentation (Docusaurus) |
| `scripts/` | the demo data, the screens tour and the tutorial captures, the executable's build, the checks |
| `examples/` | declarative api documents, a remote catalog |

## Licence

Apache 2.0.
