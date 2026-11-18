// The notifications of the person signed in, in this workspace: each reads them and marks them done
// on their own, even those addressed to a whole team.
import React from 'react';
import { Link, useQuery } from '../../shared/router.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { Empty, Icon, Loader, errorMessage, useLoad, useToast } from '../../shared/ui.jsx';
import { ListToolbar, Pager, usePaging } from '../../shared/lists.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';

const FILTERS = [
  ['open', 'To deal with'],
  ['unread', 'Unread'],
  ['done', 'Done'],
  ['all', 'All'],
];

export function NotificationsPage() {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const [params, setParams] = useQuery();
  const filter = params.get('filter') || 'open';
  const paging = usePaging({ prefix: 'notes', size: 25 });
  const state = useLoad(() => wapi.get(`/notifications?filter=${filter}&${paging.query}`), [slug, filter, paging.key]);
  const act = (path, body, done) => async () => {
    try {
      await wapi.post(`/notifications/${path}`, body);
      if (done) toast(done);
      state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="page">
      <PageHead
        title="Notifications"
        sub="What happened to the subscriptions and the requests of your teams. You read them, and mark them done, for yourself."
        actions={
          state.data?.unread > 0 && (
            <button className="btn" onClick={act('read', {}, 'Everything marked read')}>
              <Icon name="check" /> Mark all read
            </button>
          )
        }
      />
      <div className="tabs mb-16">
        {FILTERS.map(([id, label]) => (
          <button key={id} className={filter === id ? 'on' : ''} onClick={() => setParams({ filter: id === 'open' ? null : id, notes_page: null })}>
            {label}
            {id === 'unread' && state.data?.unread > 0 && <span className="badge warning" style={{ marginLeft: 6 }}>{state.data.unread}</span>}
          </button>
        ))}
      </div>
      <ListToolbar paging={paging} placeholder="search titles and texts" onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {({ items, total }) =>
          items.length ? (
            <div className="card">
              {items.map((n) => (
                <div key={n.id} className={`note-row ${n.read_at ? '' : 'unread'}`}>
                  <div className="grow col gap-4" style={{ minWidth: 0 }}>
                    <span className={`note-title ${n.read_at ? '' : 'bold'}`}>{n.title}</span>
                    {n.body && <span className="muted small">{n.body}</span>}
                    <span className="faint tiny" title={fmtDate(n.created_at)}>
                      {fmtRelative(n.created_at)}
                      {n.done_at ? ` · done ${fmtRelative(n.done_at)}` : ''}
                    </span>
                  </div>
                  <div className="row gap-6">
                    {n.link && (
                      <Link to={`/ws/${slug}${n.link}`} className="btn sm" onClick={() => !n.read_at && wapi.post('/notifications/read', { ids: [n.id] })}>
                        Open
                      </Link>
                    )}
                    {!n.read_at && (
                      <button className="btn sm ghost" onClick={act('read', { ids: [n.id] })}>
                        Mark read
                      </button>
                    )}
                    {n.done_at ? (
                      <button className="btn sm ghost" onClick={act('done', { ids: [n.id], done: false })}>
                        Not done
                      </button>
                    ) : (
                      <button className="btn sm" onClick={act('done', { ids: [n.id] })}>
                        <Icon name="check" /> Done
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <Pager paging={paging} total={total} />
            </div>
          ) : (
            <Empty title={filter === 'open' ? 'Nothing to deal with' : filter === 'unread' ? 'Nothing unread' : filter === 'done' ? 'Nothing done yet' : 'No notification'} icon="check" />
          )
        }
      </Loader>
    </div>
  );
}
