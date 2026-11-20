import React, { useEffect, useState } from 'react';
import { useRouter } from '../../../shared/router.jsx';
import { Badge, Callout, DiffView, Dropdown, Field, Icon, Input, Loader, MenuItem, Modal, StatusBadge, Switch, Tabs, errorMessage, useLoad, useToast } from '../../../shared/ui.jsx';
import { useWs } from '../../context.jsx';
import { PageHead } from '../../layout.jsx';
import { OverviewTab, ResourcesTab, BackendsTab, FlowsTab, SettingsTab } from './tabs.jsx';
import { PlansTab } from './Plans.jsx';
import { DocsTab, OpenApiTab } from './Docs.jsx';
import { DeploymentTab } from './Deployment.jsx';
import { SubscriptionsTable } from '../Subscriptions.jsx';
import { AnalyticsDashboard } from '../Observability.jsx';
import { RequestComposer } from '../../../shared/composer.jsx';
import { CodeView } from '../../../shared/code-editor.jsx';
import { tr, Tr } from '../../../shared/i18n.jsx';

// console context: replay a request through this api on the gateway
function TestTab({ api, draft }) {
  const { wapi } = useWs();
  const subs = useLoad(() => wapi.get(`/subscriptions?api=${api.id}&status=active`), [api.id]);
  if (!api.deployment.deployed) return <Callout kind="info">{tr('Deploy the api first: the console replays requests through the gateway.')}</Callout>;
  return (
    <div className="col gap-16">
      <p className="muted small">
        {tr("The request goes through the real gateway: routing, plans, quotas and keys apply. Pick the credentials of one of your applications' subscriptions, or send it without any.")}
      </p>
      <Loader state={subs}>
        {(list) => (
          <RequestComposer
            baseLabel={api.base_url}
            paths={draft.resources.map((r) => r.path)}
            credentials={list.map((s) => ({ value: s.id, label: `${s.application_name} — ${s.request?.plan_name || s.plan_id}` }))}
            send={async (r) => wapi.post(`/apis/${api.id}/test`, { method: r.method, path: r.path, query: r.query, headers: r.headers, body: r.body, subscription_id: r.credential || undefined })}
          />
        )}
      </Loader>
    </div>
  );
}

const IDENTITY = ['name', 'description', 'tags', 'visibility', 'acl', 'team_id', 'metadata'];

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

export function ApiPage({ id, tab }) {
  const { wapi, slug } = useWs();
  const state = useLoad(() => wapi.get(`/apis/${id}`), [slug, id]);
  return (
    <div className="page">
      <Loader state={state}>{(api) => <ApiEditor key={api.id + api.draft_updated_at} api={api} tab={tab} reload={state.reload} />}</Loader>
    </div>
  );
}

function ApiEditor({ api, tab, reload }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const [draft, setDraftState] = useState(api.draft);
  const [identity, setIdentity] = useState(pick(api, IDENTITY));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validation, setValidation] = useState(api.validation);
  const [order, setOrder] = useState(api.resolution_order);
  const [publishing, setPublishing] = useState(false);
  const [deploying, setDeploying] = useState(null);
  // an api owned by a remote catalog changes at its source; publishing and deploying stay
  // operable, they are explicit acts when the catalog only writes drafts
  const readOnly = !api.can_manage || !!api.managed_by;
  const operable = api.can_manage;

  const setDraft = (updater) => {
    setDraftState((d) => (typeof updater === 'function' ? updater(d) : updater));
    setDirty(true);
  };
  const setIdent = (patch) => {
    setIdentity((i) => ({ ...i, ...patch }));
    setDirty(true);
  };

  // live validation of the local draft, so warnings are never discovered at publication
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      wapi.post(`/apis/${api.id}/validate`, { draft }).then(setValidation).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [draft, dirty]);

  useEffect(() => {
    const on = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, [dirty]);

  const save = async () => {
    setSaving(true);
    try {
      await wapi.put(`/apis/${api.id}`, identity);
      const res = await wapi.put(`/apis/${api.id}/draft`, { draft });
      setValidation(res.validation);
      setOrder(res.resolution_order);
      setDirty(false);
      toast(tr('Draft saved — nothing reached the gateway'));
      reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const go = (t) => {
    navigate(`/ws/${slug}/apis/${api.id}${t === 'overview' ? '' : `/${t}`}`);
  };

  const dep = api.deployment;
  const tabs = [
    { id: 'overview', label: tr('Overview') },
    { id: 'resources', label: tr('Resources'), count: draft.resources.length },
    { id: 'backends', label: tr('Backends'), count: draft.backends.length },
    { id: 'flows', label: tr('Policies & flows'), count: draft.flows.length },
    { id: 'plans', label: tr('Plans'), count: draft.plans.length },
    { id: 'documentation', label: tr('Documentation') },
    { id: 'openapi', label: tr('OpenAPI') },
    { id: 'subscriptions', label: tr('Subscriptions') },
    { id: 'deployment', label: tr('Deployment') },
    { id: 'test', label: tr('Test') },
    { id: 'analytics', label: tr('Analytics') },
    { id: 'settings', label: tr('Settings') },
  ];
  const ctx = { api, draft, setDraft, identity, setIdent, readOnly, validation, order, reload, dirty };

  return (
    <>
      <PageHead
        crumbs={[{ label: tr('APIs'), to: `/ws/${slug}/apis` }, { label: `${api.name} ${api.version}` }]}
        title={
          <span className="row">
            {identity.name}
            {api.versions?.length > 1 ? (
              <Dropdown
                trigger={({ toggle }) => (
                  <button className="btn sm" onClick={toggle}>
                    {api.version} <Icon name="chevronDown" />
                  </button>
                )}
              >
                {api.versions.map((v) => (
                  <MenuItem key={v.id} icon={v.id === api.id ? 'check' : 'git'} onClick={() => navigate(`/ws/${slug}/apis/${v.id}`)}>
                    {v.version} <span className="faint small">{v.lifecycle}</span>
                  </MenuItem>
                ))}
              </Dropdown>
            ) : (
              <span className="badge">{api.version}</span>
            )}
            <StatusBadge status={api.lifecycle} />
            {api.managed_by && <Badge kind="info"><Tr text={'managed by {0}'} args={[api.managed_by]} /></Badge>}
          </span>
        }
        sub={identity.description}
        actions={
          operable && (
            <>
              <button className="btn" disabled={dirty || !dep.latest_snapshot} onClick={() => setDeploying({ snapshot: dep.latest_snapshot?.id })} title={dirty ? tr('save the draft first') : ''}>
                <Icon name="rocket" /> {tr('Deploy')}
              </button>
              <button className="btn primary" disabled={dirty || !api.pending_changes.hasChanges} onClick={() => setPublishing(true)} title={dirty ? tr('save the draft first') : ''}>
                <Icon name="upload" /> {tr('Publish')}
              </button>
            </>
          )
        }
      />
      <DeploymentBanner api={api} onDeploy={() => setDeploying({ snapshot: dep.latest_snapshot?.id })} onPublish={() => setPublishing(true)} readOnly={!operable} dirty={dirty} />
      {api.managed_by ? (
        <Callout kind="info" title={tr('Managed by {0}', [api.managed_by.startsWith('catalog:') ? tr('a remote catalog') : api.managed_by])}>
          {tr('Its source of truth is elsewhere: change it there, the next sync brings the change here. Deployment and subscriptions stay operable from the console.')}
        </Callout>
      ) : (
        readOnly && <Callout kind="info">{tr('You can read this API but not change it: you are not a producer of its team.')}</Callout>
      )}
      <div className="mb-16">
        <Tabs tabs={tabs} value={tab} onChange={go} />
      </div>
      {tab === 'overview' && <OverviewTab {...ctx} />}
      {tab === 'resources' && <ResourcesTab {...ctx} />}
      {tab === 'backends' && <BackendsTab {...ctx} />}
      {tab === 'flows' && <FlowsTab {...ctx} />}
      {tab === 'plans' && <PlansTab {...ctx} />}
      {tab === 'documentation' && <DocsTab {...ctx} />}
      {tab === 'openapi' && <OpenApiTab {...ctx} />}
      {tab === 'subscriptions' && <SubscriptionsTable query={`api=${api.id}`} showApi={false} onChanged={reload} />}
      {tab === 'deployment' && <DeploymentTab {...ctx} readOnly={!operable} onDeploy={(snapshot) => setDeploying({ snapshot })} />}
      {tab === 'test' && <TestTab api={api} draft={draft} />}
      {tab === 'analytics' && <AnalyticsDashboard fixed={{ api: api.id }} />}
      {tab === 'settings' && <SettingsTab {...ctx} />}

      {dirty && !readOnly && (
        <div className="savebar" role="region" aria-label={tr('unsaved changes')}>
          <Icon name="edit" />
          <span className="grow">
            <Tr text={'Unsaved changes to the draft.{0}'} args={[validation?.errors?.length ? <span style={{ color: '#ff9aae' }}> <Tr text={'{0} error(s) will block publication.'} args={[validation.errors.length]} /></span> : null]} />
          </span>
          <button
            className="btn sm"
            onClick={() => {
              setDraftState(api.draft);
              setIdentity(pick(api, IDENTITY));
              setDirty(false);
              setValidation(api.validation);
            }}
          >
            {tr('Discard')}
          </button>
          <button className="btn primary sm" disabled={saving} onClick={save}>
            {saving ? tr('Saving…') : tr('Save draft')}
          </button>
        </div>
      )}
      {publishing && (
        <PublishModal
          api={api}
          onClose={() => setPublishing(false)}
          onDone={(res) => {
            setPublishing(false);
            reload();
          }}
        />
      )}
      {deploying && (
        <DeployModal
          api={api}
          snapshot={deploying.snapshot}
          onClose={() => setDeploying(null)}
          onDone={() => {
            setDeploying(null);
            reload();
          }}
        />
      )}
    </>
  );
}

// the described state is not the deployed state, and the gap is always shown
function DeploymentBanner({ api, onDeploy, onPublish, readOnly, dirty }) {
  const dep = api.deployment;
  const pc = api.pending_changes;
  if (!dep.latest_snapshot) {
    return (
      <div className="api-banner out">
        <Icon name="edit" />
        <div className="grow">
          <div className="bold">{tr('Draft only')}</div>
          <div className="small">{tr('Nothing of this API exists on the gateway. Publish a snapshot, then deploy it.')}</div>
        </div>
        {!readOnly && (
          <button className="btn sm primary" onClick={onPublish} disabled={dirty}>
            {tr('Publish first snapshot')}
          </button>
        )}
      </div>
    );
  }
  const runs = dep.current ? tr('snapshot #{0} runs on the gateway', [dep.current.snapshot_number]) : tr('not deployed on the gateway');
  return (
    <div className={`api-banner ${dep.out_of_sync ? 'out' : ''}`}>
      <span className={`gw-dot ${dep.current ? 'ok' : ''}`} />
      <div className="grow small">
        <span className="bold">{runs}</span>
        {dep.out_of_sync && <span> <Tr text={'· latest snapshot #{0} is not deployed'} args={[dep.latest_snapshot.number]} /></span>}
        {pc.hasChanges && <span> <Tr text={'· the draft has {0} unpublished change{1}'} args={[pc.count ?? '', pc.count === 1 ? '' : tr('s')]} /></span>}
        {dep.last?.status === 'failed' && <span className="negative-text"> <Tr text={'· last deployment failed: {0}'} args={[dep.last.error]} /></span>}
        {dep.last?.status === 'pending' && <span> {tr('· deployment pending (the gateway will receive it when reachable)')}</span>}
      </div>
      {!readOnly && dep.out_of_sync && (
        <button className="btn sm" onClick={onDeploy} disabled={dirty}>
          <Icon name="rocket" /> <Tr text={'Deploy #{0}'} args={[dep.latest_snapshot.number]} />
        </button>
      )}
    </div>
  );
}

function PublishModal({ api, onClose, onDone }) {
  const { wapi } = useWs();
  const toast = useToast();
  const changes = useLoad(() => wapi.get(`/apis/${api.id}/changes`), [api.id]);
  const [comment, setComment] = useState('');
  const [deploy, setDeploy] = useState(true);
  const [busy, setBusy] = useState(false);
  const v = api.validation;
  const submit = async () => {
    setBusy(true);
    try {
      const res = await wapi.post(`/apis/${api.id}/publish`, { comment, deploy });
      const depStatus = res.deployment?.deployment?.status;
      toast(
        tr('Snapshot #{0} published{1}', [res.snapshot.number, deploy ? (depStatus === 'deployed' ? tr(' and deployed') : tr(' — deployment {0}', [depStatus || tr('queued')])) : '']),
        depStatus === 'failed' ? 'error' : 'info'
      );
      onDone(res);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tr('Publish a snapshot')}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || v.errors.length > 0} onClick={submit}>
            {deploy ? tr('Publish and deploy') : tr('Publish')}
          </button>
        </>
      }
    >
      <p className="muted small">{tr('Publishing freezes an immutable, dated copy of the API — plans, resources and documentation. That snapshot is what gets projected; rollback is redeploying an earlier one.')}</p>
      {v.errors.map((e, i) => (
        <Callout key={i} kind="negative">
          {e.message}
        </Callout>
      ))}
      {v.warnings.map((w, i) => (
        <Callout key={i} kind="warning">
          {w.message}
        </Callout>
      ))}
      <div className="label">{tr('Changes since the last snapshot')}</div>
      <Loader state={changes}>{(c) => (c.changes ? <DiffView changes={c.changes} /> : <p className="small muted">{tr('First snapshot of this API.')}</p>)}</Loader>
      <Field label={tr('Comment')}>
        <Input value={comment} onChange={setComment} placeholder={tr('what changes, and why')} />
      </Field>
      <Switch checked={deploy} onChange={setDeploy} label={tr('Deploy to the gateway right after (shows its diff first on the deployment tab otherwise)')} />
    </Modal>
  );
}

// a deployment shows its diff before acting: dry-run first, always
function DeployModal({ api, snapshot, onClose, onDone }) {
  const { wapi } = useWs();
  const toast = useToast();
  const plan = useLoad(() => wapi.post(`/apis/${api.id}/deploy`, { snapshot, dry_run: true }), [api.id, snapshot]);
  const [busy, setBusy] = useState(false);
  const [showEntity, setShowEntity] = useState(false);
  const [ack, setAck] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const res = await wapi.post(`/apis/${api.id}/deploy`, { snapshot });
      const st = res.deployment?.status;
      if (st === 'deployed') toast(tr('Snapshot #{0} deployed', [res.snapshot.number]));
      else if (st === 'failed') toast(tr('Deployment failed: {0}', [res.deployment.error]), 'error');
      else toast(tr('Deployment queued: {0}', [res.task?.last_error || tr('the gateway will receive it when reachable')]));
      onDone();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tr('Deploy to the gateway')}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || plan.loading || (plan.data?.warnings?.some((w) => w.code === 'open_routes') && !ack)} onClick={submit}>
            <Icon name="rocket" /> <Tr text={'Deploy snapshot #{0}'} args={[plan.data?.snapshot?.number ?? '…']} />
          </button>
        </>
      }
    >
      <Loader state={plan}>
        {(p) => (
          <>
            <p className="small muted">
              <Tr text={"Writes the {0} entity on the installation's Otoroshi cluster, as an api managed as code ({1}): Otoroshi records the deployment in its own history, with the snapshot as its ref."} args={[<code>Api</code>, <code>created_by=external=otoroshi-api-management</code>]} />
            </p>
            {p.gatewayError && <Callout kind="negative" title={tr('Gateway unreachable')}><Tr text={'{0} — the deployment will wait in the queue and run when the gateway is back.'} args={[p.gatewayError]} /></Callout>}
            {p.warnings.map((w, i) => (
              <Callout key={i} kind="warning">
                {w.message}
              </Callout>
            ))}
            {p.warnings.some((w) => w.code === 'open_routes') && <Switch checked={ack} onChange={setAck} label={tr('I understand: the routes will be open to anyone')} />}
            <div className="grid-2">
              <div className="col">
                <div className="label">
                  <Tr text={'Catalogue changes {0}'} args={[p.running ? tr('(snapshot #{0} → #{1})', [p.running.number, p.snapshot.number]) : tr('(first deployment)')]} />
                </div>
                {p.changes ? <DiffView changes={p.changes} empty={tr('Same snapshot as the one running')} /> : <p className="small muted">{tr('Nothing runs yet.')}</p>}
              </div>
              <div className="col">
                <div className="label"><Tr text={'Gateway changes {0}'} args={[p.gatewayExists ? '' : tr('(entity will be created)')]} /></div>
                <DiffView changes={p.gatewayChanges} empty={tr('The gateway already holds exactly this')} />
              </div>
            </div>
            <button className="btn sm ghost" onClick={() => setShowEntity(!showEntity)} style={{ alignSelf: 'flex-start' }}>
              <Icon name="eye" /> <Tr text={'{0} the Otoroshi entity that will be written'} args={[showEntity ? tr('Hide') : tr('Show')]} />
            </button>
            {showEntity && (
              <CodeView value={p.entity} maxHeight={420} ariaLabel={tr('otoroshi entity')} />
            )}
          </>
        )}
      </Loader>
    </Modal>
  );
}
