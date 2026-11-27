import React, { useState } from 'react';
import { Link, useQuery, useRouter } from '../../shared/router.jsx';
import { Badge, Empty, Field, Icon, Input, Loader, Markdown, Select, TextArea, errorMessage, useLoad, useToast } from '../../shared/ui.jsx';
import { ListToolbar, Pager, usePaging } from '../../shared/lists.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { api } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { PageHeader, RequireUser } from '../common.jsx';

// The conversations of a person with the workspace: an inbox, about an API or a subscription of theirs —
// what routes it to the team that answers —, or about nothing. The text of a message is Markdown.
export function Messages({ id }) {
  return <RequireUser>{id === 'new' ? <NewConversation /> : id ? <Conversation id={id} /> : <Inbox />}</RequireUser>;
}

function Inbox() {
  const { t } = useI18n();
  const page = usePaging({ prefix: 'conv', size: 10 });
  const [status, setStatus] = useState('');
  const list = useLoad(() => api.get(`/conversations?${page.query}${status ? `&status=${status}` : ''}`), [page.key, status]);
  return (
    <div className="pt-container pt-section" style={{ maxWidth: 860 }}>
      <PageHeader
        title={t('messages.title')}
        subtitle={t('messages.subtitle')}
        actions={
          <Link to="/messages/new" className="btn primary">
            <Icon name="plus" /> {t('messages.new')}
          </Link>
        }
      />
      <div className="col gap-16">
        <ListToolbar paging={page} placeholder={t('messages.search')} onReload={list.reload} loading={list.loading}>
          <Select
            value={status}
            onChange={(v) => (setStatus(v), page.setPage(1))}
            options={[
              { value: '', label: t('messages.all') },
              { value: 'open', label: t('messages.open') },
              { value: 'closed', label: t('messages.closed') },
            ]}
            style={{ width: 160 }}
            aria-label={t('messages.status')}
          />
        </ListToolbar>
        <Loader state={list}>
          {(l) =>
            l.items.length ? (
              <>
                {l.items.map((c) => (
                  <Link key={c.id} to={`/messages/${c.id}`} className="card pt-announce">
                    <div className="row gap-8 wrap">
                      <h3 className="grow" style={{ margin: 0, fontWeight: c.unread ? 700 : 600 }}>
                        {c.unread && <span className="unread-dot" aria-label={t('messages.unread')} />}
                        {c.title}
                      </h3>
                      <span className="muted small">{fmtRelative(c.last_message_at)}</span>
                    </div>
                    <div className="row gap-6 wrap small muted">
                      <span>{c.subject_label || t('messages.nosubject')}</span>
                      <span>·</span>
                      <span>{t('messages.count', { n: c.messages })}</span>
                      {c.status === 'closed' && <Badge>{t('messages.closedOne')}</Badge>}
                      {c.unread && <Badge kind="info">{t('messages.answered')}</Badge>}
                    </div>
                  </Link>
                ))}
                <Pager paging={page} total={l.total} />
              </>
            ) : (
              <div className="card">
                <Empty title={t('messages.none')} icon="inbox" action={<Link to="/messages/new" className="btn">{t('messages.new')}</Link>} />
              </div>
            )
          }
        </Loader>
      </div>
    </div>
  );
}

// a new conversation: its title, what it is about — prefilled from ?about=api:<slug> or
// ?about=subscription:<id> —, its first message
function NewConversation() {
  const { t } = useI18n();
  const toast = useToast();
  const { navigate } = useRouter();
  const [params] = useQuery();
  const apis = useLoad(() => api.get('/apis'), []);
  const subs = useLoad(() => api.get('/subscriptions'), []);
  const [about, setAbout] = useState(params.get('about') || '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const latest = Object.values((apis.data || []).reduce((acc, a) => ({ ...acc, [a.slug]: a }), {}));
  const options = [
    { value: '', label: t('messages.nosubject') },
    ...latest.map((a) => ({ value: `api:${a.slug}`, label: t('messages.aboutApi', { name: `${a.name} ${a.version}` }) })),
    ...(subs.data || []).filter((s) => !['rejected'].includes(s.status)).map((s) => ({ value: `subscription:${s.id}`, label: t('messages.aboutSub', { name: `${s.application_name} → ${s.api_name} ${s.api_version} · ${s.plan_name}` }) })),
  ];
  const send = async (e) => {
    e.preventDefault();
    setSending(true);
    try {
      const [kind, ...rest] = about.split(':');
      const c = await api.post('/conversations', { title, body, subject: about ? { kind, id: rest.join(':') } : null });
      toast(t('messages.sent'));
      navigate(`/messages/${c.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="pt-container pt-section" style={{ maxWidth: 760 }}>
      <Link to="/messages" className="link small row gap-4" style={{ display: 'inline-flex', marginBottom: 12 }}>
        <Icon name="arrowLeft" size={14} />
        {t('messages.title')}
      </Link>
      <PageHeader title={t('messages.new')} subtitle={t('messages.newHelp')} />
      <form className="card card-body col gap-12" onSubmit={send}>
        <Field label={t('messages.about')}>
          <Select value={about} onChange={setAbout} options={options} aria-label={t('messages.about')} />
        </Field>
        <Field label={t('messages.titleField')}>
          <Input value={title} onChange={setTitle} maxLength={200} autoFocus />
        </Field>
        <Field label={t('messages.message')} hint={t('messages.markdown')}>
          <TextArea value={body} onChange={setBody} rows={8} />
        </Field>
        <div className="row">
          <button className="btn primary" type="submit" disabled={!title.trim() || !body.trim() || sending}>
            {t('messages.send')}
          </button>
        </div>
      </form>
    </div>
  );
}

// a conversation: its messages in order — one's own on the right —, an answer below; closed by the
// person, reopened when they write again
function Conversation({ id }) {
  const { t } = useI18n();
  const toast = useToast();
  // read once loaded: the count beside Messages follows
  const conv = useLoad(() => api.get(`/conversations/${id}`).then((c) => (window.dispatchEvent(new Event('apim:messages')), c)), [id]);
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
  return (
    <div className="pt-container pt-section" style={{ maxWidth: 760 }}>
      <Link to="/messages" className="link small row gap-4" style={{ display: 'inline-flex', marginBottom: 12 }}>
        <Icon name="arrowLeft" size={14} />
        {t('messages.title')}
      </Link>
      <Loader state={conv}>
        {(c) => (
          <div className="col gap-16">
            <div>
              <h1 style={{ margin: 0, fontSize: 24 }}>{c.title}</h1>
              <div className="row gap-6 wrap small muted mt-8">
                <span>{c.subject_label || t('messages.nosubject')}</span>
                <span>·</span>
                <span>{fmtDate(c.created_at)}</span>
                {c.status === 'closed' && <Badge>{t('messages.closedOne')}</Badge>}
              </div>
            </div>
            <div className="thread">
              {c.messages.map((m) => (
                <div key={m.id} className={`thread-msg ${m.side === 'person' ? 'mine' : 'theirs'}`}>
                  <div className="faint tiny">
                    {m.side === 'person' ? t('messages.you') : m.author_name || t('messages.workspace')} · {fmtDate(m.created_at)}
                  </div>
                  <Markdown source={m.body} />
                </div>
              ))}
            </div>
            <div className="card card-body col gap-8">
              <TextArea value={text} onChange={setText} rows={4} placeholder={t('messages.reply')} aria-label={t('messages.reply')} />
              <div className="row">
                {c.status === 'open' && (
                  <button className="btn ghost" disabled={sending} onClick={() => act(() => api.post(`/conversations/${id}/close`), t('messages.closedDone'))}>
                    {t('messages.close')}
                  </button>
                )}
                <span className="spacer" />
                <button className="btn primary" disabled={!text.trim() || sending} onClick={async () => (await act(() => api.post(`/conversations/${id}/messages`, { body: text }), t('messages.sent'))) && setText('')}>
                  {t('messages.send')}
                </button>
              </div>
              {c.status === 'closed' && <span className="muted small">{t('messages.reopenHelp')}</span>}
            </div>
          </div>
        )}
      </Loader>
    </div>
  );
}
