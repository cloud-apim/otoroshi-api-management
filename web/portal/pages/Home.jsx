import React, { useState } from 'react';
import { Link, useRouter } from '../../shared/router.jsx';
import { Icon, Markdown, useLoad } from '../../shared/ui.jsx';
import { api, usePortal } from '../context.jsx';
import { useT } from '../i18n.jsx';
import { ApiCard } from './Catalogue.jsx';

export function Home() {
  const { portal, workspace } = usePortal();
  const t = useT();
  const { navigate } = useRouter();
  const [q, setQ] = useState('');
  const apis = useLoad(() => api.get('/apis'), []);
  const featured = (apis.data || []).slice(0, 6);
  return (
    <>
      <section className="pt-hero">
        <div className="pt-container">
          <div className="pt-hero-inner">
            <div className="pt-eyebrow">{workspace?.name}</div>
            <h1 className="pt-hero-title">{portal?.title}</h1>
            {portal?.tagline && <p className="pt-hero-tagline">{portal.tagline}</p>}
            <form
              className="pt-hero-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                navigate(`/apis${q ? `?q=${encodeURIComponent(q)}` : ''}`);
              }}
            >
              <Icon name="search" />
              <label className="sr-only" htmlFor="hero-search">
                {t('home.search')}
              </label>
              <input id="hero-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('home.search')} />
              <button className="btn primary" type="submit">
                {t('home.browse')}
              </button>
            </form>
          </div>
        </div>
      </section>

      <div className="pt-container pt-section">
        <div className="grid-3 pt-steps">
          {[1, 2, 3].map((n) => (
            <div key={n} className="pt-step">
              <div className="pt-step-n">{n}</div>
              <div>
                <h3>{t(`home.steps.${n}.title`)}</h3>
                <p className="muted small mt-8">{t(`home.steps.${n}.text`)}</p>
              </div>
            </div>
          ))}
        </div>

        {portal?.homeMarkdown && (
          <div className="card mt-24">
            <div className="card-body">
              <Markdown source={portal.homeMarkdown} />
            </div>
          </div>
        )}

        <div className="row mt-24 mb-16" style={{ marginTop: 40 }}>
          <h2 className="grow">{t('home.featured')}</h2>
          <Link to="/apis" className="link small row gap-4">
            {t('home.all')} <Icon name="chevronRight" size={14} />
          </Link>
        </div>
        {apis.loading && !apis.data ? (
          <div className="pt-grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card pt-skeleton" style={{ height: 150 }} />
            ))}
          </div>
        ) : featured.length ? (
          <div className="pt-grid">
            {featured.map((a) => (
              <ApiCard key={a.id} api={a} />
            ))}
          </div>
        ) : (
          <div className="card">
            <div className="empty">{t('catalogue.none')}</div>
          </div>
        )}
      </div>
    </>
  );
}
