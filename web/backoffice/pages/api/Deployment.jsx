import React, { useState } from 'react';
import { fmtDate, fmtRelative } from '../../../shared/lib.js';
import { Callout, DiffView, Icon, Loader, Modal, StatusBadge, errorMessage, useConfirm, useLoad, useToast } from '../../../shared/ui.jsx';
import { useWs } from '../../context.jsx';
import { CodeView } from '../../../shared/code-editor.jsx';

function SnapshotView({ api, number, onClose }) {
  const { wapi } = useWs();
  const state = useLoad(() => wapi.get(`/apis/${api.id}/snapshots/${number}`), [number]);
  return (
    <Modal title={`Snapshot #${number}`} size="xwide" onClose={onClose}>
      <Loader state={state}>
        {(s) => (
          <>
            <p className="muted small">
              Published {fmtDate(s.published_at)} {s.comment ? `— ${s.comment}` : ''}. Immutable: it can be redeployed, never edited.
            </p>
            <CodeView value={s.content} maxHeight={620} ariaLabel={`snapshot ${number}`} />
          </>
        )}
      </Loader>
    </Modal>
  );
}

export function DeploymentTab({ api, readOnly, onDeploy, reload }) {
  const { wapi } = useWs();
  const toast = useToast();
  const confirm = useConfirm();
  const snaps = useLoad(() => wapi.get(`/apis/${api.id}/snapshots`), [api.id]);
  const deps = useLoad(() => wapi.get(`/apis/${api.id}/deployments`), [api.id]);
  const projection = useLoad(() => wapi.get(`/apis/${api.id}/projection`), [api.id]);
  const [viewing, setViewing] = useState(null);
  const current = api.deployment.current;
  const recheck = async () => {
    try {
      await wapi.post('/drift');
      projection.reload();
      toast('Drift detection done');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="col gap-24">
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <Icon name="rocket" />
            <h3 className="grow">Deployed state</h3>
            {!readOnly && current && (
              <button
                className="btn sm danger"
                onClick={async () => {
                  if (!(await confirm({ title: 'Undeploy?', message: `The Api entity is removed from the gateway: calls to ${api.base_url} return 404. Subscriptions stay in the product and are projected again at the next deployment.`, danger: true, confirmLabel: 'Undeploy' }))) return;
                  try {
                    await wapi.post(`/apis/${api.id}/undeploy`);
                    toast('Undeployed');
                    reload();
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                Undeploy
              </button>
            )}
          </div>
          <div className="card-body">
            <dl className="kv">
              <dt>Running</dt>
              <dd>{current ? `snapshot #${current.snapshot_number}, since ${fmtRelative(current.at)}` : 'nothing'}</dd>
              <dt>Latest snapshot</dt>
              <dd>{api.deployment.latest_snapshot ? `#${api.deployment.latest_snapshot.number}` : '—'}</dd>
              <dt>State</dt>
              <dd>{api.deployment.out_of_sync ? <StatusBadge status="drifted" label="out of sync" /> : <StatusBadge status="in_sync" label="up to date" />}</dd>
              <dt>Target</dt>
              <dd>the installation's Otoroshi cluster (one per installation)</dd>
            </dl>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <Icon name="gateway" />
            <h3 className="grow">Gateway drift</h3>
            <button className="btn sm" onClick={recheck}>
              <Icon name="refresh" /> Check now
            </button>
          </div>
          <div className="card-body col">
            <Loader state={projection}>
              {(p) =>
                p.drift ? (
                  <>
                    <div className="row">
                      <StatusBadge status={p.drift.status} />
                      <span className="faint small">checked {fmtRelative(p.drift.checked_at)}</span>
                    </div>
                    {p.drift.status === 'drifted' && (
                      <>
                        <p className="small muted">Someone changed the projected entity directly on the gateway. Redeploying the running snapshot puts it back; adopting the change means editing the draft.</p>
                        <DiffView changes={p.drift.diff} />
                        {!readOnly && current && (
                          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => onDeploy(current.snapshot_id)}>
                            Re-apply snapshot #{current.snapshot_number}
                          </button>
                        )}
                      </>
                    )}
                    {p.drift.status === 'missing' && <Callout kind="negative">The entity is missing on the gateway although it is deployed. Redeploy to restore it.</Callout>}
                  </>
                ) : (
                  <p className="muted small">{current ? 'Not checked yet.' : 'Nothing deployed.'}</p>
                )
              }
            </Loader>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <Icon name="layers" />
          <h3 className="grow">Snapshots</h3>
          <span className="muted small">immutable, append-only — rollback = redeploy an earlier one</span>
        </div>
        <Loader state={snaps}>
          {(list) =>
            list.length ? (
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {list.map((s) => (
                      <tr key={s.id}>
                        <td className="bold">#{s.number}</td>
                        <td>{s.comment || <span className="faint">no comment</span>}</td>
                        <td className="muted small">
                          {fmtDate(s.published_at)} · {s.published_by_email || 'system'}
                        </td>
                        <td>{current?.snapshot_id === s.id && <StatusBadge status="deployed" label="running" />}</td>
                        <td className="actions">
                          <button className="btn sm ghost" onClick={() => setViewing(s.number)}>
                            View
                          </button>
                          {!readOnly && current?.snapshot_id !== s.id && (
                            <button className="btn sm" onClick={() => onDeploy(s.id)}>
                              {current && s.number < current.snapshot_number ? 'Roll back to it' : 'Deploy'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card-body muted small">No snapshot yet: publish the draft.</div>
            )
          }
        </Loader>
      </div>
      <div className="card">
        <div className="card-head">
          <Icon name="audit" />
          <h3 className="grow">Deployment history</h3>
        </div>
        <Loader state={deps}>
          {(d) => (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {d.history.map((x) => (
                    <tr key={x.id}>
                      <td>{x.action === 'undeploy' ? 'undeploy' : `snapshot #${x.snapshot_number}`}</td>
                      <td>
                        <StatusBadge status={x.status} />
                      </td>
                      <td className="muted small">
                        {fmtDate(x.requested_at)} · {x.requested_by_email || 'system'}
                      </td>
                      <td className="small negative-text">{x.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loader>
      </div>
      {viewing && <SnapshotView api={api} number={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
