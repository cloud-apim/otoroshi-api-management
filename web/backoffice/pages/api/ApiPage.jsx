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

const IDENTITY = ['name', 'description', 'tags', 'visibility', 'acl', 'team_id'];

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
  const readOnly = !api.can_manage;

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
      toast('Draft saved — nothing reached the gateway');
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
    { id: 'overview', label: 'Overview' },
    { id: 'resources', label: 'Resources', count: draft.resources.length },
    { id: 'backends', label: 'Backends', count: draft.backends.length },
    { id: 'flows', label: 'Policies & flows', count: draft.flows.length },
    { id: 'plans', label: 'Plans', count: draft.plans.length },
    { id: 'documentation', label: 'Documentation' },
    { id: 'openapi', label: 'OpenAPI' },
    { id: 'subscriptions', label: 'Subscriptions' },
    { id: 'deployment', label: 'Deployment' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'settings', label: 'Settings' },
  ];
  const ctx = { api, draft, setDraft, identity, setIdent, readOnly, validation, order, reload, dirty };

  return (
    <>
      <PageHead
        crumbs={[{ label: 'APIs', to: `/ws/${slug}/apis` }, { label: `${api.name} ${api.version}` }]}
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
            {api.managed_by && <Badge kind="info">managed by {api.managed_by}</Badge>}
          </span>
        }
        sub={identity.description}
        actions={
          !readOnly && (
            <>
              <button className="btn" disabled={dirty || !dep.latest_snapshot} onClick={() => setDeploying({ snapshot: dep.latest_snapshot?.id })} title={dirty ? 'save the draft first' : ''}>
                <Icon name="rocket" /> Deploy
              </button>
              <button className="btn primary" disabled={dirty || !api.pending_changes.hasChanges} onClick={() => setPublishing(true)} title={dirty ? 'save the draft first' : ''}>
                <Icon name="upload" /> Publish
              </button>
            </>
          )
        }
      />
      <DeploymentBanner api={api} onDeploy={() => setDeploying({ snapshot: dep.latest_snapshot?.id })} onPublish={() => setPublishing(true)} readOnly={readOnly} dirty={dirty} />
      {readOnly && <Callout kind="info">You can read this API but not change it: you are not a producer of its team.</Callout>}
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
      {tab === 'deployment' && <DeploymentTab {...ctx} onDeploy={(snapshot) => setDeploying({ snapshot })} />}
      {tab === 'analytics' && <AnalyticsDashboard fixed={{ api: api.id }} />}
      {tab === 'settings' && <SettingsTab {...ctx} />}

      {dirty && !readOnly && (
        <div className="savebar" role="region" aria-label="unsaved changes">
          <Icon name="edit" />
          <span className="grow">
            Unsaved changes to the draft.
            {validation?.errors?.length ? <span style={{ color: '#ff9aae' }}> {validation.errors.length} error(s) will block publication.</span> : null}
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
            Discard
          </button>
          <button className="btn primary sm" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save draft'}
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

// the described state is not the deployed state, and the gap is always shown (D-22 rule 1)
function DeploymentBanner({ api, onDeploy, onPublish, readOnly, dirty }) {
  const dep = api.deployment;
  const pc = api.pending_changes;
  if (!dep.latest_snapshot) {
    return (
      <div className="api-banner out">
        <Icon name="edit" />
        <div className="grow">
          <div className="bold">Draft only</div>
          <div className="small">Nothing of this API exists on the gateway. Publish a snapshot, then deploy it.</div>
        </div>
        {!readOnly && (
          <button className="btn sm primary" onClick={onPublish} disabled={dirty}>
            Publish first snapshot
          </button>
        )}
      </div>
    );
  }
  const runs = dep.current ? `snapshot #${dep.current.snapshot_number} runs on the gateway` : 'not deployed on the gateway';
  return (
    <div className={`api-banner ${dep.out_of_sync ? 'out' : ''}`}>
      <span className={`gw-dot ${dep.current ? 'ok' : ''}`} />
      <div className="grow small">
        <span className="bold">{runs}</span>
        {dep.out_of_sync && <span> · latest snapshot #{dep.latest_snapshot.number} is not deployed</span>}
        {pc.hasChanges && <span> · the draft has {pc.count ?? ''} unpublished change{pc.count === 1 ? '' : 's'}</span>}
        {dep.last?.status === 'failed' && <span className="negative-text"> · last deployment failed: {dep.last.error}</span>}
        {dep.last?.status === 'pending' && <span> · deployment pending (the gateway will receive it when reachable)</span>}
      </div>
      {!readOnly && dep.out_of_sync && (
        <button className="btn sm" onClick={onDeploy} disabled={dirty}>
          <Icon name="rocket" /> Deploy #{dep.latest_snapshot.number}
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
        `Snapshot #${res.snapshot.number} published${deploy ? (depStatus === 'deployed' ? ' and deployed' : ` — deployment ${depStatus || 'queued'}`) : ''}`,
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
      title="Publish a snapshot"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || v.errors.length > 0} onClick={submit}>
            {deploy ? 'Publish and deploy' : 'Publish'}
          </button>
        </>
      }
    >
      <p className="muted small">Publishing freezes an immutable, dated copy of the API — plans, resources and documentation. That snapshot is what gets projected; rollback is redeploying an earlier one.</p>
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
      <div className="label">Changes since the last snapshot</div>
      <Loader state={changes}>{(c) => (c.changes ? <DiffView changes={c.changes} /> : <p className="small muted">First snapshot of this API.</p>)}</Loader>
      <Field label="Comment">
        <Input value={comment} onChange={setComment} placeholder="what changes, and why" />
      </Field>
      <Switch checked={deploy} onChange={setDeploy} label="Deploy to the gateway right after (shows its diff first on the deployment tab otherwise)" />
    </Modal>
  );
}

// a deployment shows its diff before acting (D-22 rule 2): dry-run first, always
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
      if (st === 'deployed') toast(`Snapshot #${res.snapshot.number} deployed`);
      else if (st === 'failed') toast(`Deployment failed: ${res.deployment.error}`, 'error');
      else toast(`Deployment queued: ${res.task?.last_error || 'the gateway will receive it when reachable'}`);
      onDone();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Deploy to the gateway"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || plan.loading || (plan.data?.warnings?.some((w) => w.code === 'open_routes') && !ack)} onClick={submit}>
            <Icon name="rocket" /> Deploy snapshot #{plan.data?.snapshot?.number ?? '…'}
          </button>
        </>
      }
    >
      <Loader state={plan}>
        {(p) => (
          <>
            <p className="small muted">
              Writes the <code>Api</code> entity on the installation's Otoroshi cluster, marked as a catalog deployment (<code>created_by=remote_catalog=otoroshi-apim-deployment</code>), so
              Otoroshi records it in its own deployment history.
            </p>
            {p.gatewayError && <Callout kind="negative" title="Gateway unreachable">{p.gatewayError} — the deployment will wait in the queue and run when the gateway is back.</Callout>}
            {p.warnings.map((w, i) => (
              <Callout key={i} kind="warning">
                {w.message}
              </Callout>
            ))}
            {p.warnings.some((w) => w.code === 'open_routes') && <Switch checked={ack} onChange={setAck} label="I understand: the routes will be open to anyone" />}
            <div className="grid-2">
              <div className="col">
                <div className="label">
                  Catalogue changes {p.running ? `(snapshot #${p.running.number} → #${p.snapshot.number})` : '(first deployment)'}
                </div>
                {p.changes ? <DiffView changes={p.changes} empty="Same snapshot as the one running" /> : <p className="small muted">Nothing runs yet.</p>}
              </div>
              <div className="col">
                <div className="label">Gateway changes {p.gatewayExists ? '' : '(entity will be created)'}</div>
                <DiffView changes={p.gatewayChanges} empty="The gateway already holds exactly this" />
              </div>
            </div>
            <button className="btn sm ghost" onClick={() => setShowEntity(!showEntity)} style={{ alignSelf: 'flex-start' }}>
              <Icon name="eye" /> {showEntity ? 'Hide' : 'Show'} the Otoroshi entity that will be written
            </button>
            {showEntity && (
              <pre style={{ maxHeight: 360 }}>
                <code>{JSON.stringify(p.entity, null, 2)}</code>
              </pre>
            )}
          </>
        )}
      </Loader>
    </Modal>
  );
}
