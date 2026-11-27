import React, { useState } from 'react';
import { useQuery, useRouter } from '../../shared/router.jsx';
import { Badge, Empty, Icon, Loader, Markdown, Select, TextArea, errorMessage, useLoad, useToast } from '../../shared/ui.jsx';
import { ListToolbar, Pager, usePaging } from '../../shared/lists.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { tr } from '../../shared/i18n.jsx';

// The conversations of the people of the portal with the workspace: the ones routed to one's teams —
// all of them for an administrator —, open first; each one on a page of its own.
export function MessagesPage() {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const page = usePaging({ prefix: 'conv', size: 25 });
  const [params, setParams] = useQuery();
  const status = params.get('status') || 'open';
  const list = useLoad(() => wapi.get(`/conversations?${page.query}${status !== 'all' ? `&status=${status}` : ''}`), [slug, page.key, status]);
  return (
    <div className="page">
      <PageHead title={tr('Messages')} sub={tr('The conversations of the people of the portal with the workspace: the ones routed to your teams by their subject, all of them for an administrator.')} />
      <div className="col gap-16">
        <ListToolbar paging={page} placeholder={tr('search titles, subjects, people')} onReload={list.reload} loading={list.loading}>
          <Select
            value={status}
            onChange={(v) => setParams({ status: v === 'open' ? null : v, conv_page: null })}
            options={[
              { value: 'open', label: tr('Open') },
              { value: 'closed', label: tr('Closed') },
              { value: 'all', label: tr('All') },
            ]}
            style={{ width: 150 }}
            aria-label={tr('filter by status')}
          />
        </ListToolbar>
        <Loader state={list}>
          {(l) =>
            l.items.length ? (
              <div className="card">
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{tr('Conversation')}</th>
                        <th>{tr('Person')}</th>
                        <th>{tr('Answered by')}</th>
                        <th className="right">{tr('Messages')}</th>
                        <th>{tr('Last message')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {l.items.map((c) => (
                        <tr key={c.id} className="clickable" onClick={() => navigate(`/ws/${slug}/messages/${c.id}`)}>
                          <td>
                            <div className={c.unread ? 'bold' : ''}>
                              {c.unread && <span className="unread-dot" aria-label={tr('unread')} />}
                              {c.title}
                            </div>
                            <div className="faint tiny">
                              {c.subject_label || tr('no subject')}
                              {c.status === 'closed' ? ` · ${tr('closed')}` : ''}
                            </div>
                          </td>
                          <td className="small">
                            {c.person_name}
                            <div className="faint tiny">{c.person_email}</div>
                          </td>
                          <td className="small">{c.team_name || tr('the administrators')}</td>
                          <td className="right">{c.messages}</td>
                          <td className="small muted">
                            {fmtRelative(c.last_message_at)}
                            <div className="faint tiny">{c.last_from === 'person' ? tr('from the person') : tr('from the workspace')}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager paging={page} total={l.total} />
              </div>
            ) : (
              <div className="card">
                <Empty title={tr('No conversation')} icon="inbox" />
              </div>
            )
          }
        </Loader>
      </div>
    </div>
  );
}

// a conversation: its messages in order — the ones of the workspace on the right —, an answer written
// below; closed or reopened
export function ConversationPage({ id }) {
  const { wapi, slug } = useWs();
  const toast = useToast();
  // read once loaded: the count of the sidebar follows
  const conv = useLoad(() => wapi.get(`/conversations/${id}`).then((c) => (window.dispatchEvent(new Event('apim:messages')), c)), [id]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const act = async (fn, done) => {
    setSending(true);
    try {
      await fn();
      if (done) toast(done);
      conv.reload();
      return true;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return false;
    } finally {
      setSending(false);
    }
  };
  const send = async () => {
    if (await act(() => wapi.post(`/conversations/${id}/messages`, { body: text }), tr('Answer sent'))) setText('');
  };
  return (
    <div className="page">
      <Loader state={conv}>
        {(x) => (
          <>
            <PageHead
              crumbs={[{ label: tr('Messages'), to: `/ws/${slug}/messages` }, { label: x.title }]}
              title={x.title}
              sub={
                <span className="row wrap gap-6">
                  <span className="bold">{x.person_name}</span>
                  <span className="faint">{x.person_email}</span>
                  <span className="faint">·</span>
                  <span>{x.subject_label || tr('no subject')}</span>
                  <span className="faint">·</span>
                  <span>{tr('answered by {0}', [x.team_name || tr('the administrators')])}</span>
                  {x.status === 'closed' && <Badge>{tr('closed')}</Badge>}
                </span>
              }
              actions={
                x.status === 'open' ? (
                  <button className="btn" disabled={sending} onClick={() => act(() => wapi.post(`/conversations/${id}/close`), tr('Conversation closed'))}>
                    <Icon name="check" /> {tr('Close')}
                  </button>
                ) : (
                  <button className="btn" disabled={sending} onClick={() => act(() => wapi.post(`/conversations/${id}/reopen`), tr('Conversation reopened'))}>
                    {tr('Reopen')}
                  </button>
                )
              }
            />
            <div className="col gap-16">
              <div className="thread">
                {x.messages.map((m) => (
                  <div key={m.id} className={`thread-msg ${m.side}`}>
                    <div className="faint tiny">
                      {m.author_name || m.author_email || tr('someone')} · {fmtDate(m.created_at)}
                    </div>
                    <Markdown source={m.body} />
                  </div>
                ))}
              </div>
              <div className="card card-body col gap-8">
                <TextArea value={text} onChange={setText} rows={5} placeholder={tr('Your answer, in Markdown')} aria-label={tr('answer')} />
                <div className="row">
                  <span className="spacer" />
                  <button className="btn primary" disabled={!text.trim() || sending} onClick={send}>
                    {tr('Send')}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </Loader>
    </div>
  );
}
