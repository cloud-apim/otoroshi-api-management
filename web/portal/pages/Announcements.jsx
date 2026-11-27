import React from 'react';
import { Link } from '../../shared/router.jsx';
import { Empty, Icon, Loader, Markdown, useLoad } from '../../shared/ui.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';
import { fmtDate } from '../../shared/lib.js';
import { api } from '../context.jsx';
import { useI18n } from '../i18n.jsx';

// the announcements of an api, across its versions, like a blog: the most recent first, searched and
// paged, each one a preview of its first lines; opened, the whole article. Their text is Markdown
export function Announcements({ a, id }) {
  const { t } = useI18n();
  const state = useLoad(() => api.get(`/apis/${a.slug}/announcements`), [a.slug]);
  return <Loader state={state}>{(list) => (id ? <Article a={a} n={list.find((x) => x.id === id)} /> : <List a={a} list={list} reload={state.reload} loading={state.loading} t={t} />)}</Loader>;
}

function Dates({ n }) {
  const { t } = useI18n();
  return (
    <span className="muted small">
      {fmtDate(n.created_at)}
      {n.updated_at && new Date(n.updated_at) - new Date(n.created_at) > 60e3 ? ` · ${t('announcements.updated', { date: fmtDate(n.updated_at) })}` : ''}
    </span>
  );
}

function List({ a, list, reload, loading, t }) {
  const page = useLocalPaging(list, { prefix: 'an', size: 10, text: (x) => `${x.title} ${x.body}` });
  if (!list.length)
    return (
      <div className="card">
        <Empty title={t('announcements.none')} />
      </div>
    );
  return (
    <div className="col gap-16" style={{ maxWidth: 760 }}>
      <ListToolbar paging={page} placeholder={t('announcements.search')} onReload={reload} loading={loading} />
      {page.items.length ? (
        page.items.map((n) => (
          <Link key={n.id} to={`/apis/${a.slug}/announcements/${n.id}`} className="card pt-announce" aria-label={n.title}>
            <div className="row gap-8 wrap">
              <h3 className="grow" style={{ margin: 0 }}>
                {n.title}
              </h3>
              <Dates n={n} />
            </div>
            {n.body && (
              <div className="pt-announce-preview" aria-hidden="true">
                <Markdown source={n.body} />
              </div>
            )}
            <span className="link small">{t('announcements.read')}</span>
          </Link>
        ))
      ) : (
        <Empty title={t('announcements.nomatch')} icon="search" />
      )}
      <Pager paging={page} total={page.total} />
    </div>
  );
}

function Article({ a, n }) {
  const { t } = useI18n();
  return (
    <div className="col gap-16" style={{ maxWidth: 760 }}>
      <Link to={`/apis/${a.slug}/announcements`} className="link small row gap-4" style={{ display: 'inline-flex' }}>
        <Icon name="arrowLeft" size={14} />
        {t('announcements.all')}
      </Link>
      {n ? (
        <article className="card">
          <div className="card-body col gap-8">
            <h2 style={{ margin: 0 }}>{n.title}</h2>
            <Dates n={n} />
            {n.body && <Markdown source={n.body} />}
          </div>
        </article>
      ) : (
        <div className="card">
          <Empty title={t('announcements.gone')} />
        </div>
      )}
    </div>
  );
}
