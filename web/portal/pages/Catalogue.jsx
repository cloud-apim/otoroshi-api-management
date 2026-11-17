import React, { useEffect, useMemo, useState } from 'react';
import { Link, useQuery } from '../../shared/router.jsx';
import { Icon, Loader, useLoad, Empty } from '../../shared/ui.jsx';
import { api } from '../context.jsx';
import { useT } from '../i18n.jsx';
import { LifecycleBadge, PageHeader } from '../common.jsx';

export function ApiCard({ api: a }) {
  const t = useT();
  return (
    <Link to={`/apis/${a.slug}`} className="card pt-api-card">
      <div className="row top gap-6">
        <span className="pt-api-icon" aria-hidden="true">
          {a.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="grow">
          <div className="row gap-6 wrap">
            <h3 className="ellipsis">{a.name}</h3>
            <span className="tag mono">v{a.version}</span>
            <LifecycleBadge lifecycle={a.lifecycle} />
          </div>
          <p className="muted small mt-8 pt-clamp">{a.description || '—'}</p>
        </div>
      </div>
      <div className="row wrap gap-6 mt-16">
        {(a.tags || []).slice(0, 4).map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
        <span className="spacer" />
        <span className="faint tiny">{a.plans_count === 1 ? t('catalogue.plan') : t('catalogue.plans', { n: a.plans_count })}</span>
      </div>
    </Link>
  );
}

export function Catalogue() {
  const t = useT();
  const [params, setParams] = useQuery();
  const q = params.get('q') || '';
  const tag = params.get('tag') || '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const state = useLoad(() => api.get('/apis'), []);
  const tags = useMemo(() => [...new Set((state.data || []).flatMap((a) => a.tags || []))].sort(), [state.data]);
  const filtered = (state.data || []).filter((a) => {
    const s = q.toLowerCase();
    const okQ = !s || a.name.toLowerCase().includes(s) || (a.description || '').toLowerCase().includes(s) || (a.tags || []).some((x) => x.toLowerCase().includes(s));
    return okQ && (!tag || (a.tags || []).includes(tag));
  });
  // one card per api, its most recent version
  const latest = Object.values(
    filtered.reduce((acc, a) => {
      acc[a.slug] = a;
      return acc;
    }, {})
  );
  return (
    <div className="pt-container pt-section">
      <PageHeader title={t('catalogue.title')} subtitle={t('catalogue.subtitle')} />
      <div className="row wrap gap-6 mb-16">
        <form
          className="pt-search grow"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setParams({ q: text });
          }}
        >
          <Icon name="search" />
          <label htmlFor="cat-search" className="sr-only">
            {t('catalogue.search')}
          </label>
          <input id="cat-search" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => setParams({ q: text })} placeholder={t('catalogue.search')} />
        </form>
      </div>
      {tags.length > 0 && (
        <div className="row wrap gap-6 mb-16" role="group" aria-label="tags">
          <button className={`pt-chip ${!tag ? 'on' : ''}`} onClick={() => setParams({ tag: null })} aria-pressed={!tag}>
            {t('catalogue.alltags')}
          </button>
          {tags.map((x) => (
            <button key={x} className={`pt-chip ${tag === x ? 'on' : ''}`} onClick={() => setParams({ tag: tag === x ? null : x })} aria-pressed={tag === x}>
              {x}
            </button>
          ))}
        </div>
      )}
      <Loader state={state}>
        {(all) =>
          !all.length ? (
            <div className="card">
              <Empty title={t('catalogue.none')} />
            </div>
          ) : latest.length ? (
            <div className="pt-grid">
              {latest.map((a) => (
                <ApiCard key={a.id} api={a} />
              ))}
            </div>
          ) : (
            <div className="card">
              <Empty title={t('catalogue.empty')} icon="search" />
            </div>
          )
        }
      </Loader>
    </div>
  );
}
