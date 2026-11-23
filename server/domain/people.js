// Deleting a person — what an installation administrator does on a request to be forgotten, or when
// someone leaves. A person is global: one record, memberships in several workspaces.
//
// What goes with the person: their personal teams and the applications in them — the subscriptions of
// those applications closed first (the gateway revokes their keys, a payment stops), so nothing keeps
// calling in the name of someone who is gone —, their sessions and api tokens, their memberships of
// workspaces and teams, their notifications, their reviews. What stays: the teams they shared with
// others (their other members keep them), and the audit trail, the record of what was done.

import { db } from '../db/index.js';
import { config } from '../config.js';
import { audit } from './audit.js';
import { badRequest } from '../http/router.js';
import { OPEN_STATUSES, closeSubscription } from './subscriptions.js';
import { deleteApplication } from './applications.js';

export const isBootstrapAdmin = (user) => config.bootstrap.admins.some((e) => e.toLowerCase() === String(user.email || '').toLowerCase());

export async function deleteUser(ctx, user) {
  if (user.id === ctx.user?.id) throw badRequest('you cannot delete yourself');
  // made again at the next start: the variable decides
  if (isBootstrapAdmin(user)) throw badRequest(`${user.email} is a bootstrap administrator (APIM_BOOTSTRAP_ADMINS): remove it from there first`);

  const teams = await db`select t.* from teams t join team_members tm on tm.team_id = t.id where tm.user_id = ${user.id} and t.personal = true`;
  const apps = teams.length ? await db`select * from applications where team_id in ${db(teams.map((t) => t.id))}` : [];
  const subs = apps.length ? await db`select * from subscriptions where application_id in ${db(apps.map((a) => a.id))} and status in ${db(OPEN_STATUSES)}` : [];
  // what a source declares (a remote catalog, Kubernetes) is the source's: it would make it again
  const managed = [...apps, ...subs].find((x) => x.managed_by);
  if (managed) throw badRequest(`an application or a subscription of ${user.email} is managed by ${managed.managed_by}: remove it from its source first`);

  for (const sub of subs) await closeSubscription(ctx, sub);
  for (const app of apps) await deleteApplication(ctx, app);
  if (teams.length) await db`delete from teams where id in ${db(teams.map((t) => t.id))}`;
  // sessions, api tokens, memberships, notifications and reviews go with the record
  await db`delete from users where id = ${user.id}`;

  const summary = `user ${user.email} deleted: ${apps.length} application(s), ${subs.length} subscription(s) closed`;
  await audit(ctx, { action: 'user.delete', entityKind: 'user', entityId: user.id, summary });
  return { id: user.id, email: user.email, applications: apps.length, subscriptions: subs.length };
}
