# CLAUDE.md

Prototype of an API management console + developer portal driving Otoroshi 18. Product decisions
are kept in the separate `../otoroshi-api-management-specs` repository: read it before changing
behaviour, and do not reopen settled decisions.

## Commands

```sh
bun install
bun run build                 # both UIs into dist/ (the server serves dist/, rebuild after web/ changes)
bun run infra:up              # docker: postgres :5442, otoroshi 18 :8080, echo backend
docker compose -f docker/docker-compose.yml --profile apim up -d apim   # product on :9000, bun --watch
bun test                      # unit tests + the reference catalogue test (needs the docker stack; starts its own server on :9117)
bun test test/model.test.js   # unit tests only
APIM_TOKEN=apim-admin-token bun cli/apim.js help
```

The `apim` container mounts the working copy and runs `bun --watch`: server changes reload by
themselves; UI changes need `bun run build`. Console: admin@otoroshi.io / password. Admin token:
`apim-admin-token`. Otoroshi admin api: host `otoroshi-api.oto.tools`, key
`apim-admin-client` / `apim-admin-secret`. Demo apis are reachable as `http://<domain>:8080`
(`*.oto.tools` resolves to 127.0.0.1).

The host firewall drops container → host traffic: the Otoroshi data exporter can only reach the
ingester when the product runs inside the compose stack (`http://apim:9000/ingest`).

## Architecture invariants (do not break)

- **Never in the request path**: projection goes through the task queue
  (`server/domain/tasks.js`), handlers are idempotent; a projection that cannot reach the gateway
  waits and replays.
- **Edit the draft, publish a snapshot, deploy the snapshot**. Snapshots are immutable and
  append-only; the deployment references a snapshot. Never write a draft to the gateway.
- **Selective sync**: documentation, plan visibility, terms, usage statements, pricing and
  metadata never reach Otoroshi. `test/model.test.js` checks it.
- **Projection**: `Api` written with `metadata.created_by=remote_catalog=otoroshi-apim-deployment`;
  ApiSubscription → apikey with `apiRef`; application → `id_ref` metadata on the key.
- **Every UI action is an admin api call**: `server/roles/admin-api.js` is served on
  both `/api` (bearer) and `/backoffice/api` (session). Add features there, then the console, then
  the CLI.
- **The admin api writes the audit trail** (`audit()` in every write, and reads of credentials
  and request logs).
- **A data-plane gap is fixed in Otoroshi, never worked around in the model.** When you hit one,
  verify it in `../otoroshi` source and log it in `OTOROSHI-GAPS.md` (G-n, severity, source line,
  what the product does meanwhile, proposed fix).
- One installation drives **one** Otoroshi cluster: no cluster object, no multi-gateway.
- The tenant is called **workspace** everywhere; one portal per workspace, resolved from the URL.
- CSS is hand-written: no framework, no component library. Charts follow the dataviz method
  (palette validated, legend for ≥ 2 series, table view).

## Code map

- `server/main.js` — role dispatch, sessions, portal resolution, static files
- `server/domain/` — model (draft shape, validation, resolution order), apis, deployments,
  subscriptions, applications, identity (users, workspaces, teams, ACL tags), tasks, ingest,
  analytics, exchange (export/import, declarative documents), audit, diff
- `server/otoroshi/` — admin api client, projection (snapshot → entities, comparable form for
  drift), drift detection and adopt
- `web/shared/` — theme tokens, router (filters in the url), components, svg charts
- `web/backoffice/`, `web/portal/` — the two apps (portal UI strings in en/fr via `i18n.jsx`)

## Conventions

- Commit as you go, small and descriptive.
- Postgres via `Bun.SQL`: pass objects and arrays directly for jsonb columns; jsonb does not keep
  key order, so compare documents with `diff()` / `stable()` from `server/domain/diff.js`.
- Ids are prefixed uuidv7 (`api_…`, `plan_…`, `sub_…`); the Otoroshi `Api` id is the product api id.
