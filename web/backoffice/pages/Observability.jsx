import React, { useEffect, useState } from 'react';
import { useQuery, useRouter } from '../../shared/router.jsx';
import { fmtBytes, fmtDate, fmtNumber } from '../../shared/lib.js';
import { Badge, Callout, Empty, Icon, Input, Loader, Modal, Select, StatusBadge, Tabs, useLoad } from '../../shared/ui.jsx';
import { CodeView } from '../../shared/code-editor.jsx';
import { ListToolbar, Pager, ReloadButton, usePaging } from '../../shared/lists.jsx';
import { BarList, OTHER_COLOR, StackedColumns, StatTile, TimeSeries } from '../../shared/charts.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

// the timeframes of a dashboard: presets first, then a custom range
export const RANGES = [
  { value: '5m', label: tr('Last 5 minutes'), ms: 5 * 60e3 },
  { value: '30m', label: tr('Last 30 minutes'), ms: 30 * 60e3 },
  { value: '1h', label: tr('Last hour'), ms: 3600e3 },
  { value: '3h', label: tr('Last 3 hours'), ms: 3 * 3600e3 },
  { value: '6h', label: tr('Last 6 hours'), ms: 6 * 3600e3 },
  { value: '12h', label: tr('Last 12 hours'), ms: 12 * 3600e3 },
  { value: '24h', label: tr('Last 24 hours'), ms: 86400e3 },
  { value: '3d', label: tr('Last 3 days'), ms: 3 * 86400e3 },
  { value: '7d', label: tr('Last 7 days'), ms: 7 * 86400e3 },
  { value: '14d', label: tr('Last 14 days'), ms: 14 * 86400e3 },
  { value: '30d', label: tr('Last 30 days'), ms: 30 * 86400e3 },
  { value: '90d', label: tr('Last 90 days'), ms: 90 * 86400e3 },
  { value: '1y', label: tr('Last year'), ms: 365 * 86400e3 },
];
const REFRESHES = [
  { value: '', label: tr('Auto-refresh off') },
  { value: '10', label: tr('Every 10 seconds') },
  { value: '30', label: tr('Every 30 seconds') },
  { value: '60', label: tr('Every minute') },
  { value: '300', label: tr('Every 5 minutes') },
];
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'];

// the range a dashboard reads, from its url: a preset, or a custom range (from, to)
export function timeframe(params) {
  const range = params.get('range') || '24h';
  if (range === 'custom' && params.get('from'))
    return {
      range,
      from: params.get('from'),
      to: params.get('to') || new Date().toISOString(),
      ms: null,
    };
  const ms = RANGES.find((r) => r.value === range)?.ms || 86400e3;
  return { range, from: new Date(Date.now() - ms).toISOString(), to: null, ms };
}

// a datetime-local value, in the local time of the reader
const localInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
};

function TimeframePicker({ params, setParams, resetPage }) {
  const range = params.get('range') || '24h';
  const [from, setFrom] = useState(localInput(params.get('from')));
  const [to, setTo] = useState(localInput(params.get('to')));
  return (
    <>
      <Select
        value={range}
        onChange={(v) =>
          setParams({
            range: v,
            ...(v === 'custom' ? {} : { from: null, to: null }),
            ...resetPage,
          })
        }
        options={[...RANGES.map((r) => ({ value: r.value, label: r.label })), { value: 'custom', label: tr('Custom range…') }]}
        style={{ width: 190 }}
        aria-label={tr('timeframe')}
      />
      {range === 'custom' && (
        <span className="row gap-6">
          <input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={tr('from')} style={{ width: 200 }} />
          <span className="muted">→</span>
          <input className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} aria-label={tr('to')} style={{ width: 200 }} />
          <button
            className="btn sm"
            disabled={!from}
            onClick={() =>
              setParams({
                from: new Date(from).toISOString(),
                to: to ? new Date(to).toISOString() : null,
                ...resetPage,
              })
            }
          >
            {tr('Apply')}
          </button>
        </span>
      )}
    </>
  );
}

// refreshes the dashboard every few seconds, when asked
function useAutoRefresh(seconds, reloads) {
  useEffect(() => {
    if (!seconds) return;
    const t = setInterval(() => reloads.forEach((r) => r()), Number(seconds) * 1000);
    return () => clearInterval(t);
  }, [seconds]);
}

const fmtMs = (v) => (v === null || v === undefined ? '—' : `${fmtNumber(Math.round(v * 10) / 10)} ms`);
const perSecond = (v) => (v >= 10 ? fmtNumber(Math.round(v)) : v >= 0.01 ? String(Math.round(v * 100) / 100) : v > 0 ? '< 0.01' : '0');

function Card({ title, sub, span, children }) {
  return (
    <div className="card" style={span ? { gridColumn: `span ${span}` } : undefined}>
      <div className="card-head">
        <h3 className="grow">{title}</h3>
        {sub && <span className="faint small">{sub}</span>}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

// the hits of the first entities over time, the others folded into one gray series
function entitySeries(block, names) {
  const ids = block?.ids || [];
  const series = ids.map((id) => ({ key: id, label: names(id) }));
  if ((block?.points || []).some((p) => p.__other)) series.push({ key: '__other', label: tr('Other'), color: OTHER_COLOR });
  return series;
}

// the dashboard itself: the figures, the distributions over time, then the tops
export function Dashboard({ d, fixed = {}, loading = false }) {
  const rollups = d.source === 'rollups';
  const appName = (id) => d.byApplication.find((r) => r.application_id === id)?.name || id;
  const apiName = (id) => d.byApi.find((r) => r.api_id === id)?.name || id;
  const failed = d.byApi.filter((r) => r.server_errors > 0).sort((a, b) => b.server_errors - a.server_errors);
  const slowApis = [...d.byApi].filter((r) => r.calls > 0).sort((a, b) => b.avg_ms - a.avg_ms);
  const slowApps = [...d.byApplication].filter((r) => r.calls > 0).sort((a, b) => b.avg_ms - a.avg_ms);
  const t = d.totals;
  return (
    <div className="col gap-16" style={{ opacity: loading ? 0.6 : 1 }}>
      <div className="grid-3">
        <StatTile label={tr('Calls')} value={fmtNumber(t.calls)} hint={tr('{0} consuming applications', [t.applications])} />
        <StatTile label={tr('Requests per second')} value={perSecond(t.rps)} hint={tr('on average over the range')} />
        <StatTile
          label={tr('Errors')}
          value={fmtNumber(t.errors)}
          hint={t.calls ? tr('{0} % of calls · {1} server errors', [((100 * t.errors) / t.calls).toFixed(1), fmtNumber(t.server_errors)]) : ''}
        />
        <StatTile
          label={tr('Average latency')}
          value={fmtMs(t.avg_ms)}
          hint={rollups ? tr('the extremes are not kept by the rollups') : tr('min {0} · max {1}', [fmtMs(t.min_ms), fmtMs(t.max_ms)])}
        />
        <StatTile label={rollups ? tr('p95 latency ≈') : tr('p95 latency')} value={fmtMs(t.p95_ms)} hint={tr('gateway overhead {0} on average', [fmtMs(t.avg_overhead_ms)])} />
        <StatTile label={tr('Data')} value={fmtBytes(t.bytes_out)} hint={tr('out · {0} in', [fmtBytes(t.bytes_in)])} />
      </div>
      {rollups && (
        <Callout kind="info">
          <Tr
            text={'Each call is kept {0} days: before {1}, this range is read from the hourly rollups — its counts are exact, its percentiles approximate, its paths templated.'}
            args={[d.retention.callsDays, fmtDate(d.retention.from)]}
          />
        </Callout>
      )}
      {!t.calls ? (
        <div className="card">
          <div className="empty small">{tr('No call in this period, for these filters.')}</div>
        </div>
      ) : (
        <>
          <Card title={tr('Responses over time')}>
            <StackedColumns
              data={d.series}
              bucket={d.range.bucket}
              series={[
                { key: 'success', label: tr('Success (below 400)') },
                { key: 'client_errors', label: tr('Client errors (4xx)') },
                {
                  key: 'server_errors',
                  label: tr('Server errors (5xx, gateway failures)'),
                },
              ]}
            />
          </Card>
          <Card title={tr('Latency over time')} sub={rollups ? tr('average only: the percentiles of a bucket are not kept by the rollups') : null}>
            <TimeSeries
              data={d.series}
              bucket={d.range.bucket}
              formatValue={fmtMs}
              series={[
                { key: 'avg_ms', label: tr('Average') },
                ...(rollups ? [] : [{ key: 'p95_ms', label: tr('p95') }]),
                { key: 'avg_overhead_ms', label: tr('Gateway overhead') },
              ]}
            />
          </Card>
          {(!fixed.application || !fixed.api) && (
            <div className="grid-2">
              {!fixed.application && (
                <Card title={tr('Hits by application')}>
                  <TimeSeries data={d.seriesByApplication.points} bucket={d.range.bucket} series={entitySeries(d.seriesByApplication, appName)} />
                </Card>
              )}
              {!fixed.api && (
                <Card title={tr('Hits by API')}>
                  <TimeSeries data={d.seriesByApi.points} bucket={d.range.bucket} series={entitySeries(d.seriesByApi, apiName)} />
                </Card>
              )}
            </div>
          )}
          <div className="grid-3">
            {!fixed.api && (
              <>
                <Card title={tr('Top APIs')} sub={tr('by calls')}>
                  <BarList
                    items={d.byApi.map((r) => ({
                      label: r.name,
                      value: r.calls,
                      sub: r.errors ? tr('{0} err', [r.errors]) : '',
                    }))}
                  />
                </Card>
                <Card title={tr('Top failed APIs')} sub={tr('by server errors')}>
                  <BarList
                    items={failed.map((r) => ({
                      label: r.name,
                      value: r.server_errors,
                    }))}
                    empty={tr('No server error')}
                  />
                </Card>
                <Card title={tr('Top slow APIs')} sub={tr('by average latency')}>
                  <BarList
                    items={slowApis.map((r) => ({
                      label: r.name,
                      value: r.avg_ms,
                    }))}
                    formatValue={fmtMs}
                  />
                </Card>
              </>
            )}
            {!fixed.application && (
              <>
                <Card title={tr('Top applications')} sub={tr('by calls')}>
                  <BarList
                    items={d.byApplication.map((r) => ({
                      label: r.name,
                      value: r.calls,
                      sub: r.errors ? tr('{0} err', [r.errors]) : '',
                    }))}
                  />
                </Card>
                <Card title={tr('Top slow applications')} sub={tr('by average latency')}>
                  <BarList
                    items={slowApps.map((r) => ({
                      label: r.name,
                      value: r.avg_ms,
                    }))}
                    formatValue={fmtMs}
                  />
                </Card>
              </>
            )}
            <Card title={tr('By plan')}>
              <BarList
                items={d.byPlan.map((r) => ({
                  label: fixed.api ? r.plan_name : `${r.api_name} · ${r.plan_name}`,
                  value: r.calls,
                }))}
              />
            </Card>
            <Card title={tr('Status codes')}>
              <BarList
                items={d.statuses.map((r) => ({
                  label: r.class ? tr('{0}xx', [r.class / 100]) : tr('no status'),
                  value: r.calls,
                }))}
              />
            </Card>
            <Card title={tr('Top hosts')}>
              {d.byHost ? (
                <BarList
                  items={d.byHost.map((r) => ({
                    label: r.host,
                    value: r.calls,
                  }))}
                />
              ) : (
                <div className="muted small">{tr('The hosts are not kept by the rollups.')}</div>
              )}
            </Card>
            <Card title={tr('Top endpoints')} sub={tr('templated paths')} span={2}>
              <BarList
                items={d.byPath.map((r) => ({
                  label: `${r.method || ''} ${r.path || ''}`.trim(),
                  value: r.calls,
                  sub: tr('{0} ms', [fmtNumber(Math.round(r.avg_ms))]),
                }))}
              />
            </Card>
            <Card title={tr('Top paths')} sub={tr('as called')}>
              {d.byRawPath ? (
                <BarList
                  items={d.byRawPath.map((r) => ({
                    label: `${r.method || ''} ${r.path || ''}`.trim(),
                    value: r.calls,
                  }))}
                />
              ) : (
                <div className="muted small">{tr('The rollups keep the templated paths only.')}</div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// the filters of the analytics, from the url — shared by the dashboards and the request log, so
// that going from one to the other keeps the slice
function useAnalyticsFilters(fixed = {}) {
  const [params, setParams] = useQuery();
  const tf = timeframe(params);
  const f = {
    api: fixed.api || params.get('api') || '',
    plan: params.get('plan') || '',
    application: fixed.application || params.get('application') || '',
    status: params.get('status') || '',
    refresh: params.get('refresh') || '',
  };
  const key = [tf.range, tf.ms ? '' : `${tf.from}|${tf.to}`, f.api, f.plan, f.application, f.status].join('|');
  const query = (extra = {}) => {
    const { from, to } = timeframe(params);
    const q = new URLSearchParams({ from });
    if (to) q.set('to', to);
    for (const k of ['api', 'plan', 'application', 'status']) if (f[k]) q.set(k, f[k]);
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    return q.toString();
  };
  return { params, setParams, tf, f, key, query };
}

// one row of filters, above everything it scopes
function FilterBar({ fixed = {}, filters, reset, children }) {
  const { wapi, slug } = useWs();
  const { params, setParams, f } = filters;
  const apis = useLoad(() => (fixed.api ? Promise.resolve([]) : wapi.get('/apis')), [slug]);
  const apps = useLoad(() => (fixed.application ? Promise.resolve([]) : wapi.get('/applications')), [slug]);
  // the plans of the api the view is on, or filtered on
  const plans = useLoad(() => (f.api ? wapi.get(`/apis/${f.api}`).then((a) => a.draft.plans) : Promise.resolve([])), [f.api]);
  return (
    <div className="row wrap">
      <TimeframePicker params={params} setParams={setParams} resetPage={reset} />
      {!fixed.api && (
        <Select
          value={f.api}
          onChange={(v) => setParams({ api: v, plan: null, ...reset })}
          options={[{ value: '', label: tr('All APIs') }, ...(apis.data || []).map((a) => ({ value: a.id, label: `${a.name} ${a.version}` }))]}
          style={{ width: 200 }}
          aria-label={tr('filter by api')}
        />
      )}
      {f.api && (
        <Select
          value={f.plan}
          onChange={(v) => setParams({ plan: v, ...reset })}
          options={[{ value: '', label: tr('All plans') }, ...(plans.data || []).map((p) => ({ value: p.id, label: p.name }))]}
          style={{ width: 170 }}
          aria-label={tr('filter by plan')}
        />
      )}
      {!fixed.application && (
        <Select
          value={f.application}
          onChange={(v) => setParams({ application: v, ...reset })}
          options={[{ value: '', label: tr('All applications') }, ...(apps.data || []).map((a) => ({ value: a.id, label: a.name }))]}
          style={{ width: 200 }}
          aria-label={tr('filter by application')}
        />
      )}
      <Select
        value={f.status}
        onChange={(v) => setParams({ status: v, ...reset })}
        options={[{ value: '', label: tr('All statuses') }, ...STATUS_CLASSES.map((c) => ({ value: c, label: c }))]}
        style={{ width: 140 }}
        aria-label={tr('filter by status')}
      />
      {children}
    </div>
  );
}

// the request log of the observability page, with the filters of the view it comes from
function logsPath(slug, fixed, filters) {
  const q = new URLSearchParams(filters.params);
  q.set('view', 'logs');
  if (fixed.api) q.set('api', fixed.api);
  if (fixed.application) q.set('application', fixed.application);
  for (const k of ['calls_page', 'calls_q', 'tab']) q.delete(k);
  return `/ws/${slug}/observability?${q}`;
}

// dashboards speak the catalogue's vocabulary: apis, plans, applications — not routes.
// Filters live in the url, so a filtered view is a bookmark; they scope everything below them.
export function AnalyticsDashboard({ fixed = {} }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const filters = useAnalyticsFilters(fixed);
  const state = useLoad(() => wapi.get(`/analytics?${filters.query()}`), [slug, filters.key]);
  useAutoRefresh(filters.f.refresh, [state.reload]);
  return (
    <div className="col gap-16">
      <FilterBar fixed={fixed} filters={filters} reset={{}}>
        <span className="spacer" />
        <Select value={filters.f.refresh} onChange={(v) => filters.setParams({ refresh: v })} options={REFRESHES} style={{ width: 170 }} aria-label={tr('auto-refresh')} />
        <ReloadButton onReload={state.reload} loading={state.loading} />
        <button className="btn sm" onClick={() => navigate(logsPath(slug, fixed, filters))}>
          <Icon name="doc" /> {tr('View the logs')}
        </button>
      </FilterBar>
      <Loader state={state}>{(d) => <Dashboard d={d} fixed={fixed} loading={state.loading} />}</Loader>
    </div>
  );
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// The request log: the calls themselves, as far back as they are kept, filtered like the dashboards
// and by their own fields; one call in detail; the filtered calls exported as CSV. Reading it, and
// exporting it, is traced in the audit trail: it is personal data.
export function RequestLog({ fixed = {} }) {
  const { wapi, slug } = useWs();
  const filters = useAnalyticsFilters(fixed);
  const { params, setParams } = filters;
  const method = params.get('method') || '';
  const client = params.get('client') || '';
  const [path, setPath] = useState(params.get('path') || '');
  useEffect(() => setPath(params.get('path') || ''), [params.get('path')]);
  const paging = usePaging({ prefix: 'calls', size: 50 });
  const own = { method, path: params.get('path') || '', client };
  const calls = useLoad(() => wapi.get(`/analytics/calls?${filters.query(own)}&${paging.query}`), [slug, filters.key, method, own.path, client, paging.key]);
  useAutoRefresh(filters.f.refresh, [calls.reload]);
  const [open, setOpen] = useState(null);
  const reset = { calls_page: null };
  const exportUrl = `/backoffice/api/workspaces/${slug}/analytics/calls/export?${filters.query({ ...own, q: paging.q })}`;
  return (
    <div className="col gap-16">
      <FilterBar fixed={fixed} filters={filters} reset={reset}>
        <Select
          value={method}
          onChange={(v) => setParams({ method: v, ...reset })}
          options={[{ value: '', label: tr('All methods') }, ...METHODS.map((m) => ({ value: m, label: m }))]}
          style={{ width: 140 }}
          aria-label={tr('filter by method')}
        />
        <form
          className="row gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            setParams({ path: path || null, ...reset });
          }}
        >
          <Input value={path} onChange={setPath} placeholder={tr('path contains…')} mono aria-label={tr('filter by path')} style={{ width: 200 }} />
        </form>
        {client && (
          <button className="btn ghost sm" onClick={() => setParams({ client: null, ...reset })}>
            {tr('Client {0} ×', [client])}
          </button>
        )}
        <span className="spacer" />
        <Select value={filters.f.refresh} onChange={(v) => setParams({ refresh: v })} options={REFRESHES} style={{ width: 170 }} aria-label={tr('auto-refresh')} />
        <a className="btn sm" href={exportUrl} download>
          <Icon name="download" /> {tr('Export as CSV')}
        </a>
      </FilterBar>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{tr('Request log')}</h3>
          <span className="faint small">
            {calls.data?.retention ? tr('each call is kept {0} days · ', [calls.data.retention.callsDays]) : ''}
            {tr('reading and exporting it are traced in the audit trail')}
          </span>
        </div>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <ListToolbar paging={paging} placeholder={tr('search path, method, status, host, client id, address, request id')} onReload={calls.reload} loading={calls.loading} />
        </div>
        <Loader state={calls}>
          {({ items: rows, total }) =>
            rows.length ? (
              <>
                <div className="table-wrap" style={{ opacity: calls.loading ? 0.6 : 1 }}>
                  <table className="table small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <thead>
                      <tr>
                        <th>{tr('Time')}</th>
                        <th>{tr('Request')}</th>
                        <th>{tr('Status')}</th>
                        <th className="right">{tr('Duration')}</th>
                        {!fixed.api && <th>{tr('API')}</th>}
                        <th>{tr('Plan')}</th>
                        {!fixed.application && <th>{tr('Consumer')}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className="clickable" onClick={() => setOpen(r)}>
                          <td className="nowrap muted">{fmtDate(r.at)}</td>
                          <td className="mono">
                            {r.method} {r.path}
                          </td>
                          <td>
                            <StatusBadge status={r.status >= 500 || r.err ? 'error' : r.status >= 400 ? 'pending' : 'active'} label={String(r.status ?? '—')} />
                          </td>
                          <td className="right">{fmtMs(r.duration_ms)}</td>
                          {!fixed.api && <td>{r.api_name || '—'}</td>}
                          <td>{r.plan_name || '—'}</td>
                          {!fixed.application && <td className="mono faint">{r.application_name || r.client_id || r.from_ip || '—'}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager paging={paging} total={total} />
              </>
            ) : (
              <div className="card-body muted small">
                {paging.q || method || own.path || client || filters.f.status
                  ? tr('No call matches.')
                  : tr('No call in this period. Install the data exporter from the Gateway page to feed the ingester.')}
              </div>
            )
          }
        </Loader>
      </div>
      {open && <CallDetail call={open} onClose={() => setOpen(null)} onClient={(id) => (setOpen(null), setParams({ client: id, ...reset }))} />}
    </div>
  );
}

// one call: what it was, who made it, how long it took and where the time went
function CallDetail({ call, onClose, onClient }) {
  const rows = [
    [tr('Time'), fmtDate(call.at)],
    [tr('Request id'), call.req_id ? <code>{call.req_id}</code> : '—'],
    [tr('Host'), call.host || '—'],
    [tr('API'), call.api_name || '—'],
    [tr('Plan'), call.plan_name || '—'],
    [tr('Application'), call.application_name || '—'],
    [
      tr('Client id'),
      call.client_id ? (
        <button className="btn ghost xs mono" onClick={() => onClient(call.client_id)}>
          {call.client_id}
        </button>
      ) : (
        '—'
      ),
    ],
    [tr('Caller address'), call.from_ip || '—'],
    [tr('User agent'), call.user_agent || '—'],
    [tr('Duration'), fmtMs(call.duration_ms)],
    [tr('Backend'), fmtMs(call.backend_duration_ms)],
    [tr('Gateway overhead'), fmtMs(call.overhead_ms)],
    [tr('Data'), tr('{0} in · {1} out', [fmtBytes(call.bytes_in || 0), fmtBytes(call.bytes_out || 0)])],
  ];
  return (
    <Modal title={`${call.method} ${call.path} — ${call.status ?? '—'}${call.err ? ` · ${tr('gateway failure')}` : ''}`} size="wide" onClose={onClose}>
      {call.req_id && (
        <p className="small muted">
          <Tr text={'Request id {0} — the Otoroshi-Request-Id the caller got back and the backend received'} args={[<code key="id">{call.req_id}</code>]} />
        </p>
      )}
      <dl className="kv">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      <details className="mt-16">
        <summary className="small">{tr('As stored')}</summary>
        <CodeView value={call} maxHeight={420} ariaLabel={tr('call')} />
      </details>
    </Modal>
  );
}

// the actions of the Threat Protection Suite that refused or rewrote a call
const REFUSING = ['deny', 'ban', 'mask'];

// The security events of the Threat Protection Suite (otoroshi-waf-extension), attributed to the
// catalogue: what it judged, on which api and plan, and what it did. The plan comes from the key that
// called: a keyless caller, or one refused before it was identified, has the api only.
export function SecurityEvents({ fixed = {} }) {
  const { wapi, slug } = useWs();
  const [params, setParams] = useQuery();
  const tf = timeframe(params);
  const range = tf.range;
  const apiFilter = fixed.api || params.get('api') || '';
  const category = params.get('category') || '';
  const action = params.get('action') || '';
  const paging = usePaging({ prefix: 'security', size: 25 });
  const qs = () => {
    const { from, to } = timeframe(params);
    const q = new URLSearchParams({ from });
    if (to) q.set('to', to);
    if (apiFilter) q.set('api', apiFilter);
    if (category) q.set('category', category);
    if (action) q.set('action', action);
    return q.toString();
  };
  const state = useLoad(() => wapi.get(`/analytics/security?${qs()}&${paging.query}`), [slug, range, tf.ms ? '' : `${tf.from}|${tf.to}`, apiFilter, category, action, paging.key]);
  const apis = useLoad(() => (fixed.api ? Promise.resolve([]) : wapi.get('/apis')), [slug]);
  const [open, setOpen] = useState(null);
  return (
    <div className="col gap-16">
      <div className="row wrap">
        {!fixed.api && <TimeframePicker params={params} setParams={setParams} resetPage={{ security_page: null }} />}
        {!fixed.api && (
          <Select
            value={apiFilter}
            onChange={(v) => setParams({ api: v, security_page: null })}
            options={[
              { value: '', label: tr('All APIs') },
              ...(apis.data || []).map((a) => ({
                value: a.id,
                label: `${a.name} ${a.version}`,
              })),
            ]}
            style={{ width: 220 }}
            aria-label={tr('filter by api')}
          />
        )}
        {(category || action) && (
          <button className="btn ghost sm" onClick={() => setParams({ category: null, action: null, security_page: null })}>
            {tr('Clear the filters: {0}', [[category, action].filter(Boolean).join(', ')])}
          </button>
        )}
        <span className="spacer" />
        <ReloadButton onReload={state.reload} loading={state.loading} />
      </div>
      <Loader state={state}>
        {(d) => {
          const refused = d.byAction.filter((r) => REFUSING.includes(r.action)).reduce((n, r) => n + r.events, 0);
          return (
            <div className="col gap-16" style={{ opacity: state.loading ? 0.6 : 1 }}>
              <div className="grid-3">
                <StatTile label={tr('Security events')} value={fmtNumber(d.events)} hint={tr('kept {0} days, like the calls', [d.retention.days])} />
                <StatTile label={tr('Refused or masked')} value={fmtNumber(refused)} hint={d.events ? tr('{0} % of the events', [((100 * refused) / d.events).toFixed(1)]) : ''} />
                <StatTile label={tr('Categories')} value={fmtNumber(d.byCategory.length)} hint={d.byCategory[0] ? tr('most: {0}', [d.byCategory[0].category]) : ''} />
              </div>
              <div className="grid-3">
                <div className="card">
                  <div className="card-head">
                    <h3>{tr('By category')}</h3>
                  </div>
                  <div className="card-body">
                    <BarList
                      items={d.byCategory.map((r) => ({
                        label: r.category,
                        value: r.events,
                      }))}
                    />
                  </div>
                </div>
                <div className="card">
                  <div className="card-head">
                    <h3>{tr('By action')}</h3>
                  </div>
                  <div className="card-body">
                    <BarList
                      items={d.byAction.map((r) => ({
                        label: r.action,
                        value: r.events,
                      }))}
                    />
                  </div>
                </div>
                <div className="card">
                  <div className="card-head">
                    <h3>{tr('By plan')}</h3>
                  </div>
                  <div className="card-body">
                    <BarList
                      items={d.byPlan.map((r) => ({
                        label: `${fixed.api ? '' : `${r.api_name} · `}${r.plan_id ? r.plan_name : tr('(no plan: caller not identified)')}`,
                        value: r.events,
                      }))}
                    />
                  </div>
                </div>
              </div>
              <div className="card">
                <div className="card-head">
                  <h3 className="grow">{tr('Recent security events')}</h3>
                  <span className="faint small">{tr('they carry the address of the caller: reading them is traced in the audit trail')}</span>
                </div>
                {d.events > 0 && (
                  <div className="card-body" style={{ paddingBottom: 0 }}>
                    <ListToolbar paging={paging} placeholder={tr('search categories, actions, messages, callers, addresses')} />
                  </div>
                )}
                {d.items.length ? (
                  <>
                    <div className="table-wrap">
                      <table className="table small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        <thead>
                          <tr>
                            <th>{tr('Time')}</th>
                            <th>{tr('Category')}</th>
                            <th>{tr('Action')}</th>
                            <th className="right">{tr('Score')}</th>
                            {!fixed.api && <th>{tr('API')}</th>}
                            <th>{tr('Caller')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.items.map((r) => (
                            <tr key={r.id} className="clickable" onClick={() => setOpen(r)}>
                              <td className="nowrap muted">{fmtDate(r.at)}</td>
                              <td>
                                <button
                                  className="btn ghost sm"
                                  onClick={(e) => (
                                    e.stopPropagation(),
                                    setParams({
                                      category: r.category,
                                      security_page: null,
                                    })
                                  )}
                                >
                                  {r.category}
                                </button>
                              </td>
                              <td>
                                <Badge kind={REFUSING.includes(r.action) ? 'negative' : r.action === 'log' || r.action === 'allow' ? '' : 'warning'}>{r.action}</Badge>
                              </td>
                              <td className="right">{r.score ?? '—'}</td>
                              {!fixed.api && <td>{r.api_name || '—'}</td>}
                              <td className="mono faint">{r.application_name || r.client_id || r.from_ip || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Pager paging={paging} total={d.total} />
                  </>
                ) : paging.q ? (
                  <Empty title={tr('No security event matches')} icon="search" />
                ) : (
                  <div className="card-body muted small">
                    {tr(
                      'No security event in this period: the Threat Protection Suite reports here once a plan carries it (plan › Threat protection) and the data exporter of the setup is installed.',
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        }}
      </Loader>
      {open && (
        <Modal title={`${open.category} — ${open.action}`} size="wide" onClose={() => setOpen(null)}>
          <p className="muted small">{[fmtDate(open.at), open.api_name, open.application_name, open.message].filter(Boolean).join(' · ')}</p>
          <CodeView value={open} maxHeight={520} ariaLabel={tr('security event')} />
        </Modal>
      )}
    </div>
  );
}

export function ObservabilityPage() {
  const [params, setParams] = useQuery();
  const view = ['security', 'logs'].includes(params.get('view')) ? params.get('view') : 'usage';
  return (
    <div className="page">
      <PageHead
        title={tr('Observability')}
        sub={tr("Usage of the catalogue, from the ingester's computed path — exhaustive, attributed to apis, plans and applications at ingestion.")}
      />
      <Tabs
        value={view}
        onChange={(v) => setParams({ view: v === 'usage' ? null : v })}
        tabs={[
          { id: 'usage', label: tr('Usage') },
          { id: 'logs', label: tr('Logs') },
          { id: 'security', label: tr('Security') },
        ]}
      />
      {view === 'security' ? <SecurityEvents /> : view === 'logs' ? <RequestLog /> : <AnalyticsDashboard />}
    </div>
  );
}
