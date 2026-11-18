// Promotion: the same snapshot here as on the installation before this one. Its document comes from
// the Deployment tab of the api over there (Export for promotion), or from
// `apim apis export-snapshot`. A dry run first, as for a deployment.
import React, { useState } from 'react';
import { fmtDate } from '../../shared/lib.js';
import { Badge, Callout, DiffView, FileButton, Modal, Switch, errorMessage, useToast } from '../../shared/ui.jsx';
import { useWs } from '../context.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

const REF_STATUS = {
  resolved: ['positive', 'resolved by this gateway'],
  missing: ['negative', 'missing on this gateway'],
  unverifiable: ['', 'read on the gateway nodes: not checked'],
};
const refStatus = (s) => ({ resolved: tr('resolved by this gateway'), missing: tr('missing on this gateway'), unverifiable: tr('read on the gateway nodes: not checked') })[s];

// the gateway diff of an Api it does not hold yet is the whole entity
const gatewayChanges = (changes) => (changes || []).map((c) => (c.path ? c : { op: 'add', path: 'Api', after: tr('new on this gateway') }));

function Preview({ plan }) {
  const s = plan.source;
  return (
    <div className="col gap-16">
      <div className="col gap-4">
        <div>
          <Tr text={'Snapshot {0} of {1} {2}, published {3}{4} on {5} (workspace {6}){7}.'} args={[<span className="bold">#{s.snapshot.number}</span>, <span className="bold">{s.api.name}</span>, s.api.version, fmtDate(s.snapshot.published_at), s.snapshot.published_by ? tr(' by {0}', [s.snapshot.published_by]) : '', <span className="bold">{s.installation}</span>, s.workspace, s.snapshot.comment ? ` — ${s.snapshot.comment}` : '']} />
        </div>
        <div className="faint tiny mono">{plan.digest}</div>
      </div>
      <div>
        <Tr text={'It lands in the api {0} {1}{2}.'} args={[<span className="bold">{plan.api.slug}</span>, plan.api.version, plan.api.created ? (
          <>
            , <Badge kind="info">{tr('created by this promotion')}</Badge> {plan.api.team ? tr('for the team {0}', [plan.api.team]) : tr('with no team')}
          </>
        ) : plan.running ? (
          tr(', where snapshot #{0} runs', [plan.running.number])
        ) : (
          tr(', where nothing runs yet')
        )]} />
      </div>
      {plan.already && <Callout kind="info"><Tr text={'Already here, as snapshot #{0}: promoting it again only deploys it.'} args={[plan.already.number]} /></Callout>}
      {plan.changes && (
        <div className="col gap-6">
          <h4 style={{ margin: 0 }}>{tr('Compared with what runs here')}</h4>
          <DiffView changes={plan.changes} empty={tr('The same document as the one that runs here.')} />
        </div>
      )}
      <div className="col gap-6">
        <h4 style={{ margin: 0 }}>{tr('On the gateway, at deployment')}</h4>
        <DiffView changes={gatewayChanges(plan.gateway.changes)} empty={tr('Nothing: the gateway already holds exactly this.')} />
        {plan.gateway.error && <Callout kind="warning"><Tr text={'The gateway did not answer: {0}'} args={[plan.gateway.error]} /></Callout>}
      </div>
      {plan.vault_refs.length > 0 && (
        <div className="col gap-6">
          <h4 style={{ margin: 0 }}>{tr('Values of this environment')}</h4>
          <p className="muted small m-0">{tr('The snapshot names them as vault references: each gateway resolves its own.')}</p>
          {plan.vault_refs.map((r) => (
            <div key={r.ref} className="row gap-6">
              <span className="mono small grow">{r.ref}</span>
              <Badge kind={REF_STATUS[r.status][0]}>{refStatus(r.status)}</Badge>
            </div>
          ))}
        </div>
      )}
      {plan.validation.errors.length > 0 && (
        <Callout kind="negative" title={tr('It does not validate on this installation')}>
          <ul style={{ margin: 0 }}>
            {plan.validation.errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </Callout>
      )}
      {plan.warnings.length > 0 && (
        <Callout kind="warning" title={tr('Warnings')}>
          <ul style={{ margin: 0 }}>
            {plan.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

export function PromoteModal({ onClose, onDone }) {
  const { wapi } = useWs();
  const toast = useToast();
  const [doc, setDoc] = useState(null);
  const [plan, setPlan] = useState(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async (text) => {
    setPlan(null);
    try {
      const d = JSON.parse(text);
      setDoc(d);
      setPlan(await wapi.post('/promotions', { document: d, dry_run: true }));
    } catch (e) {
      setDoc(null);
      toast(errorMessage(e), 'error');
    }
  };
  const run = async (deploy) => {
    setBusy(true);
    try {
      const r = await wapi.post('/promotions', { document: doc, deploy, replace_draft: replace });
      toast(r.promoted ? tr('Promoted as snapshot #{0}{1}', [r.snapshot.number, deploy ? tr(', deployment requested') : '']) : tr('Already here as snapshot #{0}{1}', [r.snapshot.number, deploy ? tr(': deployment requested') : '']));
      onDone(r);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const blocked = !plan || plan.validation.errors.length > 0 || (plan.draft.pending && !replace && !plan.already);
  return (
    <Modal
      title={tr('Promote a snapshot')}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn" disabled={busy || blocked || !!plan?.already} onClick={() => run(false)}>
            {tr('Promote')}
          </button>
          <button className="btn primary" disabled={busy || blocked} onClick={() => run(true)}>
            {plan?.already ? tr('Deploy it') : tr('Promote and deploy')}
          </button>
        </>
      }
    >
      <div className="col gap-16">
        <p className="muted small m-0">
          <Tr text={'The same immutable snapshot as on the installation before this one: export it from the Deployment tab of the api over there, or with {0}. Nothing changes here before you confirm.'} args={[<span className="mono">{tr('apim apis export-snapshot')}</span>]} />
        </p>
        <FileButton accept=".json,application/json" onFile={load} className="btn">
          {doc ? tr('Another document…') : tr('Choose the promotion document…')}
        </FileButton>
        {plan && <Preview plan={plan} />}
        {plan?.draft.pending && !plan.already && (
          <Callout kind="warning" title={tr('The draft here has changes that are not in a snapshot')}>
            <div className="col gap-6">
              <span>{tr('Promoting replaces the draft with the snapshot: publish those changes first if they matter.')}</span>
              <Switch checked={replace} onChange={setReplace} label={tr('Replace the draft with the snapshot')} />
            </div>
          </Callout>
        )}
      </div>
    </Modal>
  );
}
