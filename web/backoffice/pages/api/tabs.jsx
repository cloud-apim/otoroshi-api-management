import React, { useState } from 'react';
import { Link, useRouter } from '../../../shared/router.jsx';
import { AUTH_LABELS, fmtDate, fmtNumber, fmtWindow } from '../../../shared/lib.js';
import {
  Badge, Callout, Code, Empty, Field, Icon, Input, Loader, Modal, NumberInput, Seg, Select, Setting, StatusBadge, Switch, TagsInput, TextArea,
  errorMessage, useConfirm, useLoad, useToast,
} from '../../../shared/ui.jsx';
import { api as rootApi, useWs, useMetadataFields } from '../../context.jsx';
import { MetadataForm } from '../../../shared/metadata.jsx';
import { CodeEditor, CodeView } from '../../../shared/code-editor.jsx';
import { PluginForm, formFields } from './PluginForm.jsx';
import { tr, Tr } from '../../../shared/i18n.jsx';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

// ---------------------------------------------------------------- overview

export function OverviewTab({ api, draft, validation, order }) {
  const { slug } = useWs();
  const base = api.base_url;
  const plan = draft.plans.find((p) => p.status === 'published');
  const firstPath = draft.resources[0]?.path === '/' ? '' : draft.resources[0]?.path || '';
  const curlKey = `curl ${base}${firstPath} \\\n  -u "$CLIENT_ID:$CLIENT_SECRET"`;
  const js = `const res = await fetch('${base}${firstPath}', {\n  headers: {\n    'Otoroshi-Client-Id': process.env.CLIENT_ID,\n    'Otoroshi-Client-Secret': process.env.CLIENT_SECRET,\n  },\n});\nconsole.log(await res.json());`;
  const py = `import os, requests\n\nres = requests.get(\n    '${base}${firstPath}',\n    auth=(os.environ['CLIENT_ID'], os.environ['CLIENT_SECRET']),\n)\nprint(res.json())`;
  const [lang, setLang] = useState('curl');
  return (
    <div className="col gap-24">
      {(validation.errors.length > 0 || validation.warnings.length > 0) && (
        <div className="col gap-6">
          {validation.errors.map((e, i) => (
            <Callout key={`e${i}`} kind="negative">
              {e.message}
            </Callout>
          ))}
          {validation.warnings.map((w, i) => (
            <Callout key={`w${i}`} kind="warning">
              {w.message}
            </Callout>
          ))}
        </div>
      )}
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <Icon name="globe" />
            <h3>{tr('How to call it')}</h3>
          </div>
          <div className="card-body col">
            <Field label={tr('Base URL')}>
              <div className="secret" style={{ width: '100%' }}>
                <span className="grow ellipsis">{base}</span>
              </div>
            </Field>
            <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>{tr('Create an application on the developer portal.')}</li>
              <li><Tr text={'Subscribe it to a plan{0}.'} args={[plan ? tr(' (e.g. {0})', [plan.name]) : '']} /></li>
              <li>{tr('Call the API with the credentials of the subscription.')}</li>
            </ol>
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              {['curl', 'javascript', 'python'].map((l) => (
                <button key={l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>
                  {l}
                </button>
              ))}
            </div>
            <Code>{lang === 'curl' ? curlKey : lang === 'javascript' ? js : py}</Code>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <Icon name="layers" />
            <h3 className="grow">{tr('Plans')}</h3>
            <Link className="link small" to={`/ws/${slug}/apis/${api.id}/plans`}>
              {tr('Edit plans')}
            </Link>
          </div>
          {draft.plans.length ? (
            draft.plans.map((p) => (
              <div key={p.id} className="list-item">
                <div className="grow">
                  <div className="bold">{p.name}</div>
                  <div className="muted small">
                    <Tr text={'{0} · {1}{2}{3} · {4} approval'} args={[tr(AUTH_LABELS[p.auth.kind]), p.rateLimit.enabled ? tr('{0} calls / {1}', [fmtNumber(p.rateLimit.calls), fmtWindow(p.rateLimit.windowMs)]) : tr('no rate limit'), p.quota.daily ? tr(' · {0}/day', [fmtNumber(p.quota.daily)]) : '', p.quota.monthly ? tr(' · {0}/month', [fmtNumber(p.quota.monthly)]) : '', tr(p.validation)]} />
                  </div>
                </div>
                <StatusBadge status={p.status} />
              </div>
            ))
          ) : (
            <Empty title={tr('No plan')} icon="layers">
              {tr('Without a published plan the gateway serves the routes to anyone.')}
            </Empty>
          )}
          {order.length > 0 && (
            <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="label mb-8">{tr('Effective resolution order on the gateway')}</div>
              <div className="row wrap gap-6">
                {order.map((o, i) => (
                  <span key={o.id} className="order-chip" title={tr('extractor index {0}', [o.index])}>
                    <span className="bold">{i + 1}</span> {o.name} <span className="faint">{o.kind}</span>
                  </span>
                ))}
              </div>
              <p className="hint mt-8">{tr('It follows the extractor index of each auth kind in Otoroshi, it is not freely chosen — the console shows it rather than hiding it.')}</p>
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <Icon name="api" />
          <h3 className="grow">{tr('Resources')}</h3>
          <span className="muted small">
            {draft.entrypoint.domain}
            {draft.entrypoint.contextPath === '/' ? '' : draft.entrypoint.contextPath}
          </span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {draft.resources.map((r) => (
                <tr key={r.id}>
                  <td className="bold">{r.name}</td>
                  <td className="mono small">
                    {(r.methods.length ? r.methods : ['*']).join(' ')} {r.path}
                    {r.exact ? '' : '*'}
                  </td>
                  <td className="small muted">→ {draft.backends.find((b) => b.id === r.backendId)?.name}</td>
                  <td className="small muted">{draft.flows.find((f) => f.id === r.flowId)?.name || tr('no flow')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {api.previous_version_id && (
        <p className="muted small">
          <Tr text={'This version was created from {0}. Subscriptions do not follow a new version: transfer them.'} args={[<Link className="link" to={`/ws/${slug}/apis/${api.previous_version_id}`}>
            {tr('the previous version')}
          </Link>]} />
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- resources (projected as routes)

function ResourceModal({ value, draft, onSave, onClose }) {
  const [r, setR] = useState(value);
  const set = (k) => (v) => setR((x) => ({ ...x, [k]: v }));
  return (
    <Modal
      title={value.name ? tr('Resource {0}', [value.name]) : tr('New resource')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" onClick={() => onSave(r)}>
            {tr('Apply')}
          </button>
        </>
      }
    >
      <p className="muted small"><Tr text={'A resource is an endpoint or a group of endpoints; it is projected as a route of the Otoroshi {0}, relative to the entrypoint.'} args={[<code>Api</code>]} /></p>
      <div className="grid-2">
        <Field label={tr('Name')}>
          <Input value={r.name} onChange={set('name')} autoFocus />
        </Field>
        <Field label={tr('Path')} hint={r.exact ? tr('exact match') : tr('matches this path and below')}>
          <Input value={r.path} onChange={set('path')} mono />
        </Field>
      </div>
      <Field label={tr('Description')}>
        <Input value={r.description} onChange={set('description')} />
      </Field>
      <Field label={tr('Methods')} hint={tr('none selected = every method')}>
        <div className="row wrap">
          {METHODS.map((m) => (
            <label key={m} className="checkbox small">
              <input type="checkbox" checked={r.methods.includes(m)} onChange={(e) => set('methods')(e.target.checked ? [...r.methods, m] : r.methods.filter((x) => x !== m))} />
              {m}
            </label>
          ))}
        </div>
      </Field>
      <div className="grid-2">
        <Field label={tr('Backend')}>
          <Select value={r.backendId} onChange={set('backendId')} options={draft.backends.map((b) => ({ value: b.id, label: b.name }))} />
        </Field>
        <Field label={tr('Policy flow')} hint={tr('plugins applied on this resource')}>
          <Select value={r.flowId || ''} onChange={(v) => set('flowId')(v || null)} options={[{ value: '', label: tr('none') }, ...draft.flows.map((f) => ({ value: f.id, label: f.name }))]} />
        </Field>
      </div>
      <div className="row gap-24">
        <Switch checked={r.exact} onChange={set('exact')} label={tr('Exact path')} />
        <Switch checked={r.stripPath} onChange={set('stripPath')} label={tr('Strip path')} />
        <Switch checked={r.enabled} onChange={set('enabled')} label={tr('Enabled')} />
      </div>
    </Modal>
  );
}

export function ResourcesTab({ draft, setDraft, readOnly }) {
  const [editing, setEditing] = useState(null);
  const save = (r) => {
    setDraft((d) => ({ ...d, resources: d.resources.some((x) => x.id === r.id) ? d.resources.map((x) => (x.id === r.id ? r : x)) : [...d.resources, r] }));
    setEditing(null);
  };
  return (
    <div className="col gap-16">
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{tr('Entrypoint')}</h3>
        </div>
        <div className="card-body grid-2">
          <Field label={tr('Domain')} hint={tr('the hostname the gateway serves this api on')}>
            <Input value={draft.entrypoint.domain} disabled={readOnly} onChange={(v) => setDraft((d) => ({ ...d, entrypoint: { ...d.entrypoint, domain: v } }))} mono />
          </Field>
          <Field label={tr('Context path')} hint={tr('prefix of every resource')}>
            <Input value={draft.entrypoint.contextPath} disabled={readOnly} onChange={(v) => setDraft((d) => ({ ...d, entrypoint: { ...d.entrypoint, contextPath: v } }))} mono />
          </Field>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{tr('Resources')}</h3>
          {!readOnly && (
            <button className="btn sm" onClick={() => setEditing({ id: rid('res'), name: '', description: '', path: '/', methods: [], exact: false, stripPath: true, backendId: draft.backends[0]?.id, flowId: draft.flows[0]?.id || null, enabled: true })}>
              <Icon name="plus" /> {tr('Add resource')}
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('Name')}</th>
                <th>{tr('Match')}</th>
                <th>{tr('Backend')}</th>
                <th>{tr('Flow')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.resources.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="bold">{r.name}</div>
                    <div className="faint tiny">{r.description}</div>
                  </td>
                  <td className="mono small">
                    {(r.methods.length ? r.methods : ['*']).join(' ')} {r.path}
                    {r.exact ? '' : '*'} {!r.enabled && <Badge>{tr('disabled')}</Badge>}
                  </td>
                  <td className="small">{draft.backends.find((b) => b.id === r.backendId)?.name || <span className="negative-text">{tr('unknown')}</span>}</td>
                  <td className="small">{draft.flows.find((f) => f.id === r.flowId)?.name || '—'}</td>
                  <td className="actions">
                    {!readOnly && (
                      <>
                        <button className="btn ghost sm icon" onClick={() => setEditing(r)} aria-label={tr('edit')}>
                          <Icon name="edit" />
                        </button>
                        <button className="btn ghost sm icon" onClick={() => setDraft((d) => ({ ...d, resources: d.resources.filter((x) => x.id !== r.id) }))} aria-label={tr('delete')}>
                          <Icon name="trash" />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editing && <ResourceModal value={editing} draft={draft} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- backends

function BackendModal({ value, onSave, onClose }) {
  const [b, setB] = useState(value);
  const set = (k) => (v) => setB((x) => ({ ...x, [k]: v }));
  const setTarget = (i, patch) => setB((x) => ({ ...x, targets: x.targets.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  return (
    <Modal
      title={value.name ? tr('Backend {0}', [value.name]) : tr('New backend')}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" onClick={() => onSave(b)}>
            {tr('Apply')}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label={tr('Name')}>
          <Input value={b.name} onChange={set('name')} />
        </Field>
        <Field label={tr('Load balancing')}>
          <Select value={b.loadBalancing} onChange={set('loadBalancing')} options={['RoundRobin', 'Random', 'Sticky', 'IpAddressHash', 'BestResponseTime', 'WeightedBestResponseTime', 'LeastConnections']} />
        </Field>
      </div>
      <div className="label">{tr('Targets')}</div>
      {b.targets.map((t, i) => (
        <div key={i} className="row">
          <Input value={t.hostname} onChange={(v) => setTarget(i, { hostname: v })} placeholder={tr('hostname')} mono />
          <NumberInput value={t.port} onChange={(v) => setTarget(i, { port: v })} style={{ width: 110 }} />
          <Switch checked={t.tls} onChange={(v) => setTarget(i, { tls: v })} label={tr('TLS')} />
          <NumberInput value={t.weight} onChange={(v) => setTarget(i, { weight: v })} style={{ width: 80 }} title={tr('weight')} />
          <button className="btn ghost sm icon" onClick={() => setB((x) => ({ ...x, targets: x.targets.filter((_, j) => j !== i) }))} aria-label={tr('remove target')}>
            <Icon name="trash" />
          </button>
        </div>
      ))}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setB((x) => ({ ...x, targets: [...x.targets, { hostname: '', port: 443, tls: true, weight: 1 }] }))}>
        <Icon name="plus" /> {tr('Add target')}
      </button>
      <div className="grid-2">
        <Field label={tr('Root path')} hint={tr('prefix added on the backend side')}>
          <Input value={b.root} onChange={set('root')} mono />
        </Field>
        <Field label={tr('Retries')}>
          <NumberInput value={b.retries} onChange={set('retries')} />
        </Field>
      </div>
      <div className="grid-3">
        <Field label={tr('Call timeout (ms)')}>
          <NumberInput value={b.timeouts.callMs} onChange={(v) => setB((x) => ({ ...x, timeouts: { ...x.timeouts, callMs: v } }))} />
        </Field>
        <Field label={tr('Connection timeout (ms)')}>
          <NumberInput value={b.timeouts.connectionMs} onChange={(v) => setB((x) => ({ ...x, timeouts: { ...x.timeouts, connectionMs: v } }))} />
        </Field>
        <Field label={tr('Idle timeout (ms)')}>
          <NumberInput value={b.timeouts.idleMs} onChange={(v) => setB((x) => ({ ...x, timeouts: { ...x.timeouts, idleMs: v } }))} />
        </Field>
      </div>
      <Switch checked={b.rewrite} onChange={set('rewrite')} label={tr('Rewrite the path (use named path params in the root)')} />
    </Modal>
  );
}

export function BackendsTab({ draft, setDraft, readOnly }) {
  const [editing, setEditing] = useState(null);
  const save = (b) => {
    setDraft((d) => ({ ...d, backends: d.backends.some((x) => x.id === b.id) ? d.backends.map((x) => (x.id === b.id ? b : x)) : [...d.backends, b] }));
    setEditing(null);
  };
  return (
    <div className="col gap-16">
      <p className="muted small">{tr('Backends are infrastructure: targets, TLS, timeouts, load balancing. They belong to the route side, never to the offer.')}</p>
      <div className="grid-2">
        {draft.backends.map((b) => (
          <div key={b.id} className="card">
            <div className="card-head">
              <Icon name="box" />
              <h3 className="grow">{b.name}</h3>
              {!readOnly && (
                <>
                  <button className="btn ghost sm icon" onClick={() => setEditing(b)} aria-label={tr('edit')}>
                    <Icon name="edit" />
                  </button>
                  <button
                    className="btn ghost sm icon"
                    disabled={draft.resources.some((r) => r.backendId === b.id)}
                    title={draft.resources.some((r) => r.backendId === b.id) ? tr('used by a resource') : tr('delete')}
                    onClick={() => setDraft((d) => ({ ...d, backends: d.backends.filter((x) => x.id !== b.id) }))}
                  >
                    <Icon name="trash" />
                  </button>
                </>
              )}
            </div>
            <div className="card-body col gap-6">
              {b.targets.map((t, i) => (
                <div key={i} className="mono small">
                  {t.tls ? tr('https') : tr('http')}://{t.hostname}:{t.port}
                  {b.root !== '/' ? b.root : ''} <span className="faint"><Tr text={'w{0}'} args={[t.weight]} /></span>
                </div>
              ))}
              <div className="faint tiny">
                <Tr text={'{0} · timeout {1} ms · {2} retries · used by {3} resource(s)'} args={[b.loadBalancing, b.timeouts.callMs, b.retries, draft.resources.filter((r) => r.backendId === b.id).length]} />
              </div>
            </div>
          </div>
        ))}
      </div>
      {!readOnly && (
        <button
          className="btn"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setEditing({ id: rid('backend'), name: 'backend', targets: [{ hostname: '', port: 443, tls: true, weight: 1 }], root: '/', rewrite: false, loadBalancing: 'RoundRobin', timeouts: { callMs: 30000, connectionMs: 10000, idleMs: 60000 }, retries: 1 })}
        >
          <Icon name="plus" /> {tr('Add backend')}
        </button>
      )}
      {editing && <BackendModal value={editing} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- flows: named compositions of otoroshi plugins

// The plugins are the gateway's own: they are named, described and configured from its catalog
// (GET /gateway/plugins), and the configuration stays the plugin's native one.

export const pluginOf = (catalog, id) => (catalog || []).find((c) => c.id === id);
const shortPluginId = (id) => String(id || '').replace(/^cp:otoroshi\.next\.plugins\./, '');
const isEmptyValue = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

function configSummary(config) {
  const parts = Object.entries(config || {})
    .filter(([, v]) => !isEmptyValue(v))
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const s = parts.join(' · ');
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

export function moveItem(list, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function MoveButtons({ index, count, onMove }) {
  return (
    <>
      <button className="btn ghost sm icon" disabled={index === 0} onClick={() => onMove(-1)} aria-label={tr('move up')} title={tr('run earlier')}>
        <Icon name="up" />
      </button>
      <button className="btn ghost sm icon" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={tr('move down')} title={tr('run later')}>
        <Icon name="down" />
      </button>
    </>
  );
}

// one plugin of a flow or of a policy group: its name from the gateway catalog, where it applies,
// what is configured
export function PluginRow({ index, count, plugin: p, catalog, readOnly, onEdit, onRemove, onMove }) {
  const meta = pluginOf(catalog, p.plugin);
  const summary = configSummary(p.config);
  const where = p.include?.length ? `only ${p.include.join(', ')}` : 'all paths';
  return (
    <div className="list-item">
      <span className="faint tiny">{index + 1}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row gap-6" style={{ minWidth: 0 }}>
          <span className="bold small nowrap">{meta?.name || shortPluginId(p.plugin)}</span>
          <span className="mono faint tiny ellipsis">{p.plugin}</span>
        </div>
        <div className="faint tiny ellipsis">
          {where}
          {p.exclude?.length ? tr(' · except {0}', [p.exclude.join(', ')]) : ''} · {summary || tr('default configuration')}
        </div>
      </div>
      {!p.enabled && <Badge>{tr('disabled')}</Badge>}
      {!readOnly && (
        <>
          <MoveButtons index={index} count={count} onMove={onMove} />
          <button className="btn ghost sm icon" onClick={onEdit} aria-label={tr('edit')}>
            <Icon name="edit" />
          </button>
          <button className="btn ghost sm icon" onClick={onRemove} aria-label={tr('remove')}>
            <Icon name="trash" />
          </button>
        </>
      )}
    </div>
  );
}

function PluginCard({ meta, id }) {
  if (!meta)
    return id ? (
      <Callout kind="warning" title={tr("Not in the gateway's catalog")}>
        <Tr text={'{0} — a custom plugin, or a gateway that does not run it. It is projected as is.'} args={[<span className="mono small">{id}</span>]} />
      </Callout>
    ) : null;
  return (
    <div className="panel col gap-6">
      <div className="row gap-6 wrap">
        <span className="bold">{meta.name}</span>
        {(meta.categories || []).map((c) => (
          <Badge key={c} kind="accent">
            {c}
          </Badge>
        ))}
        {(meta.steps || []).map((s) => (
          <Badge key={s}>{s}</Badge>
        ))}
      </div>
      {meta.description && <div className="small muted">{meta.description}</div>}
      <div className="mono faint tiny">{meta.id}</div>
    </div>
  );
}

export function PluginModal({ value, catalog, onSave, onClose }) {
  const isNew = !value.plugin;
  const [p, setP] = useState(value);
  const [config, setConfig] = useState(JSON.stringify(value.config || {}, null, 2));
  const [picking, setPicking] = useState(isNew);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  // the form and the json edit the same configuration; the form is rebuilt when the
  // configuration changes from outside it (another plugin, a reset, the json view)
  const [view, setView] = useState('form');
  const [formKey, setFormKey] = useState(0);
  const replaceConfig = (text) => {
    setConfig(text);
    setFormKey((k) => k + 1);
  };
  const meta = pluginOf(catalog, p.plugin);
  const form = useLoad(() => (meta ? rootApi.get(`/gateway/plugins/${encodeURIComponent(meta.id)}`).catch(() => null) : Promise.resolve(null)), [meta?.id]);
  const schema = form.data?.id === meta?.id ? form.data?.configSchema : null;
  const hasForm = !!schema && formFields(schema).length > 0;
  const shown = hasForm ? view : 'json';
  let parsed = null;
  let jsonError = null;
  try {
    parsed = JSON.parse(config || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) jsonError = 'the configuration is a json object';
  } catch (e) {
    jsonError = `invalid json — ${e.message}`;
  }
  const categories = [...new Set((catalog || []).flatMap((c) => c.categories || []))].sort();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (catalog || []).filter(
    (c) => (!category || (c.categories || []).includes(category)) && words.every((w) => `${c.name} ${c.id} ${c.description || ''}`.toLowerCase().includes(w)),
  );
  // choosing a plugin brings its default configuration, unless the current one was edited
  const pick = (c) => {
    const previous = JSON.stringify(pluginOf(catalog, p.plugin)?.defaultConfig || {});
    const untouched = !jsonError && (!Object.keys(parsed).length || JSON.stringify(parsed) === previous);
    setP({ ...p, plugin: c.id });
    if (untouched) replaceConfig(JSON.stringify(c.defaultConfig || {}, null, 2));
  };
  const outside = hasForm && !jsonError ? Object.keys(parsed).filter((k) => !(k in schema)) : [];
  return (
    <Modal
      title={isNew ? tr('Add a plugin') : tr('Edit plugin — {0}', [meta?.name || shortPluginId(p.plugin)])}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" disabled={!p.plugin || !!jsonError} onClick={() => onSave({ ...p, config: parsed })}>
            {isNew ? tr('Add to the flow') : tr('Apply')}
          </button>
        </>
      }
    >
      <p className="muted small">{tr("The plugins are Otoroshi's own — no product-specific plugin. The configuration is the plugin's native one, and it reaches the gateway as is.")}</p>
      {catalog?.length > 0 && picking && (
        <div className="panel col gap-6">
          <div className="row">
            <div className="grow">
              <Input value={q} onChange={setQ} placeholder={tr("search the gateway's {0} plugins", [catalog.length])} aria-label={tr('search plugins')} autoFocus />
            </div>
            <div style={{ width: 220 }}>
              <Select value={category} onChange={setCategory} options={[{ value: '', label: tr('all categories') }, ...categories]} aria-label={tr('category')} />
            </div>
          </div>
          <div style={{ maxHeight: 220, overflow: 'auto' }}>
            {matches.slice(0, 80).map((c) => (
              <div key={c.id} className={`palette-item ${p.plugin === c.id ? 'on' : ''}`} onClick={() => pick(c)}>
                <span className="bold small nowrap">{c.name}</span>
                <span className="faint tiny ellipsis grow">{c.description}</span>
                <span className="faint tiny nowrap">{(c.categories || [])[0]}</span>
              </div>
            ))}
            {!matches.length && <div className="muted small" style={{ padding: 12 }}>{tr('No plugin matches.')}</div>}
          </div>
        </div>
      )}
      <PluginCard meta={meta} id={p.plugin} />
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="grow">
          <Field label={tr('Plugin id')}>
            <Input value={p.plugin} onChange={(v) => setP({ ...p, plugin: v })} mono placeholder={tr('cp:otoroshi.next.plugins.…')} />
          </Field>
        </div>
        {catalog?.length > 0 && !picking && (
          <button className="btn" onClick={() => setPicking(true)}>
            <Icon name="search" /> {tr('Change plugin')}
          </button>
        )}
      </div>
      <div className="row">
        <label className="bold small grow">{tr('Configuration')}</label>
        {meta && (
          <button className="btn ghost xs" onClick={() => replaceConfig(JSON.stringify(meta.defaultConfig || {}, null, 2))} disabled={!jsonError && JSON.stringify(parsed) === JSON.stringify(meta.defaultConfig || {})}>
            {tr('Reset to the default configuration')}
          </button>
        )}
        {hasForm && (
          <Seg
            value={shown}
            onChange={(v) => {
              if (v === 'form' && jsonError) return;
              setView(v);
              setFormKey((k) => k + 1);
            }}
            options={[
              { value: 'form', label: tr('Form') },
              { value: 'json', label: tr('JSON') },
            ]}
          />
        )}
      </div>
      {shown === 'form' ? (
        <div className="col gap-6">
          <div className="panel">
            <PluginForm key={formKey} schema={schema} flow={form.data.configFlow} value={parsed} onChange={(obj) => setConfig(JSON.stringify(obj, null, 2))} />
          </div>
          <div className="hint">
            <Tr text={'The form is generated from the description the gateway gives of this plugin; the JSON stays the reference.{0}'} args={[outside.length > 0 && tr(' Also in the configuration, kept as is: {0} (JSON view).', [outside.join(', ')])]} />
          </div>
        </div>
      ) : (
        <Field error={jsonError} hint={meta && !meta.defaultConfig ? tr('this plugin takes no configuration') : tr("the plugin's native configuration")}>
          <CodeEditor value={config} onChange={setConfig} language="json" minHeight={160} maxHeight={380} ariaLabel={tr('plugin configuration')} />
        </Field>
      )}
      <div className="grid-2">
        <Field label={tr('Only on paths')} hint={tr('Java regular expressions on the full request path; empty = everywhere')}>
          <TagsInput value={p.include} onChange={(v) => setP({ ...p, include: v })} placeholder={tr('/v1/admin/.*')} />
        </Field>
        <Field label={tr('Except paths')} hint={tr('evaluated after the include list')}>
          <TagsInput value={p.exclude} onChange={(v) => setP({ ...p, exclude: v })} placeholder={tr('/v1/health')} />
        </Field>
      </div>
      <Switch checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} label={tr('Enabled')} />
    </Modal>
  );
}

function AddGroupModal({ groups, onAdd, onClose }) {
  const [sel, setSel] = useState('');
  const published = groups.filter((g) => g.last_version);
  return (
    <Modal
      title={tr('Add a shared policy group')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!sel}
            onClick={() => {
              const g = published.find((x) => x.id === sel);
              onAdd({ group: g.id, version: g.last_version });
            }}
          >
            {tr('Pin latest version')}
          </button>
        </>
      }
    >
      <p className="muted small">{tr('The flow pins a published version of the group. Publishing a new version of the group changes nothing here until you upgrade — snapshots are immutable.')}</p>
      {published.length ? (
        <Select value={sel} onChange={setSel} options={[{ value: '', label: tr('Choose a group…') }, ...published.map((g) => ({ value: g.id, label: tr('{0} — v{1}', [g.name, g.last_version]) }))]} />
      ) : (
        <Callout kind="info">{tr('No published policy group yet.')}</Callout>
      )}
    </Modal>
  );
}

export function FlowsTab({ draft, setDraft, readOnly }) {
  const { wapi, slug } = useWs();
  const catalog = useLoad(() => rootApi.get('/gateway/plugins').catch(() => []), []);
  const groups = useLoad(() => wapi.get('/policy-groups'), [slug]);
  const [editing, setEditing] = useState(null);
  const [addingGroup, setAddingGroup] = useState(null);
  const groupOf = (id) => (groups.data || []).find((g) => g.id === id);
  const updateFlow = (id, patch) => setDraft((d) => ({ ...d, flows: d.flows.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
  return (
    <div className="col gap-16">
      <p className="muted small">
        {tr('A flow is a named chain of Otoroshi plugins, run in this order within each step of the request. A resource runs one flow; a plan can add its own flow (merged with the flow of the current route) to put a policy plan by plan. Shared policy groups are expanded in place.')}
      </p>
      {draft.flows.map((f) => {
        const resources = draft.resources.filter((r) => r.flowId === f.id);
        const plans = draft.plans.filter((p) => p.flowRef === f.id);
        const usedBy = resources.length;
        const usedByPlans = plans.length;
        const usage = [
          resources.length ? `${resources.length > 1 ? 'resources' : 'resource'} ${resources.map((r) => r.name).join(', ')}` : '',
          plans.length ? `${plans.length > 1 ? 'plans' : 'plan'} ${plans.map((p) => p.name).join(', ')}` : '',
        ].filter(Boolean);
        return (
          <div key={f.id} className="card">
            <div className="card-head">
              <Icon name="layers" />
              <input className="input" style={{ maxWidth: 280, fontWeight: 600 }} value={f.name} disabled={readOnly} onChange={(e) => updateFlow(f.id, { name: e.target.value })} aria-label={tr('flow name')} />
              <span className="faint small grow ellipsis">{usage.length ? tr('runs for {0}', [usage.join(' · ')]) : tr('not used yet')}</span>
              {!readOnly && (
                <>
                  <button className="btn sm" onClick={() => setEditing({ flowId: f.id, index: -1, value: { plugin: '', enabled: true, include: [], exclude: [], config: {} } })}>
                    <Icon name="plus" /> {tr('Add plugin')}
                  </button>
                  <button className="btn sm" onClick={() => setAddingGroup(f.id)}>
                    <Icon name="layers" /> {tr('Add policy group')}
                  </button>
                  <button className="btn ghost sm icon" disabled={usedBy + usedByPlans > 0} title={usedBy + usedByPlans > 0 ? tr('in use') : tr('delete flow')} onClick={() => setDraft((d) => ({ ...d, flows: d.flows.filter((x) => x.id !== f.id) }))}>
                    <Icon name="trash" />
                  </button>
                </>
              )}
            </div>
            {f.plugins.length ? (
              f.plugins.map((p, i) => {
                const move = (delta) => updateFlow(f.id, { plugins: moveItem(f.plugins, i, delta) });
                const remove = () => updateFlow(f.id, { plugins: f.plugins.filter((_, j) => j !== i) });
                return p.group ? (
                  <div key={i} className="list-item">
                    <span className="faint tiny">{i + 1}</span>
                    <Icon name="layers" />
                    <div className="grow">
                      <div className="bold small">
                        {groupOf(p.group)?.name || p.group} <span className="badge"><Tr text={'v{0}'} args={[p.version]} /></span>
                      </div>
                      <div className="faint tiny">{tr('shared policy group, expanded inline at projection')}</div>
                    </div>
                    {groupOf(p.group)?.last_version > p.version && (
                      <>
                        <span className="badge warning"><Tr text={'v{0} available'} args={[groupOf(p.group).last_version]} /></span>
                        {!readOnly && (
                          <button className="btn xs" onClick={() => updateFlow(f.id, { plugins: f.plugins.map((x, j) => (j === i ? { ...x, version: groupOf(p.group).last_version } : x)) })}>
                            {tr('Upgrade')}
                          </button>
                        )}
                      </>
                    )}
                    {!readOnly && (
                      <>
                        <MoveButtons index={i} count={f.plugins.length} onMove={move} />
                        <button className="btn ghost sm icon" onClick={remove} aria-label={tr('remove')}>
                          <Icon name="trash" />
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <PluginRow
                    key={i}
                    index={i}
                    count={f.plugins.length}
                    plugin={p}
                    catalog={catalog.data}
                    readOnly={readOnly}
                    onMove={move}
                    onRemove={remove}
                    onEdit={() => setEditing({ flowId: f.id, index: i, value: p })}
                  />
                );
              })
            ) : (
              <div className="card-body muted small">{tr('No plugin.')}</div>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setDraft((d) => ({ ...d, flows: [...d.flows, { id: rid('flow'), name: 'New flow', plugins: [] }] }))}>
          <Icon name="plus" /> {tr('Add flow')}
        </button>
      )}
      {addingGroup && (
        <AddGroupModal
          groups={groups.data || []}
          onClose={() => setAddingGroup(null)}
          onAdd={(ref) => {
            const f = draft.flows.find((x) => x.id === addingGroup);
            updateFlow(f.id, { plugins: [...f.plugins, ref] });
            setAddingGroup(null);
          }}
        />
      )}
      {editing && (
        <PluginModal
          value={editing.value}
          catalog={catalog.data}
          onClose={() => setEditing(null)}
          onSave={(p) => {
            const f = draft.flows.find((x) => x.id === editing.flowId);
            const plugins = editing.index < 0 ? [...f.plugins, p] : f.plugins.map((x, j) => (j === editing.index ? p : x));
            updateFlow(f.id, { plugins });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings: identity, lifecycle, technical details, danger zone

export function SettingsTab({ api, draft, setDraft, identity, setIdent, readOnly, reload }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const teams = useLoad(() => wapi.get('/teams'), [slug]);
  const metaFields = useMetadataFields('api');
  const projection = useLoad(() => wapi.get(`/apis/${api.id}/projection`), [api.id]);
  const [version, setVersion] = useState('');
  const lifecycle = async (l) => {
    try {
      await wapi.post(`/apis/${api.id}/lifecycle`, { lifecycle: l });
      toast(tr('API {0}', [l]));
      reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="col gap-24">
      <div className="card">
        <div className="card-body">
          <Setting label={tr('Name')}>
            <Input value={identity.name} onChange={(v) => setIdent({ name: v })} disabled={readOnly} />
          </Setting>
          <Setting label={tr('Description')} help={tr('shown in the catalogue')}>
            <TextArea value={identity.description} onChange={(v) => setIdent({ description: v })} rows={3} disabled={readOnly} />
          </Setting>
          <Setting label={tr('Tags')} help={tr('business classification — domain, exposure, criticality — never a governance axis')}>
            <TagsInput value={identity.tags} onChange={(v) => setIdent({ tags: v })} />
          </Setting>
          <Setting label={tr('Owning team')} help={tr('the producers of this team can edit the api')}>
            <Select value={identity.team_id || ''} onChange={(v) => setIdent({ team_id: v || null })} options={[{ value: '', label: tr('no team') }, ...(teams.data || []).filter((t) => !t.personal).map((t) => ({ value: t.id, label: t.name }))]} disabled={readOnly} />
          </Setting>
          <Setting label={tr('Catalogue visibility')} help={tr('who sees the api on the portal. Never projected on the gateway.')}>
            <Select
              value={identity.visibility}
              onChange={(v) => setIdent({ visibility: v })}
              disabled={readOnly}
              options={[
                { value: 'public', label: tr('Public — anyone, including anonymous visitors') },
                { value: 'authenticated', label: tr('Authenticated — signed-in members of the portal') },
                { value: 'restricted', label: tr('Restricted — by ACL tags') },
              ]}
            />
            {identity.visibility === 'restricted' && <TagsInput value={identity.acl} onChange={(v) => setIdent({ acl: v })} placeholder={tr('user:jane@corp.com, team:<id>, role:producer')} />}
          </Setting>
          {metaFields.length > 0 && (
            <Setting label={tr('Metadata')} help={tr("typed fields declared for the workspace's apis — never projected on the gateway")}>
              <MetadataForm fields={metaFields} values={identity.metadata} onChange={(v) => setIdent({ metadata: v })} disabled={readOnly} />
            </Setting>
          )}
          <Setting label={tr('Gateway capture')} help={tr('Otoroshi settings of the projected api')}>
            <Switch checked={draft.settings.capture} onChange={(v) => setDraft((d) => ({ ...d, settings: { ...d.settings, capture: v } }))} label={tr('Capture request/response bodies')} disabled={readOnly} />
            <Switch checked={draft.settings.debugFlow} onChange={(v) => setDraft((d) => ({ ...d, settings: { ...d.settings, debugFlow: v } }))} label={tr('Debug flow')} disabled={readOnly} />
            <Switch checked={draft.settings.exportReporting} onChange={(v) => setDraft((d) => ({ ...d, settings: { ...d.settings, exportReporting: v } }))} label={tr('Export reporting')} disabled={readOnly} />
          </Setting>
        </div>
      </div>

      {!readOnly && (
        <div className="card">
          <div className="card-head">
            <Icon name="git" />
            <h3>{tr('Versions and lifecycle')}</h3>
          </div>
          <div className="card-body">
            <Setting label={tr('New version')} help={tr('A version is a new API pre-filled from this one: its own routes, plans, documentation and lifecycle. Subscriptions do not follow; transfer them.')}>
              <div className="row">
                <Input value={version} onChange={setVersion} placeholder="2.0.0" />
                <button
                  className="btn"
                  disabled={!version}
                  onClick={async () => {
                    try {
                      const created = await wapi.post(`/apis/${api.id}/versions`, { version });
                      toast(tr('Version {0} created as a draft', [version]));
                      navigate(`/ws/${slug}/apis/${created.id}`);
                    } catch (e) {
                      toast(errorMessage(e), 'error');
                    }
                  }}
                >
                  {tr('Create version')}
                </button>
              </div>
            </Setting>
            <Setting label={tr('Lifecycle')} help={tr('deprecated: still served, closed to new subscriptions. archived: removed from the gateway.')}>
              <div className="row">
                <StatusBadge status={api.lifecycle} />
                {api.lifecycle === 'published' && (
                  <button className="btn sm" onClick={() => lifecycle('deprecated')}>
                    {tr('Deprecate')}
                  </button>
                )}
                {api.lifecycle === 'deprecated' && (
                  <button className="btn sm" onClick={() => lifecycle('published')}>
                    {tr('Republish')}
                  </button>
                )}
                {['published', 'deprecated'].includes(api.lifecycle) && (
                  <button
                    className="btn sm danger"
                    onClick={async () => (await confirm({ title: tr('Archive this API?'), message: tr('It is removed from the gateway: its consumers get 404 from now on.'), danger: true, confirmLabel: tr('Archive') })) && lifecycle('archived')}
                  >
                    {tr('Archive')}
                  </button>
                )}
              </div>
            </Setting>
          </div>
        </div>
      )}

      {/* the escape hatch, discreet but always there */}
      <details className="card">
        <summary className="card-head" style={{ cursor: 'pointer' }}>
          <Icon name="info" />
          <h3>{tr('Technical details')}</h3>
        </summary>
        <div className="card-body col">
          <Loader state={projection}>
            {(p) => (
              <>
                <dl className="kv">
                  <dt>{tr('Product id')}</dt>
                  <dd className="mono">{api.id}</dd>
                  <dt>{tr('Otoroshi entity')}</dt>
                  <dd className="mono">
                    {p.otoroshi.kind} / {p.otoroshi.id}
                  </dd>
                  <dt>{tr('On the gateway')}</dt>
                  <dd>
                    {p.actual ? <StatusBadge status="deployed" label={tr('present')} /> : <StatusBadge status="none" label={tr('absent')} />}{' '}
                    {p.actual && (
                      <a className="link small" href={p.otoroshi.backoffice_url} target="_blank" rel="noreferrer">
                        {tr('open in the Otoroshi backoffice')} <Icon name="external" size={12} />
                      </a>
                    )}
                  </dd>
                  <dt>{tr('Ownership marker')}</dt>
                  <dd className="mono small">{p.actual?.metadata?.created_by || '—'}</dd>
                  <dt>{tr('Otoroshi deployments')}</dt>
                  <dd className="col gap-4">
                    {p.gateway_deployments?.length ? (
                      p.gateway_deployments.map((d) => (
                        <span key={d.id} className="small">
                          {fmtDate(d.at)} — {d.snapshot_number != null ? tr('snapshot #{0}', [d.snapshot_number]) : <span className="mono">{d.ref || tr('no ref')}</span>}{' '}
                          <span className="faint mono">{d.owner}</span>
                        </span>
                      ))
                    ) : (
                      <span className="faint small">{tr('none recorded')}</span>
                    )}
                  </dd>
                  {p.derived?.length > 0 && (
                    <>
                      <dt>{tr('Derived objects')}</dt>
                      <dd className="col gap-4">
                        {p.derived.map((d) => (
                          <span key={d.id} className="small">
                            {d.kind} <span className="mono">{d.id}</span> {d.present ? <StatusBadge status="deployed" label={tr('present')} /> : <StatusBadge status="missing" />}
                          </span>
                        ))}
                      </dd>
                    </>
                  )}
                  {p.drift && (
                    <>
                      <dt>{tr('Drift')}</dt>
                      <dd>
                        <StatusBadge status={p.drift.status} />
                      </dd>
                    </>
                  )}
                </dl>
                {p.actual && (
                  <details>
                    <summary className="link small">{tr('Show the projected entity as the gateway holds it')}</summary>
                    <div className="mt-8">
                      <CodeView value={p.actual} maxHeight={480} ariaLabel={tr('entity on the gateway')} />
                    </div>
                  </details>
                )}
              </>
            )}
          </Loader>
        </div>
      </details>

      {!readOnly && (
        <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--negative) 35%, transparent)' }}>
          <div className="card-head">
            <Icon name="alert" />
            <h3>{tr('Danger zone')}</h3>
          </div>
          <div className="card-body">
            <Setting
              label={tr('Delete this API')}
              help={
                api.deployment.deployed
                  ? tr('Removes the Api entity and the keys of its {0}subscriptions from the gateway: every consumer of {1} gets 404 from now on.', [api.deployment ? '' : '', draft.entrypoint.domain])
                  : tr('Nothing is deployed: deleting it touches nothing on the gateway.')
              }
            >
              <button
                className="btn danger"
                style={{ alignSelf: 'flex-start' }}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: tr('Delete {0} {1}?', [api.name, api.version]),
                      message: api.deployment.deployed ? tr('It runs on the gateway. Deleting it removes its routes and the keys of all its subscriptions: calls to {0} will return 404.', [api.base_url]) : tr('Its draft, snapshots and documentation are deleted.'),
                      danger: true,
                      confirmLabel: tr('Delete'),
                    }))
                  )
                    return;
                  try {
                    await wapi.del(`/apis/${api.id}`);
                    toast(tr('API deleted'));
                    navigate(`/ws/${slug}/apis`);
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                <Icon name="trash" /> {tr('Delete API')}
              </button>
            </Setting>
          </div>
        </div>
      )}
    </div>
  );
}
