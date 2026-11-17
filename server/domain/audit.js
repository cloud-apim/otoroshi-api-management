// The admin api writes the audit trail itself: every write goes through it, so nothing escapes.
import { db } from '../db/index.js';

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

export async function listAudit(workspaceId, { limit = 100, before, entityId, action } = {}) {
  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  return db`select * from audit_events
    where (${workspaceId}::text is null or workspace_id = ${workspaceId})
      and (${entityId || null}::text is null or entity_id = ${entityId || null})
      and (${action || null}::text is null or action like ${(action || '') + '%'})
      and (${before || null}::bigint is null or id < ${before || null})
    order by id desc limit ${lim}`;
}
