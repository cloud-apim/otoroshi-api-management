import React, { useEffect, useState } from 'react';
import { Link, useQuery, useRouter } from '../../../shared/router.jsx';
import { Empty, Field, Icon, Input, Loader, Markdown, Switch, Tabs, errorMessage, useConfirm, useLoad, useToast } from '../../../shared/ui.jsx';
import { CodeEditor } from '../../../shared/code-editor.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../../shared/lists.jsx';
import { fmtDate } from '../../../shared/lib.js';
import { useWs } from '../../context.jsx';
import { tr } from '../../../shared/i18n.jsx';

// The announcements of an api, across its versions, like a blog on its page in the portal: published
// at once, its subscribers told in their notifications; corrected or deleted afterwards, nobody told
// again. Their text is Markdown. Each one on a page of its own — `item`, or `new` —, from the list.
export function AnnouncementsTab({ api, readOnly, item }) {
  if (item) return <AnnouncementPage key={item} api={api} id={item === 'new' ? null : item} readOnly={readOnly} />;
  return <AnnouncementsList api={api} readOnly={readOnly} />;
}

function AnnouncementsList({ api, readOnly }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const state = useLoad(() => wapi.get(`/apis/${api.id}/announcements`), [api.id]);
  const page = useLocalPaging(state.data, { prefix: 'ann', size: 10, text: (x) => `${x.title} ${x.body} ${x.author_name || ''}` });
  const base = `/ws/${slug}/apis/${api.id}/announcements`;
  // the links of before, ?open=<id>, lead to the page of the announcement
  const [params] = useQuery();
  const legacy = params.get('open');
  useEffect(() => {
    if (legacy) navigate(`${base}/${legacy}`, { replace: true });
  }, [legacy]);
  return (
    <div className="col gap-16">
      <p className="muted small" style={{ margin: 0 }}>
        {tr('Posts on the page of the API in the portal, for all its versions: its subscribers are told in their notifications when one is published.')}
      </p>
      <ListToolbar paging={page} placeholder={tr('search the announcements')} onReload={state.reload} loading={state.loading}>
        {!readOnly && (
          <Link to={`${base}/new`} className="btn primary">
            <Icon name="plus" /> {tr('New announcement')}
          </Link>
        )}
      </ListToolbar>
      <Loader state={state}>
        {() =>
          page.items.length ? (
            <>
              {page.items.map((n) => (
                <Link key={n.id} to={`${base}/${n.id}`} className="card announce-card" aria-label={tr('Read {0}', [n.title])}>
                  <div className="row gap-8 wrap">
                    <h3 className="grow">{n.title}</h3>
                    <span className="faint small">
                      {fmtDate(n.created_at)}
                      {n.author_name ? ` · ${n.author_name}` : ''}
                    </span>
                  </div>
                  {n.body && (
                    <div className="announce-preview" aria-hidden="true">
                      <Markdown source={n.body} />
                    </div>
                  )}
                </Link>
              ))}
              <Pager paging={page} total={page.total} />
            </>
          ) : (
            <div className="card">
              <Empty title={state.data?.length ? tr('No announcement matches') : tr('No announcement yet')} icon={state.data?.length ? 'search' : 'doc'} />
            </div>
          )
        }
      </Loader>
    </div>
  );
}

// an announcement on a page of its own: read, and written — Edit, Preview —; a new one opens on Edit
function AnnouncementPage({ api, id, readOnly }) {
  const { wapi } = useWs();
  const state = useLoad(() => (id ? wapi.get(`/apis/${api.id}/announcements/${id}`) : Promise.resolve(null)), [api.id, id]);
  return <Loader state={state}>{(current) => <AnnouncementEditor key={current?.id || 'new'} api={api} current={current} readOnly={readOnly} reload={state.reload} />}</Loader>;
}

function AnnouncementEditor({ api, current, readOnly, reload }) {
  const { wapi, slug } = useWs();
  const { navigate } = useRouter();
  const list = `/ws/${slug}/apis/${api.id}/announcements`;
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState(current ? 'preview' : 'edit');
  const [title, setTitle] = useState(current?.title || '');
  const [body, setBody] = useState(current?.body || '');
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const dirty = !current || title !== current.title || body !== current.body;

  const save = async () => {
    setSaving(true);
    try {
      if (current) {
        const saved = await wapi.put(`/apis/${api.id}/announcements/${current.id}`, { title, body });
        toast(tr('Announcement updated'));
        reload();
      } else {
        const r = await wapi.post(`/apis/${api.id}/announcements`, { title, body, notify });
        toast(r.told ? tr('Announcement published: {0} team(s) of subscribers told', [r.told]) : tr('Announcement published'));
        navigate(`${list}/${r.id}`, { replace: true });
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: tr('Delete the announcement {0}?', [current.title]), message: tr('It leaves the page of the API in the portal; the notifications already sent stay.'), danger: true, confirmLabel: tr('Delete') }))) return;
    try {
      await wapi.del(`/apis/${api.id}/announcements/${current.id}`);
      toast(tr('Announcement deleted'));
      navigate(list);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const preview = (
    <div className="col gap-8">
      <h2 style={{ margin: 0 }}>{title || <span className="faint">{tr('Title')}</span>}</h2>
      {current && (
        <span className="faint small">
          {fmtDate(current.created_at)}
          {current.author_name ? ` · ${current.author_name}` : ''}
          {new Date(current.updated_at) - new Date(current.created_at) > 60e3 ? ` · ${tr('updated {0}', [fmtDate(current.updated_at)])}` : ''}
        </span>
      )}
      {body ? <Markdown source={body} /> : <p className="muted">{tr('No text')}</p>}
    </div>
  );

  return (
    <div className="col gap-16">
      <div className="row wrap">
        <Link to={list} className="link small row gap-4" style={{ display: 'inline-flex' }}>
          <Icon name="arrowLeft" size={14} />
          {tr('Announcements')}
        </Link>
        <span className="spacer" />
        {!readOnly && (
          <>
            {current && (
              <button className="btn ghost danger" onClick={remove}>
                <Icon name="trash" /> {tr('Delete')}
              </button>
            )}
            <button className="btn primary" disabled={!title.trim() || !dirty || saving} onClick={save}>
              {current ? tr('Save') : tr('Publish')}
            </button>
          </>
        )}
      </div>
      <div className="card card-body">
        {readOnly ? (
          preview
        ) : (
          <>
            {!current && <h2 style={{ marginTop: 0 }}>{tr('New announcement')}</h2>}
            <div className="mb-16">
              <Tabs
                tabs={[
                  { id: 'edit', label: tr('Edit') },
                  { id: 'preview', label: tr('Preview') },
                ]}
                value={tab}
                onChange={setTab}
              />
            </div>
            {tab === 'edit' ? (
              <div className="col gap-12">
                <Field label={tr('Title')}>
                  <Input value={title} onChange={setTitle} autoFocus maxLength={200} />
                </Field>
                <Field label={tr('Text')} hint={tr('Markdown')}>
                  <CodeEditor value={body} onChange={setBody} language="markdown" wordWrap="on" minHeight={360} maxHeight={720} ariaLabel={tr('text of the announcement')} placeholder={tr('# Markdown')} />
                </Field>
                {current ? (
                  <p className="muted small" style={{ margin: 0 }}>
                    {tr('A correction is not notified again.')}
                  </p>
                ) : (
                  <Switch checked={notify} onChange={setNotify} label={tr('Tell the subscribers of every version in their notifications')} />
                )}
              </div>
            ) : (
              preview
            )}
          </>
        )}
      </div>
    </div>
  );
}
