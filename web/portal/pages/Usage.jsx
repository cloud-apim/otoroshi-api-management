import React, { useMemo } from 'react';
import { useQuery } from '../../shared/router.jsx';
import { Loader, Seg, Select, useLoad } from '../../shared/ui.jsx';
import { TimeSeries, BarList, StatTile } from '../../shared/charts.jsx';
import { fmtNumber } from '../../shared/lib.js';
import { api } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { PageHeader, RequireUser } from '../common.jsx';

const RANGES = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };

export function Usage() {
  return (
    <RequireUser>
      <UsageView />
    </RequireUser>
  );
}

function UsageView() {
  const { t } = useI18n();
  const [params, setParams] = useQuery();
  const range = RANGES[params.get('range')] ? params.get('range') : '24h';
  const application = params.get('application') || '';
  const apps = useLoad(() => api.get('/applications'), []);
  // the range is resolved once per selection so that refetches keep the same window
  const from = useMemo(() => new Date(Date.now() - RANGES[range]).toISOString(), [range]);
  const state = useLoad(() => api.get(`/analytics?from=${encodeURIComponent(from)}${application ? `&application=${application}` : ''}`), [from, application]);
  return (
    <div className="pt-container pt-section">
      <PageHeader title={t('usage.title')} subtitle={t('usage.subtitle')} />
      <div className="row wrap gap-6 mb-16" role="group" aria-label="filters">
        <Seg value={range} onChange={(v) => setParams({ range: v })} options={Object.keys(RANGES).map((k) => ({ value: k, label: t(`usage.range.${k}`) }))} />
        <div style={{ minWidth: 220 }}>
          <Select
            value={application}
            onChange={(v) => setParams({ application: v || null })}
            aria-label={t('apps.title')}
            options={[{ value: '', label: t('usage.allapps') }, ...(apps.data || []).map((a) => ({ value: a.id, label: a.name }))]}
          />
        </div>
      </div>
      <Loader state={state}>
        {(d) => {
          const errRate = d.totals.calls ? (100 * d.totals.errors) / d.totals.calls : 0;
          return (
            <div className="col gap-16" style={{ opacity: state.loading ? 0.6 : 1, transition: 'opacity .15s' }}>
              <div className="grid-4">
                <StatTile label={t('usage.calls')} value={fmtNumber(d.totals.calls)} />
                <StatTile label={t('usage.errorRate')} value={`${errRate.toFixed(errRate && errRate < 10 ? 1 : 0)}%`} hint={`${fmtNumber(d.totals.errors)} ${t('usage.errors').toLowerCase()}`} />
                <StatTile label={t('usage.latency')} value={`${fmtNumber(d.totals.avg_ms)} ms`} />
                <StatTile label={t('usage.p95')} value={`${fmtNumber(d.totals.p95_ms)} ms`} />
              </div>
              <div className="card">
                <div className="card-head">
                  <h3>{t('usage.traffic')}</h3>
                </div>
                <div className="card-body">
                  {d.totals.calls ? (
                    <TimeSeries
                      data={d.series}
                      bucket={d.range.bucket}
                      series={[
                        { key: 'calls', label: t('usage.calls') },
                        { key: 'errors', label: t('usage.errors') },
                      ]}
                    />
                  ) : (
                    <div className="empty small">{t('usage.empty')}</div>
                  )}
                </div>
              </div>
              <div className="grid-3">
                <div className="card">
                  <div className="card-head">
                    <h3>{t('usage.byApi')}</h3>
                  </div>
                  <div className="card-body">
                    <BarList items={d.byApi.map((x) => ({ label: x.name, value: x.calls }))} empty={t('usage.empty')} />
                  </div>
                </div>
                <div className="card">
                  <div className="card-head">
                    <h3>{t('usage.byPlan')}</h3>
                  </div>
                  <div className="card-body">
                    <BarList items={d.byPlan.map((x) => ({ label: x.plan_name, sub: x.api_name, value: x.calls }))} empty={t('usage.empty')} />
                  </div>
                </div>
                <div className="card">
                  <div className="card-head">
                    <h3>{t('usage.byApp')}</h3>
                  </div>
                  <div className="card-body">
                    <BarList items={d.byApplication.map((x) => ({ label: x.name, value: x.calls }))} empty={t('usage.empty')} />
                  </div>
                </div>
              </div>
            </div>
          );
        }}
      </Loader>
    </div>
  );
}
