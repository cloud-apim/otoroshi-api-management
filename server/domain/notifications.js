// In-app notifications. D-30 asks for a systematic notification when a subscription changes; the
// review of a request and its decision follow the same path.

import { db, newId } from '../db/index.js';

export async function notify({ workspaceId, teamId = null, userId = null, face = 'portal', kind, title, body = '', link = null, data = {} }) {
  if (!teamId && !userId) return;
  await db`insert into notifications (id, workspace_id, team_id, user_id, face, kind, title, body, link, data)
    values (${newId('ntf')}, ${workspaceId}, ${teamId}, ${userId}, ${face}, ${kind}, ${title}, ${body}, ${link}, ${data})`;
}

export async function listFor(user, workspaceId, face, { limit = 50 } = {}) {
  return db`select n.* from notifications n
    where n.workspace_id = ${workspaceId} and n.face = ${face}
      and (n.user_id = ${user.id} or n.team_id in (select team_id from team_members where user_id = ${user.id}))
    order by n.created_at desc limit ${limit}`;
}

export async function unreadCount(user, workspaceId, face) {
  const rows = await db`select count(*)::int as c from notifications n
    where n.workspace_id = ${workspaceId} and n.face = ${face} and n.read_at is null
      and (n.user_id = ${user.id} or n.team_id in (select team_id from team_members where user_id = ${user.id}))`;
  return rows[0].c;
}

export async function markRead(user, workspaceId, face) {
  await db`update notifications set read_at = now() where workspace_id = ${workspaceId} and face = ${face} and read_at is null
    and (user_id = ${user.id} or team_id in (select team_id from team_members where user_id = ${user.id}))`;
}
