// The catalogue as a discovery system, on three axes that correct each other's blind spots: the
// editorial one (categories and featured apis, decided by the producers), the reviews of the
// consumers (a rating and a comment, from those who subscribed), and the real usage (the
// applications subscribed, the calls of the last thirty days).

import { db, newId, slugify } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../http/router.js';
import { audit } from './audit.js';

// the categories of a workspace, in its portal: a slug and a name per language
export function normalizeCategories(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw badRequest('the categories of the portal are a list');
  const seen = new Set();
  return list.map((c, i) => {
    const slug = slugify(c?.slug || '');
    if (!c?.slug || slug !== String(c.slug)) throw badRequest(`category #${i + 1}: its slug is made of lowercase letters, digits and dashes`);
    if (seen.has(slug)) throw badRequest(`two categories have the slug ${slug}`);
    seen.add(slug);
    const name = c.name && typeof c.name === 'object' ? Object.fromEntries(Object.entries(c.name).filter(([, v]) => typeof v === 'string' && v.trim())) : typeof c.name === 'string' ? { en: c.name } : {};
    if (!Object.keys(name).length) throw badRequest(`category ${slug}: give it a name`);
    return { slug, name };
  });
}

// where an api stands in the catalogue, across its versions: an editorial decision, not a
// description — it needs no new snapshot, and holds on an api a remote catalog manages
export async function setPlacement(ctx, api, { categories, featured } = {}) {
  if (categories !== undefined && !Array.isArray(categories)) throw badRequest('categories is a list of slugs');
  const ws = (await db`select portal from workspaces where id = ${api.workspace_id}`)[0];
  const known = new Set((ws?.portal?.categories || []).map((c) => c.slug));
  const next = categories === undefined ? api.categories || [] : [...new Set(categories)];
  const unknown = next.filter((c) => !known.has(c));
  if (unknown.length) throw badRequest(`unknown categories: ${unknown.join(', ')} — declare them in the portal of the workspace first`);
  const isFeatured = featured === undefined ? !!api.featured : !!featured;
  await db`update apis set categories = ${next}, featured = ${isFeatured}, updated_at = now() where workspace_id = ${api.workspace_id} and slug = ${api.slug}`;
  await audit(ctx, { action: 'api.placement', workspaceId: api.workspace_id, entityKind: 'api', entityId: api.id, summary: `${api.name}: ${next.length ? next.join(', ') : 'no category'}${isFeatured ? ', featured' : ''}` });
  return { categories: next, featured: isFeatured };
}

// ---------------------------------------------------------------- reviews

// who may review an api: a person whose applications subscribed to one of its versions, now or before
export async function canReview(user, workspaceId, slug) {
  if (!user) return false;
  const rows = await db`select 1 from subscriptions s
      join apis a on a.id = s.api_id
      join applications app on app.id = s.application_id
      join team_members m on m.team_id = app.team_id
    where a.workspace_id = ${workspaceId} and a.slug = ${slug} and m.user_id = ${user.id}
      and s.status in ('active', 'suspended', 'expired', 'closed') limit 1`;
  return rows.length > 0;
}

export async function listReviews(workspaceId, slug, { includeHidden = false } = {}) {
  return db`select r.id, r.api_slug, r.rating, r.comment, r.hidden, r.hidden_by, r.created_at, r.updated_at, r.user_id, u.name as author
    from api_reviews r join users u on u.id = r.user_id
    where r.workspace_id = ${workspaceId} and r.api_slug = ${slug} and (${includeHidden} or not r.hidden)
    order by r.updated_at desc`;
}

export async function saveReview(ctx, workspaceId, slug, { rating, comment = '' }) {
  if (!(await canReview(ctx.user, workspaceId, slug))) throw forbidden('only the consumers who subscribed to this api review it');
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) throw badRequest('a rating is a whole number from 1 to 5');
  const text = String(comment || '').trim().slice(0, 2000);
  const rows = await db`insert into api_reviews (id, workspace_id, api_slug, user_id, rating, comment)
    values (${newId('rev')}, ${workspaceId}, ${slug}, ${ctx.user.id}, ${r}, ${text})
    on conflict (workspace_id, api_slug, user_id) do update set rating = excluded.rating, comment = excluded.comment, updated_at = now()
    returning *`;
  await audit(ctx, { action: 'api.review', workspaceId, entityKind: 'review', entityId: rows[0].id, summary: `${slug} rated ${r}/5` });
  return rows[0];
}

export async function deleteReview(ctx, workspaceId, slug) {
  await db`delete from api_reviews where workspace_id = ${workspaceId} and api_slug = ${slug} and user_id = ${ctx.user.id}`;
  await audit(ctx, { action: 'api.review.delete', workspaceId, entityKind: 'review', entityId: slug, summary: `review of ${slug} withdrawn` });
}

// a producer hides a review — off the portal, kept, and shown again on demand
export async function hideReview(ctx, workspaceId, id, hidden) {
  const rows = await db`update api_reviews set hidden = ${!!hidden}, hidden_by = ${hidden ? ctx.user?.email || 'admin' : null}, updated_at = now()
    where id = ${id} and workspace_id = ${workspaceId} returning *`;
  if (!rows[0]) throw notFound('review not found');
  await audit(ctx, { action: hidden ? 'api.review.hide' : 'api.review.show', workspaceId, entityKind: 'review', entityId: id, summary: `review of ${rows[0].api_slug} ${hidden ? 'hidden' : 'shown again'}` });
  return rows[0];
}

// the rating of each api of a workspace, from the reviews shown
export async function ratings(workspaceId) {
  const rows = await db`select api_slug, round(avg(rating)::numeric, 1)::float8 as average, count(*)::int as count
    from api_reviews where workspace_id = ${workspaceId} and not hidden group by api_slug`;
  return new Map(rows.map((r) => [r.api_slug, { average: r.average, count: r.count }]));
}

// the applications subscribed to each api, across its versions
export async function subscribers(workspaceId) {
  const rows = await db`select a.slug, count(distinct s.application_id)::int as applications
    from subscriptions s join apis a on a.id = s.api_id
    where a.workspace_id = ${workspaceId} and s.status = 'active' group by a.slug`;
  return new Map(rows.map((r) => [r.slug, r.applications]));
}
