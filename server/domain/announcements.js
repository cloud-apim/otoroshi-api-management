// The announcements of an api, like a blog: posts on its page in the portal, written by its producers,
// its subscribers told in their notifications. They belong to the api across its versions — its slug,
// as its reviews do — and never reach the gateway.

import { db, newId } from '../db/index.js';
import { badRequest, notFound } from '../http/router.js';
import { audit } from './audit.js';
import { notifySubscribers } from './notifications.js';

const TITLE_MAX = 200;
const BODY_MAX = 20000;

function checked(input, current = {}) {
  const title = String(input.title ?? current.title ?? '').trim();
  const body = String(input.body ?? current.body ?? '');
  if (!title) throw badRequest('an announcement has a title');
  if (title.length > TITLE_MAX) throw badRequest(`the title of an announcement is ${TITLE_MAX} characters at most`);
  if (body.length > BODY_MAX) throw badRequest(`the text of an announcement is ${BODY_MAX} characters at most`);
  return { title, body };
}

// the first words of a text written in Markdown, for a notification
export function excerpt(markdown, max = 280) {
  const text = String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export async function listAnnouncements(workspaceId, slug) {
  return db`select an.id, an.api_slug, an.title, an.body, an.created_at, an.updated_at, u.name as author_name
    from api_announcements an left join users u on u.id = an.created_by
    where an.workspace_id = ${workspaceId} and an.api_slug = ${slug} order by an.created_at desc, an.id desc`;
}

// one of them, as listed
export async function showAnnouncement(workspaceId, slug, id) {
  const row = (await db`select an.id, an.api_slug, an.title, an.body, an.created_at, an.updated_at, u.name as author_name
    from api_announcements an left join users u on u.id = an.created_by
    where an.workspace_id = ${workspaceId} and an.api_slug = ${slug} and an.id = ${id}`)[0];
  if (!row) throw notFound('announcement not found');
  return row;
}

export async function getAnnouncement(workspaceId, slug, id) {
  const row = (await db`select * from api_announcements where workspace_id = ${workspaceId} and api_slug = ${slug} and id = ${id}`)[0];
  if (!row) throw notFound('announcement not found');
  return row;
}

// published at once: the subscribers of every version of the api told, unless asked not to
export async function createAnnouncement(ctx, api, input = {}) {
  const v = checked(input);
  const id = newId('ann');
  const rows = await db`insert into api_announcements (id, workspace_id, api_slug, title, body, created_by)
    values (${id}, ${api.workspace_id}, ${api.slug}, ${v.title}, ${v.body}, ${ctx.user?.id || null}) returning *`;
  let told = 0;
  if (input.notify !== false) {
    const versions = await db`select id from apis where workspace_id = ${api.workspace_id} and slug = ${api.slug}`;
    told = await notifySubscribers(
      versions.map((x) => x.id),
      { workspaceId: api.workspace_id, kind: 'api.announcement', title: `${api.name} — ${v.title}`, body: excerpt(v.body), link: `/apis/${api.slug}/announcements/${id}`, data: { api_slug: api.slug, announcement_id: id } }
    );
  }
  await audit(ctx, {
    action: 'api.announcement.publish',
    workspaceId: api.workspace_id,
    entityKind: 'api',
    entityId: api.id,
    summary: `announcement "${v.title}" published on ${api.name}${told ? `, ${told} team(s) of subscribers told` : ''}`,
    data: { announcement_id: id, told },
  });
  return { ...rows[0], told };
}

// corrected in place: nobody is told again
export async function updateAnnouncement(ctx, api, announcement, patch = {}) {
  const v = checked(patch, announcement);
  const rows = await db`update api_announcements set title = ${v.title}, body = ${v.body}, updated_at = now() where id = ${announcement.id} returning *`;
  await audit(ctx, { action: 'api.announcement.update', workspaceId: api.workspace_id, entityKind: 'api', entityId: api.id, summary: `announcement "${v.title}" of ${api.name} updated`, data: { announcement_id: announcement.id } });
  return rows[0];
}

export async function deleteAnnouncement(ctx, api, announcement) {
  await db`delete from api_announcements where id = ${announcement.id}`;
  await audit(ctx, { action: 'api.announcement.delete', workspaceId: api.workspace_id, entityKind: 'api', entityId: api.id, summary: `announcement "${announcement.title}" of ${api.name} deleted`, data: { announcement_id: announcement.id } });
}
