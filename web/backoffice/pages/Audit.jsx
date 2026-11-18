import React, { useState } from 'react';
import { useQuery } from '../../shared/router.jsx';
import { fmtDate } from '../../shared/lib.js';
import { Badge, Empty, Loader, Modal, useLoad } from '../../shared/ui.jsx';
import { CodeView } from '../../shared/code-editor.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';
import { ListToolbar, Pager, usePaging } from '../../shared/lists.jsx';

// audit is a first-level entry, without a padlock
export function AuditPage() {
  const { wapi, slug } = useWs();
  const [params, setParams] = useQuery();
  const action = params.get('action') || '';
  const paging = usePaging({ size: 50 });
  const state = useLoad(() => wapi.get(`/audit?${paging.query}${action ? `&action=${encodeURIComponent(action)}` : ''}`), [slug, action, paging.key]);
  const [open, setOpen] = useState(null);
  return (
    <div className="page">
      <PageHead title="Audit" sub="Every write of the admin api, and the reads that touch personal data or secrets (request logs, credentials). Written by the api itself: nothing escapes it." />
      <ListToolbar paging={paging} placeholder="search actions, summaries, people, entities" onReload={state.reload} loading={state.loading}>
        <input className="input" style={{ maxWidth: 260 }} placeholder="action prefix: api., subscription.…" value={action} onChange={(e) => setParams({ action: e.target.value, page: null })} aria-label="filter by action prefix" />
      </ListToolbar>
      <Loader state={state}>
        {(page) =>
          page.items.length ? (
            <div className="card">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Who</th>
                      <th>Action</th>
                      <th>What</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((e) => (
                      <tr key={e.id} className="clickable" onClick={() => setOpen(e)}>
                        <td className="nowrap muted small">{fmtDate(e.at)}</td>
                        <td className="small">
                          {e.actor?.email} <span className="faint tiny">via {e.actor?.via}</span>
                        </td>
                        <td>
                          <Badge kind={e.action.endsWith('.read') ? 'info' : e.action.includes('delete') || e.action.includes('reject') ? 'negative' : ''}>{e.action}</Badge>
                        </td>
                        <td className="small">{e.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager paging={paging} total={page.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={paging.q || action ? 'No event matches' : 'No event'} icon="audit" />
            </div>
          )
        }
      </Loader>
      {open && (
        <Modal title={open.action} size="wide" onClose={() => setOpen(null)}>
          <CodeView value={open} maxHeight={600} ariaLabel="audit event" />
        </Modal>
      )}
    </div>
  );
}
