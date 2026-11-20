// Users are global: one record per person, with memberships in several workspaces.
// An administrator only sees the users who are members of its workspaces.

import { db, newId, slugify } from '../db/index.js';
import { open, seal } from './secrets.js';
import { config } from '../config.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../http/router.js';
import { audit } from './audit.js';
import { normalizeCategories } from './discovery.js';

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, tags: u.tags, is_admin: u.is_admin, metadata: u.metadata, created_at: u.created_at };
}

export async function findUserByEmail(email) {
  const rows = await db`select * from users where lower(email) = lower(${email})`;
  return rows[0] || null;
}

export async function findUser(id) {
  const rows = await db`select * from users where id = ${id}`;
  return rows[0] || null;
}

export async function createUser({ email, name, password, isAdmin = false, tags = [] }) {
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('a valid email is required');
  if (await findUserByEmail(email)) throw conflict('a user with this email already exists');
  const id = newId('usr');
  const hash = password ? await Bun.password.hash(password) : null;
  const allTags = Array.from(new Set([`user:${email.toLowerCase()}`, ...(isAdmin ? ['role:admin'] : []), ...tags]));
  const rows = await db`insert into users (id, email, name, password_hash, is_admin, tags)
    values (${id}, ${email.toLowerCase()}, ${name || email.split('@')[0]}, ${hash}, ${isAdmin}, ${allTags}) returning *`;
  return rows[0];
}

export async function checkPassword(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !user.password_hash) return null;
  const ok = await Bun.password.verify(password || '', user.password_hash);
  return ok ? user : null;
}

// an identity asserted by an IdP or by the gateway: the user is global, found or created by email
export async function externalUser({ email, name }, via) {
  let user = await findUserByEmail(email);
  if (!user) {
    user = await createUser({ email, name, isAdmin: config.bootstrap.admins.map((x) => x.toLowerCase()).includes(email.toLowerCase()) });
    await audit({ user, via }, { action: 'user.provision', entityKind: 'user', entityId: user.id, summary: `${email} provisioned from ${via}` });
  }
  return user;
}

// ---------------------------------------------------------------- sessions & tokens

export async function createSession(userId, kind) {
  const id = newId('ses') + Bun.randomUUIDv7().replace(/-/g, '');
  const expires = new Date(Date.now() + config.sessionTtlMs);
  await db`insert into sessions (id, user_id, kind, expires_at) values (${id}, ${userId}, ${kind}, ${expires})`;
  return { id, expires };
}

export async function sessionUser(sessionId, kind) {
  if (!sessionId) return null;
  const rows = await db`select u.* from sessions s join users u on u.id = s.user_id
    where s.id = ${sessionId} and s.kind = ${kind} and s.expires_at > now()`;
  return rows[0] || null;
}

export async function deleteSession(sessionId) {
  if (sessionId) await db`delete from sessions where id = ${sessionId}`;
}

function hashToken(token) {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

export async function createApiToken(userId, name) {
  const token = `apim_${Bun.randomUUIDv7().replace(/-/g, '')}${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
  const id = newId('tok');
  await db`insert into api_tokens (id, user_id, name, token_hash, prefix) values (${id}, ${userId}, ${name || 'token'}, ${hashToken(token)}, ${token.slice(0, 12)})`;
  return { id, name, token, prefix: token.slice(0, 12) };
}

export async function listApiTokens(userId) {
  return db`select id, name, prefix, created_at, last_used_at from api_tokens where user_id = ${userId} order by created_at desc`;
}

export async function deleteApiToken(userId, id) {
  await db`delete from api_tokens where id = ${id} and user_id = ${userId}`;
}

export async function tokenUser(token) {
  if (!token) return null;
  if (token === config.adminToken) {
    // the static bootstrap token acts as the first bootstrap admin
    const admin = await findUserByEmail(config.bootstrap.admins[0]);
    return admin;
  }
  const rows = await db`select u.*, t.id as token_id from api_tokens t join users u on u.id = t.user_id
    where t.token_hash = ${hashToken(token)} and (t.expires_at is null or t.expires_at > now())`;
  if (!rows[0]) return null;
  db`update api_tokens set last_used_at = now() where id = ${rows[0].token_id}`.catch(() => {});
  return rows[0];
}

// ---------------------------------------------------------------- workspaces

export function maskSecret(secret) {
  if (!secret) return secret;
  return secret.slice(0, 3) + '••••••••';
}

// never hand an idp secret back to a client
export function maskWorkspace(ws) {
  if (!ws?.portal?.oidc) return ws;
  return { ...ws, portal: { ...ws.portal, oidc: { ...ws.portal.oidc, clientSecret: maskSecret(open(ws.portal.oidc.clientSecret)) } } };
}

// the workspaces of a person, with its role in each (an installation administrator is the
// administrator of every workspace)
export async function listWorkspacesFor(user) {
  if (user.is_admin) return (await db`select * from workspaces order by name`).map((w) => ({ ...w, role: 'admin' }));
  return db`select w.*, m.role from workspaces w join workspace_members m on m.workspace_id = w.id
    where m.user_id = ${user.id} order by w.name`;
}

export async function findWorkspace(idOrSlug) {
  const rows = await db`select * from workspaces where id = ${idOrSlug} or slug = ${idOrSlug}`;
  return rows[0] || null;
}

export function defaultPortalSettings(name) {
  return {
    // the texts of the portal: one per language of the portal (a plain string is the default one)
    title: { en: `${name} developer portal`, fr: `Portail développeur ${name}` },
    tagline: { en: 'Discover, subscribe to and test our APIs.', fr: 'Découvrez nos API, abonnez-vous et testez-les.' },
    accentColor: '#0061bd',
    logoUrl: '',
    languages: ['en', 'fr'],
    defaultLanguage: 'en',
    selfSignup: true,
    homeMarkdown: {},
  };
}

export async function createWorkspace(ctx, { name, slug, description = '' }) {
  if (!name) throw badRequest('name is required');
  if (config.tenancy === 'single' && (await db`select count(*)::int as c from workspaces`)[0].c > 0)
    throw badRequest('this installation serves a single workspace (APIM_TENANCY=single)');
  const s = slugify(slug || name);
  if (await findWorkspace(s)) throw conflict(`workspace "${s}" already exists`);
  const id = newId('ws');
  const rows = await db`insert into workspaces (id, slug, name, description, portal)
    values (${id}, ${s}, ${name}, ${description}, ${defaultPortalSettings(name)}) returning *`;
  if (ctx?.user) await addMember(id, ctx.user.id, 'admin');
  await audit(ctx, { action: 'workspace.create', workspaceId: id, entityKind: 'workspace', entityId: id, summary: `workspace ${name} created` });
  return rows[0];
}

// the pages a workspace writes for its portal, beyond its home: a slug, a title and a markdown
// content per language, in the navigation or not. The order of the list is the order of the
// navigation.
export function normalizePages(pages) {
  if (pages === undefined || pages === null) return [];
  if (!Array.isArray(pages)) throw badRequest('the pages of the portal are a list');
  if (pages.length > 30) throw badRequest('a portal holds 30 pages at most');
  const texts = (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === 'string')) : typeof v === 'string' ? { en: v } : {});
  const seen = new Set();
  return pages.map((p, i) => {
    const slug = slugify(p?.slug || '');
    if (!p?.slug || slug !== String(p.slug)) throw badRequest(`page #${i + 1}: its slug is made of lowercase letters, digits and dashes`);
    if (seen.has(slug)) throw badRequest(`two pages of the portal have the slug ${slug}`);
    seen.add(slug);
    const title = texts(p.title);
    if (!Object.values(title).some((t) => t.trim())) throw badRequest(`page ${slug}: give it a title`);
    return { slug, title, content: texts(p.content), nav: p.nav !== false };
  });
}

export async function updateWorkspace(ctx, ws, patch) {
  const name = patch.name ?? ws.name;
  const description = patch.description ?? ws.description;
  const portal = patch.portal ? { ...ws.portal, ...patch.portal } : ws.portal;
  if (patch.portal?.pages !== undefined) portal.pages = normalizePages(patch.portal.pages);
  if (patch.portal?.categories !== undefined) portal.categories = normalizeCategories(patch.portal.categories);
  // a masked secret sent back by the console keeps the stored one
  if (patch.portal?.oidc && (!patch.portal.oidc.clientSecret || String(patch.portal.oidc.clientSecret).includes('••')))
    portal.oidc = { ...portal.oidc, clientSecret: ws.portal?.oidc?.clientSecret || '' };
  // sealed at rest
  if (portal?.oidc?.clientSecret) portal.oidc = { ...portal.oidc, clientSecret: seal(portal.oidc.clientSecret) };
  const metadata = patch.metadata ?? ws.metadata;
  const rows = await db`update workspaces set name = ${name}, description = ${description}, portal = ${portal},
    metadata = ${metadata}, updated_at = now() where id = ${ws.id} returning *`;
  await audit(ctx, { action: 'workspace.update', workspaceId: ws.id, entityKind: 'workspace', entityId: ws.id, summary: `workspace ${name} updated` });
  return rows[0];
}

export async function deleteWorkspace(ctx, ws) {
  if (config.tenancy === 'single') throw badRequest('the single workspace of this installation cannot be deleted (APIM_TENANCY=single)');
  await db`delete from workspaces where id = ${ws.id}`;
  await audit(ctx, { action: 'workspace.delete', workspaceId: null, entityKind: 'workspace', entityId: ws.id, summary: `workspace ${ws.name} deleted` });
}

export async function addMember(workspaceId, userId, role) {
  if (!['admin', 'producer', 'consumer'].includes(role)) throw badRequest('role must be admin, producer or consumer');
  await db`insert into workspace_members (workspace_id, user_id, role) values (${workspaceId}, ${userId}, ${role})
    on conflict (workspace_id, user_id) do update set role = excluded.role`;
}

export async function membership(workspaceId, userId) {
  const rows = await db`select role from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}`;
  return rows[0]?.role || null;
}

export async function listMembers(workspaceId) {
  return db`select u.id, u.email, u.name, u.tags, m.role, m.created_at from workspace_members m
    join users u on u.id = m.user_id where m.workspace_id = ${workspaceId} order by u.email`;
}

export async function removeMember(workspaceId, userId) {
  await db`delete from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}`;
}

// ---------------------------------------------------------------- teams

export async function listTeams(workspaceId, userId = null) {
  if (userId) {
    return db`select t.* from teams t join team_members tm on tm.team_id = t.id
      where t.workspace_id = ${workspaceId} and tm.user_id = ${userId} order by t.personal desc, t.name`;
  }
  return db`select t.*, (select count(*)::int from team_members tm where tm.team_id = t.id) as members_count
    from teams t where t.workspace_id = ${workspaceId} order by t.personal, t.name`;
}

export async function findTeam(workspaceId, id) {
  const rows = await db`select * from teams where workspace_id = ${workspaceId} and id = ${id}`;
  return rows[0] || null;
}

export async function createTeam(ctx, workspaceId, { name, description = '', personal = false, ownerId = null }) {
  if (!name) throw badRequest('name is required');
  const id = newId('team');
  const rows = await db`insert into teams (id, workspace_id, name, description, personal)
    values (${id}, ${workspaceId}, ${name}, ${description}, ${personal}) returning *`;
  if (ownerId) await db`insert into team_members (team_id, user_id, role) values (${id}, ${ownerId}, 'owner') on conflict do nothing`;
  await audit(ctx, { action: 'team.create', workspaceId, entityKind: 'team', entityId: id, summary: `team ${name} created` });
  return rows[0];
}

export async function updateTeam(ctx, team, patch) {
  const rows = await db`update teams set name = ${patch.name ?? team.name}, description = ${patch.description ?? team.description},
    updated_at = now() where id = ${team.id} returning *`;
  await audit(ctx, { action: 'team.update', workspaceId: team.workspace_id, entityKind: 'team', entityId: team.id, summary: `team ${rows[0].name} updated` });
  return rows[0];
}

export async function deleteTeam(ctx, team) {
  await db`delete from teams where id = ${team.id}`;
  await audit(ctx, { action: 'team.delete', workspaceId: team.workspace_id, entityKind: 'team', entityId: team.id, summary: `team ${team.name} deleted` });
}

export async function teamMembers(teamId) {
  return db`select u.id, u.email, u.name, tm.role from team_members tm join users u on u.id = tm.user_id where tm.team_id = ${teamId} order by u.email`;
}

export async function setTeamMember(ctx, team, userId, role = 'member') {
  const user = await findUser(userId);
  if (!user) throw notFound('user not found');
  await db`insert into team_members (team_id, user_id, role) values (${team.id}, ${userId}, ${role})
    on conflict (team_id, user_id) do update set role = excluded.role`;
  // a team member has to be a workspace member
  if (!(await membership(team.workspace_id, userId))) await addMember(team.workspace_id, userId, 'consumer');
  await audit(ctx, { action: 'team.member.set', workspaceId: team.workspace_id, entityKind: 'team', entityId: team.id, summary: `${user.email} is ${role} of ${team.name}` });
}

export async function removeTeamMember(ctx, team, userId) {
  await db`delete from team_members where team_id = ${team.id} and user_id = ${userId}`;
  await audit(ctx, { action: 'team.member.remove', workspaceId: team.workspace_id, entityKind: 'team', entityId: team.id, summary: `member removed from ${team.name}` });
}

// renaming a team and choosing its members: a workspace administrator, or an owner of the team —
// otherwise anyone could join a team and manage what it owns
export async function canManageTeam(ctx, team) {
  if (ctx.user?.is_admin || ctx.role === 'admin') return true;
  if (!ctx.user) return false;
  const rows = await db`select 1 from team_members where team_id = ${team.id} and user_id = ${ctx.user.id} and role = 'owner'`;
  return rows.length > 0;
}

export async function requireManageTeam(ctx, team) {
  if (!(await canManageTeam(ctx, team))) throw forbidden('only an owner of the team or a workspace administrator manages it');
}

export async function isTeamMember(teamId, userId) {
  const rows = await db`select 1 from team_members where team_id = ${teamId} and user_id = ${userId}`;
  return rows.length > 0;
}

// the implicit one-person team: an individual developer never has to create a team to get a key
export async function personalTeam(ctx, workspaceId, user) {
  const rows = await db`select t.* from teams t join team_members tm on tm.team_id = t.id
    where t.workspace_id = ${workspaceId} and t.personal = true and tm.user_id = ${user.id} and tm.role = 'owner' limit 1`;
  if (rows[0]) return rows[0];
  return createTeam(ctx, workspaceId, { name: user.name || user.email, personal: true, ownerId: user.id });
}

// ---------------------------------------------------------------- request context & permissions

export async function workspaceContext(base, idOrSlug) {
  const ws = await findWorkspace(idOrSlug);
  if (!ws) throw notFound('workspace not found');
  const role = base.user ? (base.user.is_admin ? 'admin' : await membership(ws.id, base.user.id)) : null;
  return { ...base, workspace: ws, role };
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
}

export function requireAdmin(ctx) {
  requireUser(ctx);
  if (!ctx.user.is_admin) throw forbidden('installation administrators only');
}

export function requireRole(ctx, roles) {
  requireUser(ctx);
  if (ctx.user.is_admin) return;
  if (!roles.includes(ctx.role)) throw forbidden(`requires one of: ${roles.join(', ')}`);
}

// ACL by tags: user:<email>, team:<id>, role:<name>
export async function userAclTags(user, workspaceId) {
  if (!user) return [];
  const tags = new Set(user.tags || []);
  tags.add(`user:${user.email}`);
  if (user.is_admin) tags.add('role:admin');
  if (workspaceId) {
    const role = await membership(workspaceId, user.id);
    if (role) tags.add(`role:${role}`);
    const teams = await db`select t.id from teams t join team_members tm on tm.team_id = t.id where t.workspace_id = ${workspaceId} and tm.user_id = ${user.id}`;
    teams.forEach((t) => tags.add(`team:${t.id}`));
  }
  return [...tags];
}

export function aclAllows(visibility, acl, userTags, isProducer = false) {
  if (isProducer) return true;
  if (visibility === 'public') return true;
  if (!userTags.length) return false;
  if (visibility === 'authenticated') return true;
  return (acl || []).some((t) => userTags.includes(t));
}

// ---------------------------------------------------------------- bootstrap

// a single-workspace installation serves the bootstrap workspace at the root: any other would
// have no portal, and no place in a console without a workspace selector
export async function checkTenancy() {
  if (config.tenancy !== 'single') return;
  const others = await db`select slug from workspaces where slug <> ${config.bootstrap.workspace} order by slug`;
  const served = await findWorkspace(config.bootstrap.workspace);
  if (!served && others.length === 1)
    throw new Error(`APIM_TENANCY=single serves the workspace APIM_BOOTSTRAP_WORKSPACE ("${config.bootstrap.workspace}"), which does not exist: set APIM_BOOTSTRAP_WORKSPACE=${others[0].slug}`);
  if (others.length)
    throw new Error(
      `APIM_TENANCY=single serves the workspace "${config.bootstrap.workspace}" alone, and this installation has others: ${others.map((w) => w.slug).join(', ')}. Delete them, or keep APIM_TENANCY=multi.`
    );
}

export async function bootstrap() {
  let first = null;
  for (const email of config.bootstrap.admins) {
    let user = await findUserByEmail(email);
    if (!user) {
      user = await createUser({ email, name: email.split('@')[0], password: config.bootstrap.password, isAdmin: true });
      console.log(`[apim] bootstrap admin created: ${email}`);
    } else if (!user.is_admin) {
      await db`update users set is_admin = true where id = ${user.id}`;
    }
    first = first || user;
  }
  const count = (await db`select count(*)::int as c from workspaces`)[0].c;
  if (count === 0) {
    const ws = await createWorkspace({ user: first, via: 'bootstrap' }, { name: 'Default', slug: config.bootstrap.workspace });
    await createTeam({ user: first, via: 'bootstrap' }, ws.id, { name: 'Platform team', ownerId: first.id });
    console.log(`[apim] bootstrap workspace created: ${ws.slug}`);
  }
}
