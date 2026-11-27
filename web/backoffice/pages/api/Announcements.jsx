import React, { useState } from 'react';
import { useQuery } from '../../../shared/router.jsx';
import { Empty, Field, Icon, Input, Loader, Markdown, Modal, Switch, Tabs, errorMessage, useConfirm, useLoad, useToast } from '../../../shared/ui.jsx';
import { CodeEditor } from '../../../shared/code-editor.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../../shared/lists.jsx';
import { fmtDate } from '../../../shared/lib.js';
import { useWs } from '../../context.jsx';
import { tr } from '../../../shared/i18n.jsx';

// The announcements of an api, across its versions, like a blog on its page in the portal: published
// at once, its subscribers told in their notifications; corrected or deleted afterwards, nobody told
// again. Their text is Markdown.
export function AnnouncementsTab({ api, readOnly }) {
  const { wapi } = useWs();
  const state = useLoad(() => wapi.get(`/apis/${api.id}/announcements`), [api.id]);
  const page = useLocalPaging(state.data, { prefix: 'ann', size: 10, text: (x) => `${x.title} ${x.body} ${x.author_name || ''}` });
  // the one opened, from the url, or a new one
  const [params, setParams] = useQuery();
  const [creating, setCreating] = useState(false);
  const opened = (state.data || []).find((x) => x.id === params.get('open'));
  const close = () => (setCreating(false), setParams({ open: null }));
  return (
    <div className="col gap-16">
      <p className="muted small" style={{ margin: 0 }}>
        {tr('Posts on the page of the API in the portal, for all its versions: its subscribers are told in their notifications when one is published.')}
      </p>
      <ListToolbar paging={page} placeholder={tr('search the announcements')} onReload={state.reload} loading={state.loading}>
        {!readOnly && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> {tr('New announcement')}
          </button>
        )}
      </ListToolbar>
      <Loader state={state}>
        {() =>
          page.items.length ? (
            <>
              {page.items.map((n) => (
                <button key={n.id} type="button" className="card announce-card" onClick={() => setParams({ open: n.id })} aria-label={tr('Read {0}', [n.title])}>
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
                </button>
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
      {(creating || opened) && (
        <AnnouncementModal
          key={creating ? 'new' : opened.id}
          api={api}
          current={creating ? null : opened}
          readOnly={readOnly}
          onClose={close}
          onSaved={(saved) => {
            state.reload();
            setCreating(false);
            setParams({ open: saved?.id || null });
          }}
          onDeleted={() => (close(), state.reload())}
        />
      )}
    </div>
  );
}

// one window to read an announcement and to write it — Edit, Preview —; a new one opens on Edit
function AnnouncementModal({ api, current, readOnly, onClose, onSaved, onDeleted }) {
  const { wapi } = useWs();
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
        onSaved(saved);
      } else {
        const r = await wapi.post(`/apis/${api.id}/announcements`, { title, body, notify });
        toast(r.told ? tr('Announcement published: {0} team(s) of subscribers told', [r.told]) : tr('Announcement published'));
        onSaved(r);
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
      onDeleted();
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
    <Modal
      title={current ? current.title : tr('New announcement')}
      size="wide fit"
      onClose={onClose}
      footer={
        !readOnly && (
          <>
            {current && (
              <button className="btn ghost danger" onClick={remove}>
                <Icon name="trash" /> {tr('Delete')}
              </button>
            )}
            <span className="spacer" />
            <button className="btn primary" disabled={!title.trim() || !dirty || saving} onClick={save}>
              {current ? tr('Save') : tr('Publish')}
            </button>
          </>
        )
      }
    >
      {readOnly ? (
        preview
      ) : (
        <>
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
                <CodeEditor value={body} onChange={setBody} language="markdown" wordWrap="on" minHeight={280} maxHeight={520} ariaLabel={tr('text of the announcement')} placeholder={tr('# Markdown')} />
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
    </Modal>
  );
}
