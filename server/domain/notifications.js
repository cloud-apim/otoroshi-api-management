// In-app notifications: every change of a subscription is notified to its consumers; the
// review of a request and its decision follow the same path. A notification is addressed to a
// person or to a team, and each person reads it, and marks it done, on their own.

import { db, newId } from '../db/index.js';
import { likePattern } from '../http/paging.js';

export async function notify({ workspaceId, teamId = null, userId = null, face = 'portal', kind, title, body = '', link = null, data = {} }) {
  if (!teamId && !userId) return;
  await db`insert into notifications (id, workspace_id, team_id, user_id, face, kind, title, body, link, data)
    values (${newId('ntf')}, ${workspaceId}, ${teamId}, ${userId}, ${face}, ${kind}, ${title}, ${body}, ${link}, ${data})`;
}

// what there is to decide about an api goes to its team; an api of no team is decided by the
// administrators of its workspace, each of them told
export async function notifyApiTeam(teamId, note) {
  if (teamId) return notify({ ...note, teamId });
  const admins = await db`select user_id from workspace_members where workspace_id = ${note.workspaceId} and role = 'admin'`;
  for (const a of admins) await notify({ ...note, userId: a.user_id });
}

// what changes for the consumers of apis: the teams of the applications subscribed to them — an open
// subscription, waiting or running —, each told once, in the portal
export async function notifySubscribers(apiIds, note) {
  if (!apiIds.length) return 0;
  const teams = await db`select distinct app.team_id from subscriptions s join applications app on app.id = s.application_id
    where s.api_id in ${db(apiIds)} and s.status in ('pending', 'pending_payment', 'active', 'suspended', 'expired')`;
  for (const t of teams) await notify({ ...note, face: 'portal', teamId: t.team_id });
  return teams.length;
}

// the notifications of a person in a workspace, with their own read and done marks.
// filter: 'open' (not done, the default), 'unread', 'done', 'all'
export async function searchFor(user, workspaceId, face, { filter = 'open', limit = 50, offset = 0, q = '' } = {}) {
  const pattern = q ? likePattern(q) : null;
  const where = () => db`n.workspace_id = ${workspaceId} and n.face = ${face}
    and (${pattern}::text is null or n.title ilike ${pattern} or n.body ilike ${pattern})
    and (n.user_id = ${user.id} or n.team_id in (select team_id from team_members where user_id = ${user.id}))
    and (${filter} = 'all' or (${filter} = 'done' and st.done_at is not null) or (${filter} = 'open' and st.done_at is null)
      or (${filter} = 'unread' and st.read_at is null and st.done_at is null))`;
  const [items, [{ total }]] = await Promise.all([
    db`select n.id, n.workspace_id, n.team_id, n.user_id, n.face, n.kind, n.title, n.body, n.link, n.data, n.created_at, st.read_at, st.done_at
      from notifications n left join notification_states st on st.notification_id = n.id and st.user_id = ${user.id}
      where ${where()} order by n.created_at desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from notifications n left join notification_states st on st.notification_id = n.id and st.user_id = ${user.id} where ${where()}`,
  ]);
  return { items, total, limit, offset };
}

export async function listFor(user, workspaceId, face, { limit = 50 } = {}) {
  return (await searchFor(user, workspaceId, face, { limit })).items;
}

export async function unreadCount(user, workspaceId, face) {
  return (await searchFor(user, workspaceId, face, { filter: 'unread', limit: 1 })).total;
}

// the notifications of a person among `ids`, or all of theirs in the workspace
async function mine(user, workspaceId, face, ids) {
  const rows = await db`select n.id from notifications n where n.workspace_id = ${workspaceId} and n.face = ${face}
    and (n.user_id = ${user.id} or n.team_id in (select team_id from team_members where user_id = ${user.id}))`;
  return rows.map((r) => r.id).filter((id) => !ids || ids.includes(id));
}

export async function markRead(user, workspaceId, face, ids = null) {
  for (const id of await mine(user, workspaceId, face, ids))
    await db`insert into notification_states (notification_id, user_id, read_at) values (${id}, ${user.id}, now())
      on conflict (notification_id, user_id) do update set read_at = coalesce(notification_states.read_at, now())`;
}

// done: dealt with, out of the list — read too
export async function markDone(user, workspaceId, face, ids, done = true) {
  for (const id of await mine(user, workspaceId, face, ids))
    await db`insert into notification_states (notification_id, user_id, read_at, done_at) values (${id}, ${user.id}, now(), ${done ? new Date() : null})
      on conflict (notification_id, user_id) do update set read_at = coalesce(notification_states.read_at, now()), done_at = excluded.done_at`;
}
