import React, { useState } from 'react';
import { useQuery } from '../../../shared/router.jsx';
import { Empty, Field, Icon, Input, Loader, Markdown, Modal, Switch, TextArea, errorMessage, useConfirm, useLoad, useToast } from '../../../shared/ui.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../../shared/lists.jsx';
import { fmtDate } from '../../../shared/lib.js';
import { useWs } from '../../context.jsx';
import { tr } from '../../../shared/i18n.jsx';

// The announcements of an api, across its versions, like a blog on its page in the portal: published
// at once, its subscribers told in their notifications; corrected or deleted afterwards, nobody told
// again.
export function AnnouncementsTab({ api, readOnly }) {
  const { wapi } = useWs();
  const toast = useToast();
  const confirm = useConfirm();
  const state = useLoad(() => wapi.get(`/apis/${api.id}/announcements`), [api.id]);
  const page = useLocalPaging(state.data, { prefix: 'ann', size: 10, text: (x) => `${x.title} ${x.body} ${x.author_name || ''}` });
  // null: no form; {}: a new one; an announcement: corrected
  const [editing, setEditing] = useState(null);
  // the announcement read in full, from the url
  const [params, setParams] = useQuery();
  const opened = (state.data || []).find((x) => x.id === params.get('open'));

  const remove = async (n) => {
    if (!(await confirm({ title: tr('Delete the announcement {0}?', [n.title]), message: tr('It leaves the page of the API in the portal; the notifications already sent stay.'), danger: true, confirmLabel: tr('Delete') }))) return;
    try {
      await wapi.del(`/apis/${api.id}/announcements/${n.id}`);
      setParams({ open: null });
      toast(tr('Announcement deleted'));
      state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="col gap-16">
      <p className="muted small" style={{ margin: 0 }}>
        {tr('Posts on the page of the API in the portal, for all its versions: its subscribers are told in their notifications when one is published.')}
      </p>
      <ListToolbar paging={page} placeholder={tr('search the announcements')} onReload={state.reload} loading={state.loading}>
        {!readOnly && (
          <button className="btn primary" onClick={() => setEditing({})}>
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
      {opened && !editing && (
        <Modal
          title={opened.title}
          size="wide"
          onClose={() => setParams({ open: null })}
          footer={
            !readOnly && (
              <>
                <button className="btn ghost danger" onClick={() => remove(opened)}>
                  <Icon name="trash" /> {tr('Delete')}
                </button>
                <span className="spacer" />
                <button className="btn" onClick={() => setEditing(opened)}>
                  <Icon name="edit" /> {tr('Edit')}
                </button>
              </>
            )
          }
        >
          <p className="faint small" style={{ marginTop: 0 }}>
            {fmtDate(opened.created_at)}
            {opened.author_name ? ` · ${opened.author_name}` : ''}
            {new Date(opened.updated_at) - new Date(opened.created_at) > 60e3 ? ` · ${tr('updated {0}', [fmtDate(opened.updated_at)])}` : ''}
          </p>
          {opened.body ? <Markdown source={opened.body} /> : <p className="muted">{tr('No text')}</p>}
        </Modal>
      )}
      {editing && <AnnouncementForm api={api} current={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), state.reload())} />}
    </div>
  );
}

function AnnouncementForm({ api, current, onClose, onSaved }) {
  const { wapi } = useWs();
  const toast = useToast();
  const [title, setTitle] = useState(current?.title || '');
  const [body, setBody] = useState(current?.body || '');
  const [notify, setNotify] = useState(true);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      if (current) {
        await wapi.put(`/apis/${api.id}/announcements/${current.id}`, { title, body });
        toast(tr('Announcement updated'));
      } else {
        const r = await wapi.post(`/apis/${api.id}/announcements`, { title, body, notify });
        toast(r.told ? tr('Announcement published: {0} team(s) of subscribers told', [r.told]) : tr('Announcement published'));
      }
      onSaved();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={current ? tr('Edit the announcement') : tr('New announcement')}
      onClose={onClose}
      size="wide"
      footer={
        <button className="btn primary" disabled={!title.trim() || saving} onClick={save}>
          {current ? tr('Save') : tr('Publish')}
        </button>
      }
    >
      <Field label={tr('Title')}>
        <Input value={title} onChange={setTitle} autoFocus maxLength={200} />
      </Field>
      <Field label={tr('Text')} hint={tr('Markdown')}>
        <div className="row gap-6 mb-8">
          <button type="button" className={`btn sm ${preview ? '' : 'primary'}`} onClick={() => setPreview(false)}>
            {tr('Write')}
          </button>
          <button type="button" className={`btn sm ${preview ? 'primary' : ''}`} onClick={() => setPreview(true)}>
            {tr('Preview')}
          </button>
        </div>
        {preview ? <div className="card card-body">{body ? <Markdown source={body} /> : <span className="muted small">{tr('Nothing to preview')}</span>}</div> : <TextArea value={body} onChange={setBody} rows={10} mono />}
      </Field>
      {current ? (
        <p className="muted small">{tr('A correction is not notified again.')}</p>
      ) : (
        <Switch checked={notify} onChange={setNotify} label={tr('Tell the subscribers of every version in their notifications')} />
      )}
    </Modal>
  );
}
