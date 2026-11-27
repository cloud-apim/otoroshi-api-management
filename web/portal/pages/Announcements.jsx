import React from 'react';
import { Empty, Loader, Markdown, useLoad } from '../../shared/ui.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';
import { fmtDate } from '../../shared/lib.js';
import { api } from '../context.jsx';
import { useI18n } from '../i18n.jsx';

// the announcements of an api, across its versions, like a blog: the most recent first, searched and
// paged; its subscribers were told in their notifications
export function Announcements({ a }) {
  const { t } = useI18n();
  const state = useLoad(() => api.get(`/apis/${a.slug}/announcements`), [a.slug]);
  const page = useLocalPaging(state.data, { prefix: 'an', size: 10, text: (x) => `${x.title} ${x.body}` });
  return (
    <Loader state={state}>
      {(list) =>
        list.length ? (
          <div className="col gap-16" style={{ maxWidth: 760 }}>
            <ListToolbar paging={page} placeholder={t('announcements.search')} onReload={state.reload} loading={state.loading} />
            {page.items.length ? (
              page.items.map((n) => (
                <article key={n.id} id={n.id} className="card">
                  <div className="card-body col gap-8">
                    <div className="row gap-8 wrap">
                      <h3 className="grow" style={{ margin: 0 }}>
                        {n.title}
                      </h3>
                      <span className="muted small">
                        {fmtDate(n.created_at)}
                        {n.updated_at && new Date(n.updated_at) - new Date(n.created_at) > 60e3 ? ` · ${t('announcements.updated', { date: fmtDate(n.updated_at) })}` : ''}
                      </span>
                    </div>
                    {n.body && <Markdown source={n.body} />}
                  </div>
                </article>
              ))
            ) : (
              <Empty title={t('announcements.nomatch')} icon="search" />
            )}
            <Pager paging={page} total={page.total} />
          </div>
        ) : (
          <div className="card">
            <Empty title={t('announcements.none')} />
          </div>
        )
      }
    </Loader>
  );
}
