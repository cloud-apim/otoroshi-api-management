import React from 'react';
import { Link } from '../../shared/router.jsx';
import { fmtNumber, fmtRelative } from '../../shared/lib.js';
import { Empty, Icon, Loader, StatusBadge, useLoad } from '../../shared/ui.jsx';
import { StatTile, TimeSeries } from '../../shared/charts.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

export function Home() {
  const { wapi, slug, ws, session } = useWs();
  const state = useLoad(() => wapi.get('/home'), [slug]);
  const traffic = useLoad(() => wapi.get('/analytics'), [slug]);
  return (
    <div className="page">
      <PageHead title={tr('Welcome, {0}', [session.user.name])} sub={tr('{0} — what needs your attention, and how the catalogue is doing.', [ws.name])} />
      <Loader state={state}>
        {(h) => (
          <div className="col gap-24">
            <div className="grid-4">
              <StatTile label={tr('APIs')} value={h.counts.apis} hint={tr('{0} published', [h.counts.published_apis])} />
              <StatTile label={tr('Active subscriptions')} value={h.counts.active_subscriptions} hint={tr('{0} applications', [h.counts.applications])} />
              <StatTile label={tr('Waiting for review')} value={h.counts.pending_subscriptions} />
              <StatTile label={tr('Calls, last 24h')} value={traffic.data ? fmtNumber(traffic.data.totals.calls) : '…'} hint={traffic.data ? tr('{0} errors · p95 {1} ms', [fmtNumber(traffic.data.totals.errors), fmtNumber(traffic.data.totals.p95_ms)]) : ''} />
            </div>
            <div className="grid-2">
              <div className="card">
                <div className="card-head">
                  <Icon name="inbox" />
                  <h3 className="grow">{tr('To review')}</h3>
                  <Link className="link small" to={`/ws/${slug}/subscriptions?status=pending`}>
                    {tr('All subscriptions')}
                  </Link>
                </div>
                {h.pending.length ? (
                  h.pending.map((s) => (
                    <Link key={s.id} to={`/ws/${slug}/subscriptions?status=pending&open=${s.id}`} className="list-item" style={{ display: 'flex' }}>
                      <div className="grow">
                        <div className="bold">{s.application_name}</div>
                        <div className="muted small">
                          {s.api_name} {s.api_version} · {s.request?.plan_name}
                        </div>
                      </div>
                      <span className="faint small">{fmtRelative(s.created_at)}</span>
                    </Link>
                  ))
                ) : (
                  <Empty title={tr('Nothing to review')} icon="check" />
                )}
              </div>
              <div className="card">
                <div className="card-head">
                  <Icon name="rocket" />
                  <h3 className="grow">{tr('Out of sync')}</h3>
                </div>
                {h.out_of_sync.length ? (
                  h.out_of_sync.map((a) => (
                    <Link key={a.id} to={`/ws/${slug}/apis/${a.id}/deployment`} className="list-item" style={{ display: 'flex' }}>
                      <div className="grow bold">
                        {a.name} <span className="faint">{a.version}</span>
                      </div>
                      <span className="badge warning">{tr('published, not deployed')}</span>
                    </Link>
                  ))
                ) : (
                  <Empty title={tr('Everything published is deployed')} icon="check" />
                )}
                {h.counts.drifted > 0 && (
                  <Link to="/gateway/drift" className="list-item" style={{ display: 'flex' }}>
                    <Icon name="alert" />
                    <span className="grow"><Tr text={'{0} projected objects drifted on the gateway'} args={[h.counts.drifted]} /></span>
                    <Icon name="chevronRight" />
                  </Link>
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <Icon name="chart" />
                <h3 className="grow">{tr('Traffic, last 24 hours')}</h3>
                <Link className="link small" to={`/ws/${slug}/observability`}>
                  {tr('Observability')}
                </Link>
              </div>
              <div className="card-body">
                <Loader state={traffic}>
                  {(t) => (
                    <TimeSeries
                      data={t.series}
                      bucket={t.range.bucket}
                      series={[
                        { key: 'calls', label: tr('Calls') },
                        { key: 'errors', label: tr('Errors') },
                      ]}
                    />
                  )}
                </Loader>
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <Icon name="audit" />
                <h3 className="grow">{tr('Recent activity')}</h3>
                <Link className="link small" to={`/ws/${slug}/audit`}>
                  {tr('Audit')}
                </Link>
              </div>
              {h.recent.map((e) => (
                <div key={e.id} className="list-item">
                  <span className="badge">{e.action}</span>
                  <span className="grow ellipsis">{e.summary}</span>
                  <span className="faint small nowrap">
                    {e.actor?.email} · {fmtRelative(e.at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Loader>
    </div>
  );
}
