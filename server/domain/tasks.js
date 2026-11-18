// Product operations are asynchronous and replayable: a projection that cannot reach the
// gateway waits in this queue and runs when it comes back. Handlers are idempotent.

import { db, newId } from '../db/index.js';
import { likePattern } from '../http/paging.js';

const handlers = new Map();

export function registerTaskHandler(kind, fn) {
  handlers.set(kind, fn);
}

export async function enqueue(kind, payload, { dedupeKey = null, runNow = true } = {}) {
  let task;
  if (dedupeKey) {
    const existing = await db`select * from tasks where dedupe_key = ${dedupeKey} and status in ('pending', 'failed') limit 1`;
    if (existing[0]) {
      const rows = await db`update tasks set payload = ${payload}, status = 'pending', run_after = now(), updated_at = now()
        where id = ${existing[0].id} returning *`;
      task = rows[0];
    }
  }
  if (!task) {
    const rows = await db`insert into tasks (id, kind, payload, dedupe_key) values (${newId('task')}, ${kind}, ${payload}, ${dedupeKey}) returning *`;
    task = rows[0];
  }
  if (runNow) return runTask(task.id);
  return task;
}

const backoff = (attempts) => Math.min(2 ** attempts, 300);

export async function runTask(id) {
  // claim the task: a concurrent worker skips it
  const claimed = await db`update tasks set status = 'running', attempts = attempts + 1, updated_at = now()
    where id = ${id} and status in ('pending', 'failed') returning *`;
  const task = claimed[0];
  if (!task) return (await db`select * from tasks where id = ${id}`)[0];
  const handler = handlers.get(task.kind);
  try {
    if (!handler) throw new Error(`no handler for task kind ${task.kind}`);
    const result = await handler(task.payload, task);
    const rows = await db`update tasks set status = 'done', last_error = null, updated_at = now(),
      payload = ${{ ...task.payload, result: result ?? null }} where id = ${id} returning *`;
    return rows[0];
  } catch (e) {
    const permanent = e.permanent === true || task.attempts >= 25;
    const rows = await db`update tasks set status = ${permanent ? 'failed' : 'pending'}, last_error = ${String(e.message || e)},
      run_after = now() + make_interval(secs => ${backoff(task.attempts)}), updated_at = now() where id = ${id} returning *`;
    return rows[0];
  }
}

let running = false;
export async function workOnce() {
  if (running) return;
  running = true;
  try {
    const due = await db`select id from tasks where status = 'pending' and run_after <= now() order by created_at limit 20`;
    for (const t of due) await runTask(t.id);
    await dismissObsolete();
    // a task stuck in running (crash during execution) is released after a while
    await db`update tasks set status = 'pending' where status = 'running' and updated_at < now() - interval '2 minutes'`;
  } catch (e) {
    console.error('[apim] task worker error', e.message);
  } finally {
    running = false;
  }
}

// the task queue as a paged list, searched over the kind, the payload and the last error
// the workspace a task works for, from the api, the subscription or the deployment it carries
const taskWorkspace = () => db`coalesce(payload->>'workspace_id',
    (select workspace_id from apis where id = payload->>'api_id'),
    (select workspace_id from subscriptions where id = payload->>'subscription_id'),
    (select a.workspace_id from api_deployments d join apis a on a.id = d.api_id where d.id = payload->>'deployment_id'))`;

// workspaceIds: the workspaces the reader may see (null: all of them, an installation administrator)
export async function searchTasks({ status, limit = 50, offset = 0, q = '', workspaceIds = null } = {}) {
  const pattern = q ? likePattern(q) : null;
  const wsArr = workspaceIds ? `{${workspaceIds.join(',')}}` : null;
  const where = () => db`(${status || null}::text is null or status = ${status || null})
      and (${pattern}::text is null or kind ilike ${pattern} or payload::text ilike ${pattern} or coalesce(last_error, '') ilike ${pattern})
      and (${wsArr}::text[] is null or ${taskWorkspace()} = any(${wsArr}::text[]))`;
  const [items, [{ total }]] = await Promise.all([
    db`select * from tasks where ${where()} order by updated_at desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from tasks where ${where()}`,
  ]);
  return { items: await describeTasks(items), total, limit, offset };
}

// a failed task whose object is gone has nothing left to do: it would otherwise stay in the queue,
// failed, for good — a subscription deleted with its workspace while its projection had failed
export async function dismissObsolete() {
  const subs = await db`update tasks set status = 'dismissed', payload = payload || ${{ dismissed: 'its subscription no longer exists' }}::jsonb, updated_at = now()
    where status = 'failed' and kind = 'sync_subscription' and not exists (select 1 from subscriptions s where s.id = tasks.payload->>'subscription_id') returning id`;
  const deps = await db`update tasks set status = 'dismissed', payload = payload || ${{ dismissed: 'its deployment no longer exists' }}::jsonb, updated_at = now()
    where status = 'failed' and kind in ('deploy_api', 'undeploy_api') and not exists (select 1 from api_deployments d where d.id = tasks.payload->>'deployment_id') returning id`;
  return subs.length + deps.length;
}

// a failed task an operator gives up: it no longer counts as something to do
export async function dismissTask(id, reason) {
  const rows = await db`update tasks set status = 'dismissed', payload = payload || ${{ dismissed: reason }}::jsonb, updated_at = now()
    where id = ${id} and status = 'failed' returning *`;
  return rows[0] || null;
}

const pgArray = (list) => `{${list.map((x) => `"${String(x).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;

// what each task works on, as a person reads it: the subscription, the api, the application — or
// that it no longer exists
export async function describeTasks(items) {
  const ids = (key) => [...new Set(items.map((t) => t.payload?.[key]).filter(Boolean))];
  const [subs, deps, apis, apps] = await Promise.all([
    ids('subscription_id').length
      ? db`select s.id, ap.name as app, a.name as api, a.version, w.slug as ws from subscriptions s join apis a on a.id = s.api_id
          join applications ap on ap.id = s.application_id join workspaces w on w.id = s.workspace_id where s.id = any(${pgArray(ids('subscription_id'))}::text[])`
      : [],
    ids('deployment_id').length
      ? db`select d.id, a.id as api_id, a.name as api, a.version, w.slug as ws from api_deployments d join apis a on a.id = d.api_id
          join workspaces w on w.id = a.workspace_id where d.id = any(${pgArray(ids('deployment_id'))}::text[])`
      : [],
    ids('api_id').length
      ? db`select a.id, a.name as api, a.version, w.slug as ws from apis a join workspaces w on w.id = a.workspace_id where a.id = any(${pgArray(ids('api_id'))}::text[])`
      : [],
    ids('application_id').length
      ? db`select ap.id, ap.name as app, w.slug as ws from applications ap join workspaces w on w.id = ap.workspace_id where ap.id = any(${pgArray(ids('application_id'))}::text[])`
      : [],
  ]);
  const find = (rows, id) => rows.find((r) => r.id === id);
  const target = (p = {}) => {
    if (p.subscription_id) {
      const x = find(subs, p.subscription_id);
      return x ? { kind: 'subscription', label: `${x.app} → ${x.api} ${x.version}`, workspace: x.ws, link: `/ws/${x.ws}/subscriptions?open=${p.subscription_id}` } : { kind: 'subscription', missing: true, label: 'a subscription that no longer exists' };
    }
    if (p.deployment_id) {
      const x = find(deps, p.deployment_id) || (p.api_id && find(apis, p.api_id) && { ...find(apis, p.api_id), api_id: p.api_id });
      return x ? { kind: 'api', label: `${x.api} ${x.version}`, workspace: x.ws, link: `/ws/${x.ws}/apis/${x.api_id || x.id}/deployment` } : { kind: 'api', missing: true, label: 'a deployment that no longer exists' };
    }
    if (p.api_id) {
      const x = find(apis, p.api_id);
      return x ? { kind: 'api', label: `${x.api} ${x.version}`, workspace: x.ws, link: `/ws/${x.ws}/apis/${p.api_id}` } : { kind: 'api', missing: true, label: 'an api that no longer exists' };
    }
    if (p.application_id) {
      const x = find(apps, p.application_id);
      return x ? { kind: 'application', label: x.app, workspace: x.ws, link: `/ws/${x.ws}/applications/${p.application_id}` } : { kind: 'application', missing: true, label: 'an application that no longer exists' };
    }
    return null;
  };
  return items.map((t) => ({ ...t, target: target(t.payload) }));
}

export async function listTasks({ status, limit = 100 } = {}) {
  return db`select * from tasks where (${status || null}::text is null or status = ${status || null})
    order by updated_at desc limit ${Math.min(limit, 500)}`;
}

export async function queueStats({ workspaceIds = null } = {}) {
  const wsArr = workspaceIds ? `{${workspaceIds.join(',')}}` : null;
  const rows = await db`select status, count(*)::int as c from tasks where (${wsArr}::text[] is null or ${taskWorkspace()} = any(${wsArr}::text[])) group by status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.c]));
}

export class PermanentError extends Error {
  constructor(msg) {
    super(msg);
    this.permanent = true;
  }
}
