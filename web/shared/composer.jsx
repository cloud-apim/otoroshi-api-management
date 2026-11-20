// The request composer: one component, two execution contexts — the console replays a
// request through its own api, the portal tries an api with the consumer's credentials.
import React, { useState } from 'react';
import { Badge, Callout, Code, Field, Icon, Select } from './ui.jsx';
import { CodeEditor, CodeView, codeLanguage } from './code-editor.jsx';
import { tr, Tr } from './i18n.jsx';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function bodyLanguage(headers) {
  const ct = headers?.['content-type'] || '';
  if (ct.includes('json')) return 'json';
  if (ct.includes('yaml')) return 'yaml';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  return 'plaintext';
}

function pretty(body, headers) {
  const ct = headers?.['content-type'] || '';
  if (ct.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch (e) {}
  }
  return body;
}

const RESULT_KIND = { allowed: 'positive', successful: 'positive', denied: 'negative', failure: 'negative' };

// the execution report of the call, as the gateway ran it: the consumer it identified, then each
// step that ran plugins, each plugin with its outcome
function TraceView({ trace }) {
  return (
    <div className="col gap-8">
      <div className="label">{tr('Execution trace')}</div>
      {trace.consumer ? (
        <p className="small">
          <Tr text={'Identified as {0}'} args={[<span className="mono">{trace.consumer.client_id}</span>]} />
          {trace.consumer.plan_id && <span className="faint"> · <Tr text={'plan {0}'} args={[<span className="mono">{trace.consumer.plan_id}</span>]} /></span>}
        </p>
      ) : (
        <p className="small muted">{tr('No consumer identified.')}</p>
      )}
      {trace.steps.map((s) => (
        <div key={s.step} className="col gap-4">
          <div className="tiny faint mono">{s.step}</div>
          {s.plugins.map((p, i) => (
            <div key={i} className="row small">
              <span className="grow" title={p.plugin}>
                {p.name}
              </span>
              {p.result && <Badge kind={RESULT_KIND[p.result] || ''}>{p.status ? `${p.result} ${p.status}` : p.result}</Badge>}
              <span className="faint tiny"><Tr text={'{0} ms'} args={[p.durationMs]} /></span>
            </div>
          ))}
        </div>
      ))}
      <p className="faint tiny"><Tr text={'{0} ms in the gateway, {1} of overhead — sent by the gateway itself, from 127.0.0.1'} args={[trace.durationMs, `${trace.overheadMs} ms`]} /></p>
    </div>
  );
}

export function RequestComposer({ send, credentials = [], paths = [], baseLabel = '', labels = {} }) {
  const L = {
    send: tr('Send'),
    credential: tr('Credentials'),
    none: tr('No credential'),
    headers: tr('Headers'),
    body: tr('Body'),
    response: tr('Response'),
    ...labels,
  };
  const [req, setReq] = useState({ method: 'GET', path: paths[0] || '/', query: '', headers: [{ k: 'accept', v: 'application/json' }], body: '', credential: credentials[0]?.value || '' });
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setReq((r) => ({ ...r, ...patch }));
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const headers = Object.fromEntries(req.headers.filter((h) => h.k).map((h) => [h.k, h.v]));
      setRes(await send({ method: req.method, path: req.path, query: req.query, headers, body: req.body, credential: req.credential }));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };
  const statusKind = !res ? '' : res.status < 300 ? 'positive' : res.status < 400 ? 'info' : res.status < 500 ? 'warning' : 'negative';
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <form className="card" onSubmit={submit}>
        <div className="card-body col">
          <div className="row">
            <select className="select" style={{ width: 120 }} value={req.method} onChange={(e) => set({ method: e.target.value })} aria-label={tr('method')}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <div className="grow" style={{ position: 'relative' }}>
              <input className="input mono" list="composer-paths" value={req.path} onChange={(e) => set({ path: e.target.value })} aria-label={tr('path')} />
              <datalist id="composer-paths">
                {paths.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            <button className="btn primary" disabled={busy} type="submit">
              {busy ? <span className="spinner" /> : <Icon name="play" />} {L.send}
            </button>
          </div>
          {baseLabel && (
            <div className="mono tiny faint">
              {baseLabel}
              {req.path}
              {req.query ? `?${req.query}` : ''}
            </div>
          )}
          <input className="input mono" placeholder={tr('query string, e.g. page=2&size=10')} value={req.query} onChange={(e) => set({ query: e.target.value })} aria-label={tr('query string')} />
          <Field label={L.credential}>
            <Select value={req.credential} onChange={(v) => set({ credential: v })} options={[{ value: '', label: L.none }, ...credentials]} />
          </Field>
          <div className="label">{L.headers}</div>
          {req.headers.map((h, i) => (
            <div key={i} className="row">
              <input className="input mono" value={h.k} placeholder={tr('header')} onChange={(e) => set({ headers: req.headers.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)) })} aria-label={tr('header name')} />
              <input className="input mono" value={h.v} placeholder={tr('value')} onChange={(e) => set({ headers: req.headers.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)) })} aria-label={tr('header value')} />
              <button type="button" className="btn ghost sm icon" onClick={() => set({ headers: req.headers.filter((_, j) => j !== i) })} aria-label={tr('remove header')}>
                <Icon name="x" />
              </button>
            </div>
          ))}
          <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => set({ headers: [...req.headers, { k: '', v: '' }] })}>
            <Icon name="plus" /> {tr('header')}
          </button>
          {!['GET', 'HEAD'].includes(req.method) && (
            <Field label={L.body}>
              <CodeEditor value={req.body} onChange={(v) => set({ body: v })} language={codeLanguage(req.body) === 'json' ? 'json' : 'plaintext'} minHeight={120} maxHeight={320} ariaLabel={tr('request body')} />
            </Field>
          )}
        </div>
      </form>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{L.response}</h3>
          {res && (
            <>
              <Badge kind={statusKind}>{res.status}</Badge>
              <span className="faint small"><Tr text={'{0} ms'} args={[res.durationMs]} /></span>
            </>
          )}
        </div>
        <div className="card-body col">
          {error && <Callout kind="negative">{error}</Callout>}
          {!res && !error && <p className="muted small">{tr('Send a request to see the response.')}</p>}
          {res && (
            <>
              <details>
                <summary className="small link"><Tr text={'{0} response headers'} args={[Object.keys(res.headers || {}).length]} /></summary>
                <div className="mt-8">
                  <dl className="kv mono tiny">
                    {Object.entries(res.headers || {}).map(([k, v]) => (
                      <React.Fragment key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </div>
              </details>
              {res.body ? <CodeView value={pretty(res.body, res.headers)} language={bodyLanguage(res.headers)} maxHeight={480} ariaLabel={tr('response body')} /> : <p className="muted small">{tr('(empty body)')}</p>}
              {res.truncated && <p className="faint tiny">{tr('body truncated to 256 KB')}</p>}
              {res.trace && <TraceView trace={res.trace} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
