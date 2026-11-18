// The admin api writes the audit trail itself: every write goes through it, so nothing escapes.
import { db } from '../db/index.js';
import { likePattern } from '../http/paging.js';

export async function audit(ctx, { action, workspaceId, entityKind, entityId, summary = '', data = {} }) {
  const actor = ctx?.user
    ? { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, via: ctx.via || 'api' }
    : { id: 'system', email: 'system', name: 'system', via: ctx?.via || 'system' };
  try {
    await db`insert into audit_events (workspace_id, actor, action, entity_kind, entity_id, summary, data, ip)
      values (${workspaceId || ctx?.workspace?.id || null}, ${actor}, ${action}, ${entityKind || null}, ${entityId || null},
              ${summary}, ${data}, ${ctx?.ip || null})`;
  } catch (e) {
    console.error('[apim] audit write failed', e);
  }
}

// the audit trail as a paged list, searched over the action, the summary, the actor and the entity
export async function searchAudit(workspaceId, { limit = 50, offset = 0, q = '', entityId, action } = {}) {
  const pattern = q ? likePattern(q) : null;
  const [items, [{ total }]] = await Promise.all([
    db`select * from audit_events where ${adbWhere(workspaceId, entityId, action, pattern)} order by id desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from audit_events where ${adbWhere(workspaceId, entityId, action, pattern)}`,
  ]);
  return { items, total, limit, offset };
}

function adbWhere(workspaceId, entityId, action, pattern) {
  return db`(${workspaceId}::text is null or workspace_id = ${workspaceId})
      and (${entityId || null}::text is null or entity_id = ${entityId || null})
      and (${action || null}::text is null or action like ${(action || '') + '%'})
      and (${pattern}::text is null or action ilike ${pattern} or summary ilike ${pattern} or actor->>'email' ilike ${pattern} or entity_id ilike ${pattern})`;
}

export async function listAudit(workspaceId, { limit = 100, before, entityId, action } = {}) {
  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  return db`select * from audit_events
    where (${workspaceId}::text is null or workspace_id = ${workspaceId})
      and (${entityId || null}::text is null or entity_id = ${entityId || null})
      and (${action || null}::text is null or action like ${(action || '') + '%'})
      and (${before || null}::bigint is null or id < ${before || null})
    order by id desc limit ${lim}`;
}
