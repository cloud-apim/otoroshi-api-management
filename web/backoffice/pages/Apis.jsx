import React, { useState } from 'react';
import { Link, useQuery, useRouter } from '../../shared/router.jsx';
import { fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, Empty, Field, Icon, Input, Loader, Modal, Select, StatusBadge, TagsInput, errorMessage, useLoad, useToast } from '../../shared/ui.jsx';
import { useWs, api } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { ApisTabs } from './PolicyGroups.jsx';

export function deploymentLabel(a) {
  const d = a.deployment;
  if (!a.last_snapshot) return <StatusBadge status="created" label="draft only" />;
  if (!d || d.action === 'undeploy') return <StatusBadge status="none" label="not deployed" />;
  if (d.status === 'pending') return <StatusBadge status="pending" label="deploying" />;
  if (d.status === 'failed') return <StatusBadge status="failed" label="deploy failed" />;
  return <StatusBadge status="deployed" label="deployed" />;
}

function CreateApiModal({ onClose, onCreated }) {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const teams = useLoad(() => wapi.get('/teams'), [slug]);
  const [form, setForm] = useState({ name: '', version: '1.0.0', description: '', team_id: '', domain: '', contextPath: '/', tags: [] });
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const suggestedDomain = `${(form.name || 'my-api').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.oto.tools`;
  const submit = async () => {
    try {
      const created = await wapi.post('/apis', { ...form, domain: form.domain || suggestedDomain, team_id: form.team_id || teams.data?.[0]?.id });
      toast('API created — it is a draft until you publish it');
      onCreated(created);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Modal
      title="New API"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!form.name}>
            Create draft
          </button>
        </>
      }
    >
      <p className="muted small">
        An API is a version. The product creates it end to end — routes, frontends and backends — and nothing reaches the gateway before you publish and deploy.
      </p>
      <div className="grid-2">
        <Field label="Name">
          <Input value={form.name} onChange={set('name')} autoFocus placeholder="Payments" />
        </Field>
        <Field label="Version">
          <Input value={form.version} onChange={set('version')} />
        </Field>
      </div>
      <Field label="Description">
        <Input value={form.description} onChange={set('description')} />
      </Field>
      <Field label="Owning team">
        <Select value={form.team_id || teams.data?.[0]?.id || ''} onChange={set('team_id')} options={(teams.data || []).map((t) => ({ value: t.id, label: t.name }))} />
      </Field>
      <div className="grid-2">
        <Field label="Domain" hint="where the gateway exposes the api">
          <Input value={form.domain} onChange={set('domain')} placeholder={suggestedDomain} />
        </Field>
        <Field label="Context path">
          <Input value={form.contextPath} onChange={set('contextPath')} />
        </Field>
      </div>
      <Field label="Tags" hint="business classification, not a governance axis">
        <TagsInput value={form.tags} onChange={set('tags')} />
      </Field>
    </Modal>
  );
}

function AdoptModal({ onClose, onAdopted }) {
  const { wapi } = useWs();
  const toast = useToast();
  const state = useLoad(() => api.get('/gateway/unmanaged-apis'), []);
  return (
    <Modal title="Adopt an API from the gateway" onClose={onClose} size="wide">
      <Callout kind="info">
        Adopt mode takes over an existing Otoroshi <code>Api</code> without overwriting it: it becomes a draft in the product, and nothing is written to the gateway until you
        publish and deploy. The ids are kept, so the first deployment updates the entity in place.
      </Callout>
      <Loader state={state}>
        {(list) =>
          list.length ? (
            <div className="card flat table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Otoroshi API</th>
                    <th>Entrypoint</th>
                    <th>Plans</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="bold">{a.name}</div>
                        <div className="faint tiny mono">{a.id}</div>
                      </td>
                      <td className="mono small">
                        {a.domain}
                        {a.contextPath}
                      </td>
                      <td className="small">{a.plans.map((p) => `${p.name} (${p.kind})`).join(', ') || '—'}</td>
                      <td className="actions">
                        <button
                          className="btn sm"
                          onClick={async () => {
                            try {
                              const created = await wapi.post('/adopt', { otoroshi_api_id: a.id });
                              toast('API adopted as a draft');
                              onAdopted(created);
                            } catch (e) {
                              toast(errorMessage(e), 'error');
                            }
                          }}
                        >
                          Adopt
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No unmanaged API on the gateway" />
          )
        }
      </Loader>
    </Modal>
  );
}

export function ApisPage() {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const [params, setParams] = useQuery();
  const q = params.get('q') || '';
  const state = useLoad(() => wapi.get(`/apis${q ? `?q=${encodeURIComponent(q)}` : ''}`), [slug, q]);
  const [creating, setCreating] = useState(false);
  const [adopting, setAdopting] = useState(false);
  return (
    <div className="page">
      <PageHead
        title="APIs"
        sub="Describe, publish and deploy APIs. Policy lives in the plans; routes are a projection detail."
        actions={
          <>
            <button className="btn" onClick={() => setAdopting(true)}>
              <Icon name="download" /> Adopt from gateway
            </button>
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> New API
            </button>
          </>
        }
      />
      <ApisTabs current="apis" />
      <div className="row mb-16">
        <input className="input" style={{ maxWidth: 360 }} placeholder="Filter by name, description or tag" value={q} onChange={(e) => setParams({ q: e.target.value })} aria-label="filter apis" />
      </div>
      <Loader state={state}>
        {(apis) =>
          apis.length ? (
            <div className="card table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>API</th>
                    <th>Entrypoint</th>
                    <th>Lifecycle</th>
                    <th>Gateway</th>
                    <th className="right">Plans</th>
                    <th className="right">Subscriptions</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {apis.map((a) => (
                    <tr key={a.id} className="clickable" onClick={() => navigate(`/ws/${slug}/apis/${a.id}`)}>
                      <td>
                        <Link to={`/ws/${slug}/apis/${a.id}`} className="bold" onClick={(e) => e.stopPropagation()}>
                          {a.name}
                        </Link>{' '}
                        <span className="faint">{a.version}</span>
                        <div className="row gap-4 mt-8 wrap">
                          {(a.tags || []).map((t) => (
                            <span key={t} className="tag">
                              {t}
                            </span>
                          ))}
                          {a.managed_by && <Badge kind="info">managed by {a.managed_by}</Badge>}
                        </div>
                      </td>
                      <td className="mono small muted">
                        {a.entrypoint?.domain}
                        {a.entrypoint?.contextPath === '/' ? '' : a.entrypoint?.contextPath}
                      </td>
                      <td>
                        <StatusBadge status={a.lifecycle} />
                      </td>
                      <td>
                        {deploymentLabel(a)}
                        {a.last_snapshot ? <div className="faint tiny mt-8">snapshot #{a.last_snapshot}</div> : null}
                      </td>
                      <td className="right">{a.plans_count}</td>
                      <td className="right">
                        {a.active_subscriptions}
                        {a.pending_subscriptions > 0 && (
                          <span className="badge warning" style={{ marginLeft: 6 }}>
                            {a.pending_subscriptions} pending
                          </span>
                        )}
                      </td>
                      <td className="muted small">{fmtRelative(a.draft_updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card">
              <Empty
                title={q ? 'No matching API' : 'No API yet'}
                icon="api"
                action={
                  <button className="btn primary" onClick={() => setCreating(true)}>
                    <Icon name="plus" /> New API
                  </button>
                }
              >
                Create an API, or adopt one that already runs on the gateway.
              </Empty>
            </div>
          )
        }
      </Loader>
      {creating && <CreateApiModal onClose={() => setCreating(false)} onCreated={(a) => navigate(`/ws/${slug}/apis/${a.id}`)} />}
      {adopting && <AdoptModal onClose={() => setAdopting(false)} onAdopted={(a) => navigate(`/ws/${slug}/apis/${a.id}`)} />}
    </div>
  );
}
