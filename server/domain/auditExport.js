// Audit trail exporters: the trail written by the admin api leaves the product in batches, to a
// SIEM or a log pipeline, like Otoroshi's data exporters do for its events. Each exporter keeps a
// cursor: at least once, in order, nothing lost while the target is down.

import { db, newId } from '../db/index.js';
import { badRequest, notFound } from '../http/router.js';
import { audit } from './audit.js';

export async function listExporters() {
  return db`select e.*, (select max(id) from audit_events) - e.cursor as lag from audit_exporters e order by e.name`;
}

export async function getExporter(id) {
  const rows = await db`select * from audit_exporters where id = ${id}`;
  if (!rows[0]) throw notFound('exporter not found');
  return rows[0];
}

export async function saveExporter(ctx, input, existing = null) {
  if (!input.url) throw badRequest('url is required');
  try {
    new URL(input.url);
  } catch (e) {
    throw badRequest('invalid url');
  }
  const v = { ...existing, ...input };
  if (existing) {
    const rows = await db`update audit_exporters set name = ${v.name || v.url}, workspace_id = ${v.workspace_id || null}, url = ${v.url},
        headers = ${v.headers || {}}, actions = ${v.actions || []}, enabled = ${v.enabled !== false}, batch_size = ${v.batch_size || 100}
      where id = ${existing.id} returning *`;
    await audit(ctx, { action: 'audit.exporter.update', entityKind: 'audit_exporter', entityId: existing.id, summary: `audit exporter ${v.name} updated` });
    return rows[0];
  }
  // a new exporter starts from now on, unless asked to replay the whole trail
  const start = input.from_beginning ? 0 : (await db`select coalesce(max(id), 0)::bigint as m from audit_events`)[0].m;
  const id = newId('aexp');
  const rows = await db`insert into audit_exporters (id, name, workspace_id, url, headers, actions, enabled, batch_size, cursor)
    values (${id}, ${v.name || v.url}, ${v.workspace_id || null}, ${v.url}, ${v.headers || {}}, ${v.actions || []}, ${v.enabled !== false}, ${v.batch_size || 100}, ${start})
    returning *`;
  await audit(ctx, { action: 'audit.exporter.create', entityKind: 'audit_exporter', entityId: id, summary: `audit exporter ${rows[0].name} created` });
  return rows[0];
}

export async function deleteExporter(ctx, ex) {
  await db`delete from audit_exporters where id = ${ex.id}`;
  await audit(ctx, { action: 'audit.exporter.delete', entityKind: 'audit_exporter', entityId: ex.id, summary: `audit exporter ${ex.name} deleted` });
}

function matches(ex, e) {
  if (ex.workspace_id && e.workspace_id !== ex.workspace_id) return false;
  if (!ex.actions?.length) return true;
  return ex.actions.some((p) => e.action.startsWith(p));
}

async function post(ex, events) {
  const res = await fetch(ex.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ex.headers || {}) },
    body: JSON.stringify(events.map((e) => ({ '@type': 'ApimAuditEvent', '@id': String(e.id), '@timestamp': e.at, ...e }))),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${ex.url} answered ${res.status}`);
}

export async function deliver(ex) {
  const events = await db`select * from audit_events where id > ${ex.cursor} order by id limit ${ex.batch_size}`;
  if (!events.length) return { delivered: 0 };
  const selected = events.filter((e) => matches(ex, e));
  const last = events[events.length - 1].id;
  try {
    if (selected.length) await post(ex, selected);
    await db`update audit_exporters set cursor = ${last}, last_error = null, delivered = delivered + ${selected.length},
      last_delivery_at = case when ${selected.length} > 0 then now() else last_delivery_at end where id = ${ex.id}`;
    return { delivered: selected.length, cursor: last };
  } catch (e) {
    // the cursor does not move: the batch is delivered again at the next tick
    await db`update audit_exporters set last_error = ${e.message} where id = ${ex.id}`;
    return { error: e.message };
  }
}

export async function deliverAll() {
  const exporters = await db`select * from audit_exporters where enabled = true`;
  for (const ex of exporters) {
    // drain the backlog, a few batches per tick
    for (let i = 0; i < 10; i++) {
      const r = await deliver({ ...ex, ...(await getExporter(ex.id)) });
      if (!r.delivered && !r.cursor) break;
      if (r.error) break;
    }
  }
}

export async function testExporter(ex) {
  try {
    await post(ex, [{ id: 0, at: new Date().toISOString(), action: 'audit.exporter.test', summary: 'test event from otoroshi-api-management', actor: {}, data: {} }]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
