import React, { useEffect, useMemo, useState } from 'react';
import { Link, useQuery } from '../../shared/router.jsx';
import { Icon, Loader, useLoad, Empty } from '../../shared/ui.jsx';
import { Stars } from '../../shared/stars.jsx';
import { Pager, usePaging } from '../../shared/lists.jsx';
import { api, usePortal } from '../context.jsx';
import { usePortalText, useT } from '../i18n.jsx';
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
      <Signals a={a} />
    </Link>
  );
}

// what the consumers say of an api and how much it is used: two of the three axes of discovery
export function Signals({ a }) {
  const t = useT();
  if (!a.rating && !a.usage?.applications && !a.featured) return null;
  return (
    <div className="row wrap gap-6 mt-8 small">
      {a.featured && <span className="badge accent">{t('catalogue.featured')}</span>}
      {a.rating && (
        <span className="row gap-4">
          <Stars value={a.rating.average} label={t('reviews.rating', { n: a.rating.average })} />
          <span className="faint tiny">{a.rating.count === 1 ? t('reviews.one') : t('reviews.count', { n: a.rating.count })}</span>
        </span>
      )}
      <span className="spacer" />
      {a.usage?.applications > 0 && <span className="faint tiny">{a.usage.applications === 1 ? t('catalogue.app') : t('catalogue.apps', { n: a.usage.applications })}</span>}
    </div>
  );
}

const SORTS = ['featured', 'popular', 'rating', 'name', 'recent'];
// the featured apis above the catalogue are a preview: all of them come first in the list below
const FEATURED = 6;

export function Catalogue() {
  const t = useT();
  const [params, setParams] = useQuery();
  // the search and the page of the catalogue, in the url: the home page searches it with `q`
  const paging = usePaging({ size: 25 });
  const q = paging.q;
  const tag = params.get('tag') || '';
  const category = params.get('category') || '';
  const sort = SORTS.includes(params.get('sort')) ? params.get('sort') : 'featured';
  const { portal } = usePortal();
  const text_ = usePortalText(portal);
  const categories = portal?.categories || [];
  const shows = { reviews: portal?.discovery?.reviews !== false, usage: portal?.discovery?.usage !== false };
  const sorts = SORTS.filter((x) => (x !== 'popular' || shows.usage) && (x !== 'rating' || shows.reviews));
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const state = useLoad(() => api.get(`/apis?sort=${sort}`), [sort]);
  const tags = useMemo(() => [...new Set((state.data || []).flatMap((a) => a.tags || []))].sort(), [state.data]);
  const filtered = (state.data || []).filter((a) => {
    const s = q.toLowerCase();
    const okQ = !s || a.name.toLowerCase().includes(s) || (a.description || '').toLowerCase().includes(s) || (a.tags || []).some((x) => x.toLowerCase().includes(s));
    return okQ && (!tag || (a.tags || []).includes(tag)) && (!category || (a.categories || []).includes(category));
  });
  // one card per api, its most recent version
  const latest = Object.values(
    filtered.reduce((acc, a) => {
      acc[a.slug] = a;
      return acc;
    }, {})
  );
  const shown = latest.slice(paging.offset, paging.offset + paging.limit);
  const search = () => text !== q && paging.setQ(text);
  return (
    <div className="pt-container pt-section">
      <PageHeader title={t('catalogue.title')} subtitle={t('catalogue.subtitle')} />
      <div className="row wrap gap-6 mb-16">
        <form
          className="pt-search grow"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <Icon name="search" />
          <label htmlFor="cat-search" className="sr-only">
            {t('catalogue.search')}
          </label>
          <input id="cat-search" value={text} onChange={(e) => setText(e.target.value)} onBlur={search} placeholder={t('catalogue.search')} />
        </form>
        <label className="small muted" htmlFor="cat-sort">
          {t('catalogue.sort')}
        </label>
        <select id="cat-sort" className="select" style={{ width: 'auto' }} value={sort} onChange={(e) => setParams({ sort: e.target.value === 'featured' ? null : e.target.value, page: null })}>
          {sorts.map((x) => (
            <option key={x} value={x}>
              {t(`catalogue.sort.${x}`)}
            </option>
          ))}
        </select>
      </div>
      {categories.length > 0 && (
        <div className="row wrap gap-6 mb-16" role="group" aria-label={t('catalogue.categories')}>
          <button className={`pt-chip ${!category ? 'on' : ''}`} onClick={() => setParams({ category: null, page: null })} aria-pressed={!category}>
            {t('catalogue.allcategories')}
          </button>
          {categories.map((c) => (
            <button key={c.slug} className={`pt-chip ${category === c.slug ? 'on' : ''}`} onClick={() => setParams({ category: category === c.slug ? null : c.slug, page: null })} aria-pressed={category === c.slug}>
              {text_(c.name) || c.slug}
            </button>
          ))}
        </div>
      )}
      {tags.length > 0 && (
        <div className="row wrap gap-6 mb-16" role="group" aria-label="tags">
          <button className={`pt-chip ${!tag ? 'on' : ''}`} onClick={() => setParams({ tag: null, page: null })} aria-pressed={!tag}>
            {t('catalogue.alltags')}
          </button>
          {tags.map((x) => (
            <button key={x} className={`pt-chip ${tag === x ? 'on' : ''}`} onClick={() => setParams({ tag: tag === x ? null : x, page: null })} aria-pressed={tag === x}>
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
            <>
              {!q && !tag && !category && sort === 'featured' && paging.page === 1 && latest.some((a) => a.featured) && (
                <>
                  <h2 id="cat-featured" className="mb-16">
                    {t('catalogue.featured')}
                  </h2>
                  <div className="pt-grid">
                    {latest
                      .filter((a) => a.featured)
                      .slice(0, FEATURED)
                      .map((a) => (
                        <ApiCard key={a.id} api={a} />
                      ))}
                  </div>
                  <h2 className="mb-16" style={{ marginTop: 40 }}>
                    {t('catalogue.all')}
                  </h2>
                </>
              )}
              <div className="pt-grid">
                {shown.map((a) => (
                  <ApiCard key={a.id} api={a} />
                ))}
              </div>
              <div className="mt-16">
                <Pager paging={paging} total={latest.length} />
              </div>
            </>
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
