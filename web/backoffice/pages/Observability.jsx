import React, { useState } from 'react';
import { useQuery } from '../../shared/router.jsx';
import { fmtBytes, fmtDate, fmtNumber } from '../../shared/lib.js';
import { Loader, Modal, Seg, Select, StatusBadge, useLoad } from '../../shared/ui.jsx';
import { CodeView } from '../../shared/code-editor.jsx';
import { ListToolbar, Pager, ReloadButton, usePaging } from '../../shared/lists.jsx';
import { BarList, StatTile, TimeSeries } from '../../shared/charts.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

const RANGES = [
  { value: '1h', label: tr('1h'), ms: 3600e3 },
  { value: '24h', label: tr('24h'), ms: 86400e3 },
  { value: '7d', label: tr('7 days'), ms: 7 * 86400e3 },
  { value: '30d', label: tr('30 days'), ms: 30 * 86400e3 },
];

// dashboards speak the catalogue's vocabulary: apis, plans, applications — not routes.
// Filters live in the url, so a filtered view is a bookmark.
export function AnalyticsDashboard({ fixed = {} }) {
  const { wapi, slug } = useWs();
  const [params, setParams] = useQuery();
  const range = params.get('range') || '24h';
  const apiFilter = fixed.api || params.get('api') || '';
  const appFilter = fixed.application || params.get('application') || '';
  const ms = RANGES.find((r) => r.value === range)?.ms || 86400e3;
  const qs = () => {
    const q = new URLSearchParams({ from: new Date(Date.now() - ms).toISOString() });
    if (apiFilter) q.set('api', apiFilter);
    if (appFilter) q.set('application', appFilter);
    return q.toString();
  };
  const state = useLoad(() => wapi.get(`/analytics?${qs()}`), [slug, range, apiFilter, appFilter]);
  const paging = usePaging({ prefix: 'calls', size: 25 });
  const calls = useLoad(() => wapi.get(`/analytics/calls?${qs()}&${paging.query}`), [slug, range, apiFilter, appFilter, paging.key]);
  const [open, setOpen] = useState(null);
  const nameOf = (list, id) => (list.data || []).find((x) => x.id === id);
  const apis = useLoad(() => (fixed.api ? Promise.resolve([]) : wapi.get('/apis')), [slug]);
  const apps = useLoad(() => (fixed.application ? Promise.resolve([]) : wapi.get('/applications')), [slug]);
  return (
    <div className="col gap-16">
      <div className="row wrap">
        <Seg value={range} onChange={(v) => setParams({ range: v, calls_page: null })} options={RANGES} />
        {!fixed.api && (
          <Select
            value={apiFilter}
            onChange={(v) => setParams({ api: v, calls_page: null })}
            options={[{ value: '', label: tr('All APIs') }, ...(apis.data || []).map((a) => ({ value: a.id, label: `${a.name} ${a.version}` }))]}
            style={{ width: 220 }}
            aria-label={tr('filter by api')}
          />
        )}
        {!fixed.application && (
          <Select
            value={appFilter}
            onChange={(v) => setParams({ application: v, calls_page: null })}
            options={[{ value: '', label: tr('All applications') }, ...(apps.data || []).map((a) => ({ value: a.id, label: a.name }))]}
            style={{ width: 220 }}
            aria-label={tr('filter by application')}
          />
        )}
        <span className="grow" />
        <ReloadButton
          onReload={() => {
            state.reload();
            calls.reload();
          }}
          loading={state.loading || calls.loading}
        />
      </div>
      <Loader state={state}>
        {(d) => (
          <div className="col gap-16" style={{ opacity: state.loading ? 0.6 : 1 }}>
            <div className="grid-4">
              <StatTile label={tr('Calls')} value={fmtNumber(d.totals.calls)} hint={tr('{0} consuming applications', [d.totals.applications])} />
              <StatTile label={tr('Errors')} value={fmtNumber(d.totals.errors)} hint={d.totals.calls ? tr('{0} % of calls', [((100 * d.totals.errors) / d.totals.calls).toFixed(1)]) : ''} />
              <StatTile label={tr('Latency')} value={`${fmtNumber(d.totals.avg_ms)} ms`} hint={tr('p95 {0} ms · gateway overhead {1} ms', [fmtNumber(d.totals.p95_ms), fmtNumber(d.totals.avg_overhead_ms)])} />
              <StatTile label={tr('Data')} value={fmtBytes(d.totals.bytes_out)} hint={tr('out · {0} in', [fmtBytes(d.totals.bytes_in)])} />
            </div>
            <div className="card">
              <div className="card-head">
                <h3 className="grow">{tr('Traffic')}</h3>
              </div>
              <div className="card-body">
                <TimeSeries data={d.series} bucket={d.range.bucket} series={[{ key: 'calls', label: tr('Calls') }, { key: 'errors', label: tr('Errors') }]} />
              </div>
            </div>
            <div className="grid-3">
              {!fixed.api && (
                <div className="card">
                  <div className="card-head">
                    <h3>{tr('By API')}</h3>
                  </div>
                  <div className="card-body">
                    <BarList items={d.byApi.map((r) => ({ label: r.name, value: r.calls, sub: r.errors ? tr('{0} err', [r.errors]) : '' }))} />
                  </div>
                </div>
              )}
              <div className="card">
                <div className="card-head">
                  <h3>{tr('By plan')}</h3>
                </div>
                <div className="card-body">
                  <BarList items={d.byPlan.map((r) => ({ label: fixed.api ? r.plan_name : `${r.api_name} · ${r.plan_name}`, value: r.calls }))} />
                </div>
              </div>
              {!fixed.application && (
                <div className="card">
                  <div className="card-head">
                    <h3>{tr('By application')}</h3>
                  </div>
                  <div className="card-body">
                    <BarList items={d.byApplication.map((r) => ({ label: r.name, value: r.calls, sub: r.errors ? tr('{0} err', [r.errors]) : '' }))} />
                  </div>
                </div>
              )}
              <div className="card">
                <div className="card-head">
                  <h3>{tr('Status codes')}</h3>
                </div>
                <div className="card-body">
                  <BarList items={d.statuses.map((r) => ({ label: tr('{0}xx', [r.class / 100]), value: r.calls }))} />
                </div>
              </div>
              <div className="card" style={{ gridColumn: 'span 2' }}>
                <div className="card-head">
                  <h3>{tr('Top endpoints')}</h3>
                </div>
                <div className="card-body">
                  <BarList items={d.byPath.map((r) => ({ label: `${r.method} ${r.path}`, value: r.calls, sub: tr('{0} ms', [fmtNumber(r.avg_ms)]) }))} />
                </div>
              </div>
            </div>
          </div>
        )}
      </Loader>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{tr('Recent calls')}</h3>
          <span className="faint small">{tr('reading request logs is traced in the audit trail')}</span>
        </div>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <ListToolbar paging={paging} placeholder={tr('search path, method, status, client id, address')} onReload={calls.reload} loading={calls.loading} />
        </div>
        <Loader state={calls}>
          {({ items: rows, total }) =>
            rows.length ? (
              <>
              <div className="table-wrap">
                <table className="table small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <thead>
                    <tr>
                      <th>{tr('Time')}</th>
                      <th>{tr('Request')}</th>
                      <th>{tr('Status')}</th>
                      <th className="right">{tr('Duration')}</th>
                      <th>{tr('Consumer')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="clickable" onClick={() => setOpen(r)}>
                        <td className="nowrap muted">{fmtDate(r.at)}</td>
                        <td className="mono">
                          {r.method} {r.path}
                        </td>
                        <td>
                          <StatusBadge status={r.status >= 500 ? 'error' : r.status >= 400 ? 'pending' : 'active'} label={String(r.status)} />
                        </td>
                        <td className="right"><Tr text={'{0} ms'} args={[r.duration_ms]} /></td>
                        <td className="mono faint">{r.client_id || r.from_ip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager paging={paging} total={total} />
              </>
            ) : (
              <div className="card-body muted small">
                {paging.q ? tr('No call matches.') : tr('No call in this period. Install the data exporter from the Gateway page to feed the ingester.')}
              </div>
            )
          }
        </Loader>
      </div>
      {open && (
        <Modal title={`${open.method} ${open.path} — ${open.status}`} size="wide" onClose={() => setOpen(null)}>
          <p className="muted small">
            <Tr text={'{0} · {1} ms{2}{3}'} args={[fmtDate(open.at), open.duration_ms, nameOf(apis, open.api_id) ? ` · ${nameOf(apis, open.api_id).name} ${nameOf(apis, open.api_id).version}` : '', nameOf(apps, open.application_id) ? ` · ${nameOf(apps, open.application_id).name}` : '']} />
          </p>
          <CodeView value={open} maxHeight={520} ariaLabel={tr('call')} />
        </Modal>
      )}
    </div>
  );
}

export function ObservabilityPage() {
  return (
    <div className="page">
      <PageHead title={tr('Observability')} sub={tr("Usage of the catalogue, from the ingester's computed path — exhaustive, attributed to apis, plans and applications at ingestion.")} />
      <AnalyticsDashboard />
    </div>
  );
}
