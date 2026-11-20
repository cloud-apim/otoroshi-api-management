// What pins a published version of a shared object — a flow a policy group, a plan a shared
// resource — never follows a newer version by itself: a snapshot is immutable, what runs only changes
// through one. Two aids make a fix travel anyway:
//  - publishing a version tells the teams of the apis behind it, in their notifications;
//  - an upgrade, on demand, moves the apis behind to the latest version — each by its own draft,
//    then, when asked, its own snapshot and its own deployment, every step in the audit trail.
// An api the upgrade cannot touch is reported, not forced: managed by a source (upgraded there), not
// managed by the caller, or with other unpublished changes in its draft (publishing them along would
// ship more than the fix: its draft is upgraded, its publication left to its team).

import { db } from '../db/index.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import { normalizeDraft } from './model.js';

// the teams of the apis behind, one notification each, listing their apis
export async function notifyBehind({ workspaceId, label, name, number, usage, link }) {
  const behind = usage.filter((u) => u.behind);
  if (!behind.length) return 0;
  const teams = await db`select id, team_id from apis where id in ${db(behind.map((u) => u.id))}`;
  const byTeam = new Map();
  for (const u of behind) {
    const team = teams.find((t) => t.id === u.id)?.team_id;
    if (!team) continue;
    byTeam.set(team, [...(byTeam.get(team) || []), u]);
  }
  for (const [teamId, apis] of byTeam)
    await notify({
      workspaceId,
      teamId,
      face: 'console',
      kind: 'pin.behind',
      title: `${label} ${name} v${number} published`,
      body: `${apis.map((a) => `${a.name} ${a.version} (v${a.pinned.join(', v')})`).join(', ')} pin${apis.length > 1 ? '' : 's'} an older version: upgrade from the page of the ${label}`,
      link,
      data: { apis: apis.map((a) => a.id), version: number },
    });
  return byTeam.size;
}

// moves the apis behind to `latest`: `rewrite(draft)` gives the draft pinning it
export async function upgradePins(ctx, { workspaceId, kind, label, name, entityId, latest, usage, rewrite, publish = false, deploy = false, apiIds = null }) {
  const apis = await import('./apis.js');
  const deployments = await import('./deployments.js');
  const results = [];
  for (const u of usage.filter((x) => x.behind && (!apiIds || apiIds.includes(x.id)))) {
    const out = { id: u.id, name: u.name, version: u.version, from: u.pinned, to: latest };
    try {
      const api = await apis.getApi(workspaceId, u.id);
      if (api.managed_by) {
        results.push({ ...out, action: 'skipped', reason: `managed by ${api.managed_by}: upgrade it at its source` });
        continue;
      }
      if (!(await apis.canManageApi(ctx, api))) {
        results.push({ ...out, action: 'skipped', reason: 'you do not manage this api' });
        continue;
      }
      const otherChanges = (await apis.pendingChanges(api)).hasChanges;
      await apis.updateApi(ctx, api, { draft: rewrite(normalizeDraft(api.draft)) });
      out.action = 'upgraded';
      if (publish && otherChanges) out.reason = 'its draft has other unpublished changes: upgraded in the draft, to publish from the api';
      else if (publish) {
        const pub = await apis.publish(ctx, await apis.getApi(workspaceId, api.id), { comment: `${label} ${name} v${latest}` });
        out.action = 'published';
        out.snapshot = pub.snapshot.number;
        // deployed where it runs: an api that is not deployed stays so
        if (deploy && (await deployments.currentDeployment(api.id))) {
          const dep = await deployments.deploy(ctx, await apis.getApi(workspaceId, api.id), { snapshot: pub.snapshot.id });
          out.action = 'deployed';
          out.deployment = dep.deployment.status;
        }
      }
    } catch (e) {
      out.action = 'error';
      out.reason = e.details?.errors?.map((x) => x.message).join(', ') || e.message;
    }
    results.push(out);
  }
  const done = results.filter((r) => ['upgraded', 'published', 'deployed'].includes(r.action)).length;
  await audit(ctx, {
    action: `${kind}.upgrade`,
    workspaceId,
    entityKind: kind,
    entityId,
    summary: `${label} ${name}: ${done} api(s) upgraded to v${latest}${publish ? (deploy ? ', published and deployed' : ', published') : ''}`,
    data: { results: results.map(({ id, action, reason }) => ({ id, action, reason })) },
  });
  return { latest, results };
}
