import React, { useState } from 'react';
import { Link, useRouter } from '../../../shared/router.jsx';
import { AUTH_LABELS, fmtNumber, fmtWindow } from '../../../shared/lib.js';
import {
  Badge, Callout, Code, Empty, Field, Icon, Input, JsonBlock, Loader, Modal, NumberInput, Select, Setting, StatusBadge, Switch, TagsInput, TextArea,
  errorMessage, useConfirm, useLoad, useToast,
} from '../../../shared/ui.jsx';
import { api as rootApi, useWs, useMetadataFields } from '../../context.jsx';
import { MetadataForm } from '../../../shared/metadata.jsx';
import { CodeEditor } from '../../../shared/code-editor.jsx';

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
            <h3>How to call it</h3>
          </div>
          <div className="card-body col">
            <Field label="Base URL">
              <div className="secret" style={{ width: '100%' }}>
                <span className="grow ellipsis">{base}</span>
              </div>
            </Field>
            <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>Create an application on the developer portal.</li>
              <li>Subscribe it to a plan{plan ? ` (e.g. ${plan.name})` : ''}.</li>
              <li>Call the API with the credentials of the subscription.</li>
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
            <h3 className="grow">Plans</h3>
            <Link className="link small" to={`/ws/${slug}/apis/${api.id}/plans`}>
              Edit plans
            </Link>
          </div>
          {draft.plans.length ? (
            draft.plans.map((p) => (
              <div key={p.id} className="list-item">
                <div className="grow">
                  <div className="bold">{p.name}</div>
                  <div className="muted small">
                    {AUTH_LABELS[p.auth.kind]} · {p.rateLimit.enabled ? `${fmtNumber(p.rateLimit.calls)} calls / ${fmtWindow(p.rateLimit.windowMs)}` : 'no rate limit'}
                    {p.quota.daily ? ` · ${fmtNumber(p.quota.daily)}/day` : ''}
                    {p.quota.monthly ? ` · ${fmtNumber(p.quota.monthly)}/month` : ''} · {p.validation} approval
                  </div>
                </div>
                <StatusBadge status={p.status} />
              </div>
            ))
          ) : (
            <Empty title="No plan" icon="layers">
              Without a published plan the gateway serves the routes to anyone.
            </Empty>
          )}
          {order.length > 0 && (
            <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="label mb-8">Effective resolution order on the gateway</div>
              <div className="row wrap gap-6">
                {order.map((o, i) => (
                  <span key={o.id} className="order-chip" title={`extractor index ${o.index}`}>
                    <span className="bold">{i + 1}</span> {o.name} <span className="faint">{o.kind}</span>
                  </span>
                ))}
              </div>
              <p className="hint mt-8">It follows the extractor index of each auth kind in Otoroshi, it is not freely chosen — the console shows it rather than hiding it.</p>
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <Icon name="api" />
          <h3 className="grow">Resources</h3>
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
                  <td className="small muted">{draft.flows.find((f) => f.id === r.flowId)?.name || 'no flow'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {api.previous_version_id && (
        <p className="muted small">
          This version was created from{' '}
          <Link className="link" to={`/ws/${slug}/apis/${api.previous_version_id}`}>
            the previous version
          </Link>
          . Subscriptions do not follow a new version: transfer them.
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
      title={value.name ? `Resource ${value.name}` : 'New resource'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(r)}>
            Apply
          </button>
        </>
      }
    >
      <p className="muted small">A resource is an endpoint or a group of endpoints; it is projected as a route of the Otoroshi <code>Api</code>, relative to the entrypoint.</p>
      <div className="grid-2">
        <Field label="Name">
          <Input value={r.name} onChange={set('name')} autoFocus />
        </Field>
        <Field label="Path" hint={r.exact ? 'exact match' : 'matches this path and below'}>
          <Input value={r.path} onChange={set('path')} mono />
        </Field>
      </div>
      <Field label="Description">
        <Input value={r.description} onChange={set('description')} />
      </Field>
      <Field label="Methods" hint="none selected = every method">
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
        <Field label="Backend">
          <Select value={r.backendId} onChange={set('backendId')} options={draft.backends.map((b) => ({ value: b.id, label: b.name }))} />
        </Field>
        <Field label="Policy flow" hint="plugins applied on this resource">
          <Select value={r.flowId || ''} onChange={(v) => set('flowId')(v || null)} options={[{ value: '', label: 'none' }, ...draft.flows.map((f) => ({ value: f.id, label: f.name }))]} />
        </Field>
      </div>
      <div className="row gap-24">
        <Switch checked={r.exact} onChange={set('exact')} label="Exact path" />
        <Switch checked={r.stripPath} onChange={set('stripPath')} label="Strip path" />
        <Switch checked={r.enabled} onChange={set('enabled')} label="Enabled" />
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
          <h3 className="grow">Entrypoint</h3>
        </div>
        <div className="card-body grid-2">
          <Field label="Domain" hint="the hostname the gateway serves this api on">
            <Input value={draft.entrypoint.domain} disabled={readOnly} onChange={(v) => setDraft((d) => ({ ...d, entrypoint: { ...d.entrypoint, domain: v } }))} mono />
          </Field>
          <Field label="Context path" hint="prefix of every resource">
            <Input value={draft.entrypoint.contextPath} disabled={readOnly} onChange={(v) => setDraft((d) => ({ ...d, entrypoint: { ...d.entrypoint, contextPath: v } }))} mono />
          </Field>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">Resources</h3>
          {!readOnly && (
            <button className="btn sm" onClick={() => setEditing({ id: rid('res'), name: '', description: '', path: '/', methods: [], exact: false, stripPath: true, backendId: draft.backends[0]?.id, flowId: draft.flows[0]?.id || null, enabled: true })}>
              <Icon name="plus" /> Add resource
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Match</th>
                <th>Backend</th>
                <th>Flow</th>
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
                    {r.exact ? '' : '*'} {!r.enabled && <Badge>disabled</Badge>}
                  </td>
                  <td className="small">{draft.backends.find((b) => b.id === r.backendId)?.name || <span className="negative-text">unknown</span>}</td>
                  <td className="small">{draft.flows.find((f) => f.id === r.flowId)?.name || '—'}</td>
                  <td className="actions">
                    {!readOnly && (
                      <>
                        <button className="btn ghost sm icon" onClick={() => setEditing(r)} aria-label="edit">
                          <Icon name="edit" />
                        </button>
                        <button className="btn ghost sm icon" onClick={() => setDraft((d) => ({ ...d, resources: d.resources.filter((x) => x.id !== r.id) }))} aria-label="delete">
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
      title={value.name ? `Backend ${value.name}` : 'New backend'}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(b)}>
            Apply
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Name">
          <Input value={b.name} onChange={set('name')} />
        </Field>
        <Field label="Load balancing">
          <Select value={b.loadBalancing} onChange={set('loadBalancing')} options={['RoundRobin', 'Random', 'Sticky', 'IpAddressHash', 'BestResponseTime', 'WeightedBestResponseTime', 'LeastConnections']} />
        </Field>
      </div>
      <div className="label">Targets</div>
      {b.targets.map((t, i) => (
        <div key={i} className="row">
          <Input value={t.hostname} onChange={(v) => setTarget(i, { hostname: v })} placeholder="hostname" mono />
          <NumberInput value={t.port} onChange={(v) => setTarget(i, { port: v })} style={{ width: 110 }} />
          <Switch checked={t.tls} onChange={(v) => setTarget(i, { tls: v })} label="TLS" />
          <NumberInput value={t.weight} onChange={(v) => setTarget(i, { weight: v })} style={{ width: 80 }} title="weight" />
          <button className="btn ghost sm icon" onClick={() => setB((x) => ({ ...x, targets: x.targets.filter((_, j) => j !== i) }))} aria-label="remove target">
            <Icon name="trash" />
          </button>
        </div>
      ))}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setB((x) => ({ ...x, targets: [...x.targets, { hostname: '', port: 443, tls: true, weight: 1 }] }))}>
        <Icon name="plus" /> Add target
      </button>
      <div className="grid-2">
        <Field label="Root path" hint="prefix added on the backend side">
          <Input value={b.root} onChange={set('root')} mono />
        </Field>
        <Field label="Retries">
          <NumberInput value={b.retries} onChange={set('retries')} />
        </Field>
      </div>
      <div className="grid-3">
        <Field label="Call timeout (ms)">
          <NumberInput value={b.timeouts.callMs} onChange={(v) => setB((x) => ({ ...x, timeouts: { ...x.timeouts, callMs: v } }))} />
        </Field>
        <Field label="Connection timeout (ms)">
          <NumberInput value={b.timeouts.connectionMs} onChange={(v) => setB((x) => ({ ...x, timeouts: { ...x.timeouts, connectionMs: v } }))} />
        </Field>
        <Field label="Idle timeout (ms)">
          <NumberInput value={b.timeouts.idleMs} onChange={(v) => setB((x) => ({ ...x, timeouts: { ...x.timeouts, idleMs: v } }))} />
        </Field>
      </div>
      <Switch checked={b.rewrite} onChange={set('rewrite')} label="Rewrite the path (use named path params in the root)" />
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
      <p className="muted small">Backends are infrastructure: targets, TLS, timeouts, load balancing. They belong to the route side, never to the offer.</p>
      <div className="grid-2">
        {draft.backends.map((b) => (
          <div key={b.id} className="card">
            <div className="card-head">
              <Icon name="box" />
              <h3 className="grow">{b.name}</h3>
              {!readOnly && (
                <>
                  <button className="btn ghost sm icon" onClick={() => setEditing(b)} aria-label="edit">
                    <Icon name="edit" />
                  </button>
                  <button
                    className="btn ghost sm icon"
                    disabled={draft.resources.some((r) => r.backendId === b.id)}
                    title={draft.resources.some((r) => r.backendId === b.id) ? 'used by a resource' : 'delete'}
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
                  {t.tls ? 'https' : 'http'}://{t.hostname}:{t.port}
                  {b.root !== '/' ? b.root : ''} <span className="faint">w{t.weight}</span>
                </div>
              ))}
              <div className="faint tiny">
                {b.loadBalancing} · timeout {b.timeouts.callMs} ms · {b.retries} retries · used by {draft.resources.filter((r) => r.backendId === b.id).length} resource(s)
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
          <Icon name="plus" /> Add backend
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
      <button className="btn ghost sm icon" disabled={index === 0} onClick={() => onMove(-1)} aria-label="move up" title="run earlier">
        <Icon name="up" />
      </button>
      <button className="btn ghost sm icon" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="move down" title="run later">
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
          {p.exclude?.length ? ` · except ${p.exclude.join(', ')}` : ''} · {summary || 'default configuration'}
        </div>
      </div>
      {!p.enabled && <Badge>disabled</Badge>}
      {!readOnly && (
        <>
          <MoveButtons index={index} count={count} onMove={onMove} />
          <button className="btn ghost sm icon" onClick={onEdit} aria-label="edit">
            <Icon name="edit" />
          </button>
          <button className="btn ghost sm icon" onClick={onRemove} aria-label="remove">
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
      <Callout kind="warning" title="Not in the gateway's catalog">
        <span className="mono small">{id}</span> — a custom plugin, or a gateway that does not run it. It is projected as is.
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
  const meta = pluginOf(catalog, p.plugin);
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
    if (untouched) setConfig(JSON.stringify(c.defaultConfig || {}, null, 2));
  };
  return (
    <Modal
      title={isNew ? 'Add a plugin' : `Edit plugin — ${meta?.name || shortPluginId(p.plugin)}`}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!p.plugin || !!jsonError} onClick={() => onSave({ ...p, config: parsed })}>
            {isNew ? 'Add to the flow' : 'Apply'}
          </button>
        </>
      }
    >
      <p className="muted small">The plugins are Otoroshi's own — no product-specific plugin. The configuration is the plugin's native one, and it reaches the gateway as is.</p>
      {catalog?.length > 0 && picking && (
        <div className="panel col gap-6">
          <div className="row">
            <div className="grow">
              <Input value={q} onChange={setQ} placeholder={`search the gateway's ${catalog.length} plugins`} aria-label="search plugins" autoFocus />
            </div>
            <div style={{ width: 220 }}>
              <Select value={category} onChange={setCategory} options={[{ value: '', label: 'all categories' }, ...categories]} aria-label="category" />
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
            {!matches.length && <div className="muted small" style={{ padding: 12 }}>No plugin matches.</div>}
          </div>
        </div>
      )}
      <PluginCard meta={meta} id={p.plugin} />
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="grow">
          <Field label="Plugin id">
            <Input value={p.plugin} onChange={(v) => setP({ ...p, plugin: v })} mono placeholder="cp:otoroshi.next.plugins.…" />
          </Field>
        </div>
        {catalog?.length > 0 && !picking && (
          <button className="btn" onClick={() => setPicking(true)}>
            <Icon name="search" /> Change plugin
          </button>
        )}
      </div>
      <div className="row">
        <label className="bold small grow">Configuration (json)</label>
        {meta && (
          <button className="btn ghost xs" onClick={() => setConfig(JSON.stringify(meta.defaultConfig || {}, null, 2))} disabled={!jsonError && JSON.stringify(parsed) === JSON.stringify(meta.defaultConfig || {})}>
            Reset to the default configuration
          </button>
        )}
      </div>
      <Field error={jsonError} hint={meta && !meta.defaultConfig ? 'this plugin takes no configuration' : "the plugin's native configuration"}>
        <CodeEditor value={config} onChange={setConfig} language="json" minHeight={160} maxHeight={380} ariaLabel="plugin configuration" />
      </Field>
      <div className="grid-2">
        <Field label="Only on paths" hint="Java regular expressions on the full request path; empty = everywhere">
          <TagsInput value={p.include} onChange={(v) => setP({ ...p, include: v })} placeholder="/v1/admin/.*" />
        </Field>
        <Field label="Except paths" hint="evaluated after the include list">
          <TagsInput value={p.exclude} onChange={(v) => setP({ ...p, exclude: v })} placeholder="/v1/health" />
        </Field>
      </div>
      <Switch checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} label="Enabled" />
    </Modal>
  );
}

function AddGroupModal({ groups, onAdd, onClose }) {
  const [sel, setSel] = useState('');
  const published = groups.filter((g) => g.last_version);
  return (
    <Modal
      title="Add a shared policy group"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!sel}
            onClick={() => {
              const g = published.find((x) => x.id === sel);
              onAdd({ group: g.id, version: g.last_version });
            }}
          >
            Pin latest version
          </button>
        </>
      }
    >
      <p className="muted small">The flow pins a published version of the group. Publishing a new version of the group changes nothing here until you upgrade — snapshots are immutable.</p>
      {published.length ? (
        <Select value={sel} onChange={setSel} options={[{ value: '', label: 'Choose a group…' }, ...published.map((g) => ({ value: g.id, label: `${g.name} — v${g.last_version}` }))]} />
      ) : (
        <Callout kind="info">No published policy group yet.</Callout>
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
        A flow is a named chain of Otoroshi plugins, run in this order within each step of the request. A resource runs one flow; a plan can add its own flow (merged with the flow of
        the current route) to put a policy plan by plan. Shared policy groups are expanded in place.
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
              <input className="input" style={{ maxWidth: 280, fontWeight: 600 }} value={f.name} disabled={readOnly} onChange={(e) => updateFlow(f.id, { name: e.target.value })} aria-label="flow name" />
              <span className="faint small grow ellipsis">{usage.length ? `runs for ${usage.join(' · ')}` : 'not used yet'}</span>
              {!readOnly && (
                <>
                  <button className="btn sm" onClick={() => setEditing({ flowId: f.id, index: -1, value: { plugin: '', enabled: true, include: [], exclude: [], config: {} } })}>
                    <Icon name="plus" /> Add plugin
                  </button>
                  <button className="btn sm" onClick={() => setAddingGroup(f.id)}>
                    <Icon name="layers" /> Add policy group
                  </button>
                  <button className="btn ghost sm icon" disabled={usedBy + usedByPlans > 0} title={usedBy + usedByPlans > 0 ? 'in use' : 'delete flow'} onClick={() => setDraft((d) => ({ ...d, flows: d.flows.filter((x) => x.id !== f.id) }))}>
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
                        {groupOf(p.group)?.name || p.group} <span className="badge">v{p.version}</span>
                      </div>
                      <div className="faint tiny">shared policy group, expanded inline at projection</div>
                    </div>
                    {groupOf(p.group)?.last_version > p.version && (
                      <>
                        <span className="badge warning">v{groupOf(p.group).last_version} available</span>
                        {!readOnly && (
                          <button className="btn xs" onClick={() => updateFlow(f.id, { plugins: f.plugins.map((x, j) => (j === i ? { ...x, version: groupOf(p.group).last_version } : x)) })}>
                            Upgrade
                          </button>
                        )}
                      </>
                    )}
                    {!readOnly && (
                      <>
                        <MoveButtons index={i} count={f.plugins.length} onMove={move} />
                        <button className="btn ghost sm icon" onClick={remove} aria-label="remove">
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
              <div className="card-body muted small">No plugin.</div>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setDraft((d) => ({ ...d, flows: [...d.flows, { id: rid('flow'), name: 'New flow', plugins: [] }] }))}>
          <Icon name="plus" /> Add flow
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
      toast(`API ${l}`);
      reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="col gap-24">
      <div className="card">
        <div className="card-body">
          <Setting label="Name">
            <Input value={identity.name} onChange={(v) => setIdent({ name: v })} disabled={readOnly} />
          </Setting>
          <Setting label="Description" help="shown in the catalogue">
            <TextArea value={identity.description} onChange={(v) => setIdent({ description: v })} rows={3} disabled={readOnly} />
          </Setting>
          <Setting label="Tags" help="business classification — domain, exposure, criticality — never a governance axis">
            <TagsInput value={identity.tags} onChange={(v) => setIdent({ tags: v })} />
          </Setting>
          <Setting label="Owning team" help="the producers of this team can edit the api">
            <Select value={identity.team_id || ''} onChange={(v) => setIdent({ team_id: v || null })} options={[{ value: '', label: 'no team' }, ...(teams.data || []).filter((t) => !t.personal).map((t) => ({ value: t.id, label: t.name }))]} disabled={readOnly} />
          </Setting>
          <Setting label="Catalogue visibility" help="who sees the api on the portal. Never projected on the gateway.">
            <Select
              value={identity.visibility}
              onChange={(v) => setIdent({ visibility: v })}
              disabled={readOnly}
              options={[
                { value: 'public', label: 'Public — anyone, including anonymous visitors' },
                { value: 'authenticated', label: 'Authenticated — signed-in members of the portal' },
                { value: 'restricted', label: 'Restricted — by ACL tags' },
              ]}
            />
            {identity.visibility === 'restricted' && <TagsInput value={identity.acl} onChange={(v) => setIdent({ acl: v })} placeholder="user:jane@corp.com, team:<id>, role:producer" />}
          </Setting>
          {metaFields.length > 0 && (
            <Setting label="Metadata" help="typed fields declared for the workspace's apis — never projected on the gateway">
              <MetadataForm fields={metaFields} values={identity.metadata} onChange={(v) => setIdent({ metadata: v })} disabled={readOnly} />
            </Setting>
          )}
          <Setting label="Gateway capture" help="Otoroshi settings of the projected api">
            <Switch checked={draft.settings.capture} onChange={(v) => setDraft((d) => ({ ...d, settings: { ...d.settings, capture: v } }))} label="Capture request/response bodies" disabled={readOnly} />
            <Switch checked={draft.settings.debugFlow} onChange={(v) => setDraft((d) => ({ ...d, settings: { ...d.settings, debugFlow: v } }))} label="Debug flow" disabled={readOnly} />
            <Switch checked={draft.settings.exportReporting} onChange={(v) => setDraft((d) => ({ ...d, settings: { ...d.settings, exportReporting: v } }))} label="Export reporting" disabled={readOnly} />
          </Setting>
        </div>
      </div>

      {!readOnly && (
        <div className="card">
          <div className="card-head">
            <Icon name="git" />
            <h3>Versions and lifecycle</h3>
          </div>
          <div className="card-body">
            <Setting label="New version" help="A version is a new API pre-filled from this one: its own routes, plans, documentation and lifecycle. Subscriptions do not follow; transfer them.">
              <div className="row">
                <Input value={version} onChange={setVersion} placeholder="2.0.0" />
                <button
                  className="btn"
                  disabled={!version}
                  onClick={async () => {
                    try {
                      const created = await wapi.post(`/apis/${api.id}/versions`, { version });
                      toast(`Version ${version} created as a draft`);
                      navigate(`/ws/${slug}/apis/${created.id}`);
                    } catch (e) {
                      toast(errorMessage(e), 'error');
                    }
                  }}
                >
                  Create version
                </button>
              </div>
            </Setting>
            <Setting label="Lifecycle" help="deprecated: still served, closed to new subscriptions. archived: removed from the gateway.">
              <div className="row">
                <StatusBadge status={api.lifecycle} />
                {api.lifecycle === 'published' && (
                  <button className="btn sm" onClick={() => lifecycle('deprecated')}>
                    Deprecate
                  </button>
                )}
                {api.lifecycle === 'deprecated' && (
                  <button className="btn sm" onClick={() => lifecycle('published')}>
                    Republish
                  </button>
                )}
                {['published', 'deprecated'].includes(api.lifecycle) && (
                  <button
                    className="btn sm danger"
                    onClick={async () => (await confirm({ title: 'Archive this API?', message: 'It is removed from the gateway: its consumers get 404 from now on.', danger: true, confirmLabel: 'Archive' })) && lifecycle('archived')}
                  >
                    Archive
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
          <h3>Technical details</h3>
        </summary>
        <div className="card-body col">
          <Loader state={projection}>
            {(p) => (
              <>
                <dl className="kv">
                  <dt>Product id</dt>
                  <dd className="mono">{api.id}</dd>
                  <dt>Otoroshi entity</dt>
                  <dd className="mono">
                    {p.otoroshi.kind} / {p.otoroshi.id}
                  </dd>
                  <dt>On the gateway</dt>
                  <dd>
                    {p.actual ? <StatusBadge status="deployed" label="present" /> : <StatusBadge status="none" label="absent" />}{' '}
                    {p.actual && (
                      <a className="link small" href={p.otoroshi.backoffice_url} target="_blank" rel="noreferrer">
                        open in the Otoroshi backoffice <Icon name="external" size={12} />
                      </a>
                    )}
                  </dd>
                  <dt>Ownership marker</dt>
                  <dd className="mono small">{p.actual?.metadata?.created_by || '—'}</dd>
                  <dt>Otoroshi deployments</dt>
                  <dd>{p.actual?.deployments?.length ?? 0} recorded (Otoroshi keeps the last five)</dd>
                  {p.derived?.length > 0 && (
                    <>
                      <dt>Derived objects</dt>
                      <dd className="col gap-4">
                        {p.derived.map((d) => (
                          <span key={d.id} className="small">
                            {d.kind} <span className="mono">{d.id}</span> {d.present ? <StatusBadge status="deployed" label="present" /> : <StatusBadge status="missing" />}
                          </span>
                        ))}
                      </dd>
                    </>
                  )}
                  {p.drift && (
                    <>
                      <dt>Drift</dt>
                      <dd>
                        <StatusBadge status={p.drift.status} />
                      </dd>
                    </>
                  )}
                </dl>
                {p.actual && (
                  <details>
                    <summary className="link small">Show the projected entity as the gateway holds it</summary>
                    <div className="mt-8">
                      <JsonBlock value={p.actual} />
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
            <h3>Danger zone</h3>
          </div>
          <div className="card-body">
            <Setting
              label="Delete this API"
              help={
                api.deployment.deployed
                  ? `Removes the Api entity and the keys of its ${api.deployment ? '' : ''}subscriptions from the gateway: every consumer of ${draft.entrypoint.domain} gets 404 from now on.`
                  : 'Nothing is deployed: deleting it touches nothing on the gateway.'
              }
            >
              <button
                className="btn danger"
                style={{ alignSelf: 'flex-start' }}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Delete ${api.name} ${api.version}?`,
                      message: api.deployment.deployed ? `It runs on the gateway. Deleting it removes its routes and the keys of all its subscriptions: calls to ${api.base_url} will return 404.` : 'Its draft, snapshots and documentation are deleted.',
                      danger: true,
                      confirmLabel: 'Delete',
                    }))
                  )
                    return;
                  try {
                    await wapi.del(`/apis/${api.id}`);
                    toast('API deleted');
                    navigate(`/ws/${slug}/apis`);
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                <Icon name="trash" /> Delete API
              </button>
            </Setting>
          </div>
        </div>
      )}
    </div>
  );
}
