import React, { useState } from 'react';
import { useRouter } from '../../shared/router.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { Callout, CopyButton, Empty, Field, FileButton, Icon, Input, Loader, Modal, NumberInput, Seg, Setting, StatusBadge, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import YAML from 'yaml';
import { CodeEditor } from '../../shared/code-editor.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';
import { ApisTabs } from './PolicyGroups.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

// what the gateway holds of a dictionary
function GatewayState({ state }) {
  const map = { in_sync: ['active', tr('on the gateway')], drifted: ['pending', tr('changed on the gateway')], missing: ['error', tr('not on the gateway')], unknown: ['created', tr('gateway unknown')] };
  const [status, label] = map[state] || map.unknown;
  return <StatusBadge status={status} label={label} />;
}

// the values of a local file, JSON or YAML: an object, or an error said
const VALUE_FILES = '.json,.yaml,.yml,application/json,application/yaml,text/yaml';
function valuesOf(text, file) {
  let v;
  try {
    v = YAML.parse(text);
  } catch (e) {
    throw new Error(tr('{0} cannot be read: {1}', [file.name, e.message]));
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(tr('{0} holds no object of values', [file.name]));
  return v;
}

// the keys of the values, as paths of dots: what an expression reads
function keysOf(entries, prefix = '') {
  return Object.entries(entries || {}).flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
}

export function DictionariesPage() {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const state = useLoad(() => wapi.get('/dictionaries'), [slug]);
  const page = useLocalPaging(state.data, {
    size: 25,
    text: (d) => `${d.name} ${d.description || ''} ${d.id} ${d.source.kind === 'url' ? d.source.url : 'static'} ${d.gateway} ${d.refreshed?.status === 'error' ? 'source failing' : ''}`,
  });
  const [creating, setCreating] = useState(null);
  return (
    <div className="page">
      <PageHead
        title={tr('Dictionaries')}
        sub={tr('A named set of values — static, or refreshed from an external source — given to the expression language of the gateway: a plugin of any API reads it, and changing it changes what runs without redeploying the APIs.')}
        actions={
          <button className="btn primary" onClick={() => setCreating({ name: '', description: '', kind: 'static' })}>
            <Icon name="plus" /> {tr('New dictionary')}
          </button>
        }
      />
      <ApisTabs current="dictionaries" />
      <ListToolbar paging={page} placeholder={tr('search dictionaries, sources')} onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {() =>
          page.items.length ? (
            <div className="card">
              <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('Dictionary')}</th>
                    <th>{tr('Source')}</th>
                    <th>{tr('Values')}</th>
                    <th>{tr('Gateway')}</th>
                    <th>{tr('Updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((d) => (
                    <tr key={d.id} className="clickable" onClick={() => navigate(`/ws/${slug}/dictionaries/${d.id}`)}>
                      <td>
                        <div className="bold mono">{d.name}</div>
                        <div className="faint tiny">{d.description}</div>
                      </td>
                      <td className="small">
                        {d.source.kind === 'url' ? (
                          <>
                            <span className="mono">{new URL(d.source.url).host}</span>
                            {d.refreshed?.status === 'error' && <StatusBadge status="error" label={tr('source failing')} />}
                          </>
                        ) : (
                          tr('static')
                        )}
                      </td>
                      <td className="small">{keysOf(d.entries).length}</td>
                      <td>
                        <GatewayState state={d.gateway} />
                      </td>
                      <td className="muted small">{fmtRelative(d.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <Pager paging={page} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={page.q ? tr('No dictionary matches') : tr('No dictionary')} icon="layers">
                {page.q ? null : tr('For example: the tiers of the partners, the backend of each region, the limits of each country.')}
              </Empty>
            </div>
          )
        }
      </Loader>
      {creating && (
        <Modal
          title={tr('New dictionary')}
          onClose={() => setCreating(null)}
          footer={
            <button
              className="btn primary"
              disabled={!creating.name || (creating.kind === 'url' && !creating.url)}
              onClick={async () => {
                try {
                  const d = await wapi.post('/dictionaries', {
                    name: creating.name,
                    description: creating.description,
                    ...(creating.kind === 'url' ? { source: { kind: 'url', url: creating.url, everySeconds: 300 } } : { entries: creating.entries || {} }),
                  });
                  navigate(`/ws/${slug}/dictionaries/${d.id}`);
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}
            >
              {tr('Create')}
            </button>
          }
        >
          <Field label={tr('Name')} hint={tr('lowercase letters, digits, dashes and underscores: the expressions read it')}>
            <Input value={creating.name} onChange={(v) => setCreating({ ...creating, name: v })} mono autoFocus />
          </Field>
          <Field label={tr('Description')}>
            <TextArea value={creating.description} onChange={(v) => setCreating({ ...creating, description: v })} rows={2} />
          </Field>
          <Field label={tr('Values')}>
            <Seg
              value={creating.kind}
              onChange={(v) => setCreating({ ...creating, kind: v })}
              options={[
                { value: 'static', label: tr('given here') },
                { value: 'url', label: tr('from a source') },
              ]}
            />
          </Field>
          {creating.kind === 'url' && (
            <Field label={tr('Source url')} hint={tr('answers a JSON object')}>
              <Input value={creating.url} onChange={(v) => setCreating({ ...creating, url: v })} mono placeholder="https://…/values.json" />
            </Field>
          )}
          {creating.kind === 'static' && (
            <Field label={tr('Initial values')} hint={tr('a JSON or YAML file holding an object; or none, and the values are written on the next page')}>
              <div className="row">
                <FileButton
                  accept={VALUE_FILES}
                  onFile={(text, file) => {
                    try {
                      setCreating({ ...creating, entries: valuesOf(text, file), file: file.name });
                    } catch (e) {
                      toast(e.message, 'error');
                    }
                  }}
                >
                  {tr('From a local file…')}
                </FileButton>
                {creating.file && <span className="muted small">{tr('{0} values from {1}', [Object.keys(creating.entries || {}).length, creating.file])}</span>}
              </div>
            </Field>
          )}
        </Modal>
      )}
    </div>
  );
}

export function DictionaryPage({ id }) {
  const { wapi, slug } = useWs();
  const state = useLoad(() => wapi.get(`/dictionaries/${id}`), [id]);
  return <Loader state={state}>{(d) => <DictionaryEditor key={d.updated_at} d={d} reload={state.reload} />}</Loader>;
}

function DictionaryEditor({ d, reload }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [description, setDescription] = useState(d.description);
  const [source, setSource] = useState(d.source);
  const [text, setText] = useState(JSON.stringify(d.entries, null, 2));
  const [headers, setHeaders] = useState(Object.entries(d.source.headers || {}).map(([k, v]) => ({ k, v })));
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parseError = e.message;
  }
  const save = async () => {
    try {
      const body =
        source.kind === 'url'
          ? { description, source: { kind: 'url', url: source.url, everySeconds: source.everySeconds, pointer: source.pointer, headers: Object.fromEntries(headers.filter((h) => h.k).map((h) => [h.k, h.v])) } }
          : { description, source: { kind: 'static' }, entries: parsed };
      await wapi.put(`/dictionaries/${d.id}`, body);
      toast(tr('Dictionary saved — the gateway follows'));
      reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const keys = keysOf(d.entries);
  const keysPage = useLocalPaging(keys, { prefix: 'keys', size: 25, text: ([k, v]) => `${k} ${String(v)}` });
  return (
    <div className="page">
      <PageHead
        crumbs={[{ label: tr('Dictionaries'), to: `/ws/${slug}/dictionaries` }, { label: d.name }]}
        title={d.name}
        sub={d.description}
        actions={
          <>
            {d.source.kind === 'url' && (
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await wapi.post(`/dictionaries/${d.id}/refresh`);
                    toast(tr('Refreshed from its source'));
                    reload();
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                <Icon name="refresh" /> {tr('Refresh now')}
              </button>
            )}
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await confirm({ title: tr('Delete the dictionary {0}?', [d.name]), message: tr('It leaves the gateway: the expressions that read it get nothing.'), danger: true, confirmLabel: tr('Delete') }))) return;
                await wapi.del(`/dictionaries/${d.id}`);
                navigate(`/ws/${slug}/dictionaries`);
              }}
            >
              <Icon name="trash" /> {tr('Delete')}
            </button>
            <button className="btn primary" disabled={source.kind === 'static' && !!parseError} onClick={save}>
              {tr('Save')}
            </button>
          </>
        }
      />
      <div className="row wrap gap-8 mb-16">
        <GatewayState state={d.gateway} />
        {d.projection?.status === 'error' && <Callout kind="negative">{tr('Not projected: {0}', [d.projection.error])}</Callout>}
        {d.source.kind === 'url' && d.refreshed?.at && (
          <span className="muted small">
            {d.refreshed.status === 'ok' ? tr('refreshed {0}', [fmtDate(d.refreshed.at)]) : tr('the source failed {0}: {1} — the last values stay', [fmtDate(d.refreshed.at), d.refreshed.error])}
          </span>
        )}
      </div>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <h3>{tr('Values')}</h3>
          </div>
          <div className="card-body col gap-12">
            <Setting label={tr('Description')}>
              <TextArea value={description} onChange={setDescription} rows={2} />
            </Setting>
            <Setting label={tr('Source')}>
              <Seg
                value={source.kind}
                onChange={(v) => setSource(v === 'url' ? { kind: 'url', url: d.source.url || '', everySeconds: d.source.everySeconds || 300, pointer: d.source.pointer || '' } : { kind: 'static' })}
                options={[
                  { value: 'static', label: tr('given here') },
                  { value: 'url', label: tr('from a source') },
                ]}
              />
            </Setting>
            {source.kind === 'url' ? (
              <>
                <Setting label={tr('Source url')} help={tr('answers a JSON object; a source that fails keeps the last values it gave')}>
                  <Input value={source.url} onChange={(v) => setSource({ ...source, url: v })} mono />
                </Setting>
                <Setting label={tr('Refreshed every (seconds)')}>
                  <NumberInput value={source.everySeconds} onChange={(v) => setSource({ ...source, everySeconds: v })} />
                </Setting>
                <Setting label={tr('JSON pointer')} help={tr('the object of the answer the values are taken from, e.g. /data; empty: the whole answer')}>
                  <Input value={source.pointer} onChange={(v) => setSource({ ...source, pointer: v })} mono placeholder="/data" />
                </Setting>
                <Setting label={tr('Headers')} help={tr('sent to the source — a token, for instance; kept sealed, never shown back')}>
                  {headers.map((h, i) => (
                    <div key={i} className="row">
                      <Input value={h.k} onChange={(v) => setHeaders(headers.map((x, j) => (j === i ? { ...x, k: v } : x)))} mono placeholder={tr('header')} aria-label={tr('header name {0}', [i + 1])} />
                      <Input value={h.v} onChange={(v) => setHeaders(headers.map((x, j) => (j === i ? { ...x, v } : x)))} mono type="password" placeholder={tr('value')} aria-label={tr('header value {0}', [i + 1])} />
                      <button className="btn ghost sm icon" aria-label={tr('remove the header')} onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
                        <Icon name="trash" />
                      </button>
                    </div>
                  ))}
                  <button className="btn sm" onClick={() => setHeaders([...headers, { k: '', v: '' }])}>
                    <Icon name="plus" /> {tr('Add a header')}
                  </button>
                </Setting>
              </>
            ) : (
              <>
                <div className="row">
                  <FileButton
                    className="btn sm"
                    accept={VALUE_FILES}
                    onFile={(t, file) => {
                      try {
                        setText(JSON.stringify(valuesOf(t, file), null, 2));
                        toast(tr('{0} imported: save to apply it', [file.name]));
                      } catch (e) {
                        toast(e.message, 'error');
                      }
                    }}
                  >
                    {tr('Replace with a local file…')}
                  </FileButton>
                </div>
                <CodeEditor value={text} onChange={setText} language="json" minHeight={260} maxHeight={560} ariaLabel={tr('values of the dictionary')} />
                {parseError && <Callout kind="negative">{parseError}</Callout>}
              </>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>{tr('In an expression')}</h3>
          </div>
          <div className="card-body col gap-8">
            <p className="muted small">
              <Tr text={'A plugin of any API reads a value with {0}, in a header, a body, an url: the gateway resolves it at each call, from its own config.'} args={[<code key="e">{d.expression}</code>]} />
            </p>
            {!keys.length && <span className="faint small">{tr('No value yet.')}</span>}
            {keys.length > 0 && <ListToolbar paging={keysPage} placeholder={tr('search keys, values')} />}
            {keys.length > 0 && !keysPage.items.length && <span className="faint small">{tr('No key matches.')}</span>}
            {keysPage.items.map(([k, v]) => {
              const expr = d.expression.replace('<key>', k);
              return (
                <div key={k} className="row small" title={expr}>
                  <code>{k}</code>
                  <span className="muted grow ellipsis">{String(v)}</span>
                  <CopyButton text={expr} className="btn xs ghost" />
                </div>
              );
            })}
          </div>
          {keys.length > 0 && <Pager paging={keysPage} total={keysPage.total} />}
        </div>
      </div>
    </div>
  );
}
