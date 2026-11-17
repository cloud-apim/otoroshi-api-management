import React, { useState } from 'react';
import { useQuery } from '../../shared/router.jsx';
import { fmtDate } from '../../shared/lib.js';
import { Badge, Empty, JsonBlock, Loader, Modal, useLoad } from '../../shared/ui.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';

// audit is a first-level entry, without a padlock (D-27, E5)
export function AuditPage() {
  const { wapi, slug } = useWs();
  const [params, setParams] = useQuery();
  const action = params.get('action') || '';
  const state = useLoad(() => wapi.get(`/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`), [slug, action]);
  const [open, setOpen] = useState(null);
  return (
    <div className="page">
      <PageHead title="Audit" sub="Every write of the admin api, and the reads that touch personal data or secrets (request logs, credentials). Written by the api itself: nothing escapes it." />
      <div className="row mb-16">
        <input className="input" style={{ maxWidth: 320 }} placeholder="filter by action prefix: api., subscription., credential.read…" value={action} onChange={(e) => setParams({ action: e.target.value })} aria-label="filter by action" />
      </div>
      <Loader state={state}>
        {(events) =>
          events.length ? (
            <div className="card table-wrap">
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
                  {events.map((e) => (
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
          ) : (
            <div className="card">
              <Empty title="No event" icon="audit" />
            </div>
          )
        }
      </Loader>
      {open && (
        <Modal title={open.action} size="wide" onClose={() => setOpen(null)}>
          <JsonBlock value={open} />
        </Modal>
      )}
    </div>
  );
}
