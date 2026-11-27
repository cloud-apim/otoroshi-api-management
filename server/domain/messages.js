// Messages: a conversation between a person of a portal and its workspace — an inbox in the product,
// asynchronous. Its optional subject, an API or a subscription of the person, routes it to the team
// that answers: the team of the API; the administrators of the workspace otherwise, who see them all.
// Each side is told of the other's message in its notifications (and by email when the workspace sends
// them so); each person reads a conversation on their own. The text of a message is Markdown.

import { db, newId } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../http/router.js';
import { likePattern } from '../http/paging.js';
import { audit } from './audit.js';
import { isTeamMember } from './identity.js';
import { notify, notifyApiTeam } from './notifications.js';
import { excerpt } from './announcements.js';

const TITLE_MAX = 200;
const BODY_MAX = 10000;

function checkedBody(body) {
  const b = String(body ?? '').trim();
  if (!b) throw badRequest('a message has a text');
  if (b.length > BODY_MAX) throw badRequest(`a message is ${BODY_MAX} characters at most`);
  return b;
}

// ---------------------------------------------------------------- the subject, and who answers

// an api the person can see (the route found it in the catalogue), or a subscription of theirs: what it
// is called, and the team that answers for it
export async function subjectOf(ctx, workspaceId, subject) {
  if (!subject?.kind) return { kind: null, id: null, label: null, team_id: null };
  if (subject.kind === 'api') {
    const api = (await db`select id, name, version, team_id from apis where workspace_id = ${workspaceId} and id = ${subject.id}`)[0];
    if (!api) throw badRequest('unknown api');
    return { kind: 'api', id: api.id, label: `${api.name} ${api.version}`, team_id: api.team_id };
  }
  if (subject.kind === 'subscription') {
    const s = (await db`select s.id, a.name, a.version, a.team_id, app.name as app_name, app.team_id as app_team
      from subscriptions s join apis a on a.id = s.api_id join applications app on app.id = s.application_id
      where s.workspace_id = ${workspaceId} and s.id = ${subject.id}`)[0];
    if (!s || !(await isTeamMember(s.app_team, ctx.user.id))) throw forbidden('not a subscription of yours');
    return { kind: 'subscription', id: s.id, label: `${s.app_name} → ${s.name} ${s.version}`, team_id: s.team_id };
  }
  throw badRequest('the subject of a conversation is an api or a subscription');
}

// who in the console answers a conversation: the administrators of the workspace, the members of the
// team it is routed to
export async function canAnswer(c, conv) {
  if (c.user?.is_admin || c.role === 'admin') return true;
  if (c.role !== 'producer' || !conv.team_id || !c.user) return false;
  return isTeamMember(conv.team_id, c.user.id);
}

const who = (u) => u?.name || u?.email || 'someone';

async function tellAnswerers(conv, person, body) {
  await notifyApiTeam(conv.team_id, {
    workspaceId: conv.workspace_id,
    face: 'console',
    kind: 'message.received',
    title: `${who(person)} — ${conv.title}`,
    body: excerpt(body),
    link: `/messages/${conv.id}`,
    data: { conversation_id: conv.id },
  });
}

async function tellPerson(conv, body) {
  await notify({ workspaceId: conv.workspace_id, userId: conv.user_id, face: 'portal', kind: 'message.reply', title: `${conv.title}: an answer`, body: excerpt(body), link: `/messages/${conv.id}`, data: { conversation_id: conv.id } });
}

// ---------------------------------------------------------------- writes

// a person of the portal opens one: its title, its subject, its first message
export async function openConversation(ctx, workspaceId, { title, body, subject } = {}) {
  const t = String(title ?? '').trim();
  if (!t) throw badRequest('a conversation has a title');
  if (t.length > TITLE_MAX) throw badRequest(`the title of a conversation is ${TITLE_MAX} characters at most`);
  const b = checkedBody(body);
  const s = await subjectOf(ctx, workspaceId, subject);
  const id = newId('conv');
  const conv = (await db`insert into conversations (id, workspace_id, user_id, title, subject_kind, subject_id, subject_label, team_id, last_from)
    values (${id}, ${workspaceId}, ${ctx.user.id}, ${t}, ${s.kind}, ${s.id}, ${s.label}, ${s.team_id}, 'person') returning *`)[0];
  await db`insert into conversation_messages (id, conversation_id, author_id, side, body) values (${newId('msg')}, ${id}, ${ctx.user.id}, 'person', ${b})`;
  await db`insert into conversation_reads (conversation_id, user_id) values (${id}, ${ctx.user.id})`;
  await audit(ctx, { action: 'conversation.open', workspaceId, entityKind: 'conversation', entityId: id, summary: `conversation "${t}" opened by ${ctx.user.email}${s.label ? `, about ${s.label}` : ''}`, data: { subject: s.kind ? { kind: s.kind, id: s.id } : null } });
  await tellAnswerers(conv, ctx.user, b);
  return conv;
}

// a message, from the person or from the workspace; the person writing again reopens it
export async function addMessage(ctx, conv, side, body) {
  const b = checkedBody(body);
  await db`insert into conversation_messages (id, conversation_id, author_id, side, body) values (${newId('msg')}, ${conv.id}, ${ctx.user?.id || null}, ${side}, ${b})`;
  const status = side === 'person' ? 'open' : conv.status;
  const rows = await db`update conversations set last_message_at = now(), last_from = ${side}, status = ${status}, updated_at = now() where id = ${conv.id} returning *`;
  if (ctx.user) await markRead(ctx.user.id, conv.id);
  await audit(ctx, {
    action: 'conversation.message',
    workspaceId: conv.workspace_id,
    entityKind: 'conversation',
    entityId: conv.id,
    summary: `message in "${conv.title}" from ${side === 'person' ? ctx.user.email : `the workspace (${ctx.user?.email || 'system'})`}`,
    data: { side },
  });
  if (side === 'person') await tellAnswerers(conv, ctx.user, b);
  else await tellPerson(conv, b);
  return rows[0];
}

export async function setStatus(ctx, conv, status) {
  if (!['open', 'closed'].includes(status)) throw badRequest('a conversation is open or closed');
  const rows = await db`update conversations set status = ${status}, updated_at = now() where id = ${conv.id} returning *`;
  await audit(ctx, { action: status === 'closed' ? 'conversation.close' : 'conversation.reopen', workspaceId: conv.workspace_id, entityKind: 'conversation', entityId: conv.id, summary: `conversation "${conv.title}" ${status === 'closed' ? 'closed' : 'reopened'} by ${ctx.user?.email || 'the workspace'}` });
  return rows[0];
}

const markRead = (userId, conversationId) =>
  db`insert into conversation_reads (conversation_id, user_id, read_at) values (${conversationId}, ${userId}, now())
    on conflict (conversation_id, user_id) do update set read_at = now()`;

// ---------------------------------------------------------------- reads

export async function getConversation(workspaceId, id) {
  const conv = (await db`select * from conversations where workspace_id = ${workspaceId} and id = ${id}`)[0];
  if (!conv) throw notFound('conversation not found');
  return conv;
}

// a conversation and its messages, read by whoever opens it
export async function thread(conv, reader) {
  const messages = await db`select m.id, m.side, m.body, m.created_at, u.name as author_name, u.email as author_email
    from conversation_messages m left join users u on u.id = m.author_id where m.conversation_id = ${conv.id} order by m.created_at, m.id`;
  if (reader) await markRead(reader.id, conv.id);
  const person = (await db`select name, email from users where id = ${conv.user_id}`)[0];
  const team = conv.team_id ? (await db`select name from teams where id = ${conv.team_id}`)[0] : null;
  return { ...conv, person_name: person?.name || null, person_email: person?.email || null, team_name: team?.name || null, messages };
}

// the unread mark of a reader: the other side wrote after they last read it
const unreadOf = (uid, otherSide) => db`(cv.last_from = ${otherSide} and cv.last_message_at > coalesce((select r.read_at from conversation_reads r where r.conversation_id = cv.id and r.user_id = ${uid}), 'epoch'))`;

async function search(where, uid, otherSide, { limit = 50, offset = 0 } = {}) {
  const [items, [{ total }]] = await Promise.all([
    db`select cv.*, u.name as person_name, u.email as person_email, t.name as team_name, ${unreadOf(uid, otherSide)} as unread,
        (select count(*)::int from conversation_messages m where m.conversation_id = cv.id) as messages
      from conversations cv join users u on u.id = cv.user_id left join teams t on t.id = cv.team_id
      where ${where()} order by cv.last_message_at desc, cv.id desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from conversations cv join users u on u.id = cv.user_id where ${where()}`,
  ]);
  return { items, total, limit, offset };
}

// the console: the conversations of the workspace one answers, searched by title, subject or person
export async function listForWorkspace(c, { q = '', status = null, limit = 50, offset = 0 } = {}) {
  const admin = !!(c.user?.is_admin || c.role === 'admin');
  const uid = c.user?.id || null;
  const pattern = q ? likePattern(q) : null;
  const where = () => db`cv.workspace_id = ${c.workspace.id}
    and (${admin}::boolean or cv.team_id in (select team_id from team_members where user_id = ${uid}))
    and (${status}::text is null or cv.status = ${status})
    and (${pattern}::text is null or cv.title ilike ${pattern} or cv.subject_label ilike ${pattern} or u.email ilike ${pattern} or u.name ilike ${pattern})`;
  return search(where, uid, 'person', { limit, offset });
}

export async function unreadForWorkspace(c) {
  const admin = !!(c.user?.is_admin || c.role === 'admin');
  const uid = c.user?.id || null;
  if (!uid) return 0;
  return (await db`select count(*)::int as n from conversations cv where cv.workspace_id = ${c.workspace.id} and cv.status = 'open'
    and (${admin}::boolean or cv.team_id in (select team_id from team_members where user_id = ${uid})) and ${unreadOf(uid, 'person')}`)[0].n;
}

// the portal: the conversations of the person
export async function listForPerson(user, workspaceId, { q = '', status = null, limit = 50, offset = 0 } = {}) {
  const pattern = q ? likePattern(q) : null;
  const where = () => db`cv.workspace_id = ${workspaceId} and cv.user_id = ${user.id}
    and (${status}::text is null or cv.status = ${status})
    and (${pattern}::text is null or cv.title ilike ${pattern} or cv.subject_label ilike ${pattern})`;
  return search(where, user.id, 'workspace', { limit, offset });
}

export async function unreadForPerson(user, workspaceId) {
  return (await db`select count(*)::int as n from conversations cv where cv.workspace_id = ${workspaceId} and cv.user_id = ${user.id} and ${unreadOf(user.id, 'workspace')}`)[0].n;
}
