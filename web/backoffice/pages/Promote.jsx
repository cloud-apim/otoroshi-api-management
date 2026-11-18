// Promotion: the same snapshot here as on the installation before this one. Its document comes from
// the Deployment tab of the api over there (Export for promotion), or from
// `apim apis export-snapshot`. A dry run first, as for a deployment.
import React, { useState } from 'react';
import { fmtDate } from '../../shared/lib.js';
import { Badge, Callout, DiffView, FileButton, Modal, Switch, errorMessage, useToast } from '../../shared/ui.jsx';
import { useWs } from '../context.jsx';

const REF_STATUS = {
  resolved: ['positive', 'resolved by this gateway'],
  missing: ['negative', 'missing on this gateway'],
  unverifiable: ['', 'read on the gateway nodes: not checked'],
};

// the gateway diff of an Api it does not hold yet is the whole entity
const gatewayChanges = (changes) => (changes || []).map((c) => (c.path ? c : { op: 'add', path: 'Api', after: 'new on this gateway' }));

function Preview({ plan }) {
  const s = plan.source;
  return (
    <div className="col gap-16">
      <div className="col gap-4">
        <div>
          Snapshot <span className="bold">#{s.snapshot.number}</span> of <span className="bold">{s.api.name}</span> {s.api.version}, published {fmtDate(s.snapshot.published_at)}
          {s.snapshot.published_by ? ` by ${s.snapshot.published_by}` : ''} on <span className="bold">{s.installation}</span> (workspace {s.workspace})
          {s.snapshot.comment ? ` — ${s.snapshot.comment}` : ''}.
        </div>
        <div className="faint tiny mono">{plan.digest}</div>
      </div>
      <div>
        It lands in the api <span className="bold">{plan.api.slug}</span> {plan.api.version}
        {plan.api.created ? (
          <>
            , <Badge kind="info">created by this promotion</Badge> {plan.api.team ? `for the team ${plan.api.team}` : 'with no team'}
          </>
        ) : plan.running ? (
          `, where snapshot #${plan.running.number} runs`
        ) : (
          ', where nothing runs yet'
        )}
        .
      </div>
      {plan.already && <Callout kind="info">Already here, as snapshot #{plan.already.number}: promoting it again only deploys it.</Callout>}
      {plan.changes && (
        <div className="col gap-6">
          <h4 style={{ margin: 0 }}>Compared with what runs here</h4>
          <DiffView changes={plan.changes} empty="The same document as the one that runs here." />
        </div>
      )}
      <div className="col gap-6">
        <h4 style={{ margin: 0 }}>On the gateway, at deployment</h4>
        <DiffView changes={gatewayChanges(plan.gateway.changes)} empty="Nothing: the gateway already holds exactly this." />
        {plan.gateway.error && <Callout kind="warning">The gateway did not answer: {plan.gateway.error}</Callout>}
      </div>
      {plan.vault_refs.length > 0 && (
        <div className="col gap-6">
          <h4 style={{ margin: 0 }}>Values of this environment</h4>
          <p className="muted small m-0">The snapshot names them as vault references: each gateway resolves its own.</p>
          {plan.vault_refs.map((r) => (
            <div key={r.ref} className="row gap-6">
              <span className="mono small grow">{r.ref}</span>
              <Badge kind={REF_STATUS[r.status][0]}>{REF_STATUS[r.status][1]}</Badge>
            </div>
          ))}
        </div>
      )}
      {plan.validation.errors.length > 0 && (
        <Callout kind="negative" title="It does not validate on this installation">
          <ul style={{ margin: 0 }}>
            {plan.validation.errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </Callout>
      )}
      {plan.warnings.length > 0 && (
        <Callout kind="warning" title="Warnings">
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
      toast(r.promoted ? `Promoted as snapshot #${r.snapshot.number}${deploy ? ', deployment requested' : ''}` : `Already here as snapshot #${r.snapshot.number}${deploy ? ': deployment requested' : ''}`);
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
      title="Promote a snapshot"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || blocked || !!plan?.already} onClick={() => run(false)}>
            Promote
          </button>
          <button className="btn primary" disabled={busy || blocked} onClick={() => run(true)}>
            {plan?.already ? 'Deploy it' : 'Promote and deploy'}
          </button>
        </>
      }
    >
      <div className="col gap-16">
        <p className="muted small m-0">
          The same immutable snapshot as on the installation before this one: export it from the Deployment tab of the api over there, or with <span className="mono">apim apis export-snapshot</span>. Nothing changes
          here before you confirm.
        </p>
        <FileButton accept=".json,application/json" onFile={load} className="btn">
          {doc ? 'Another document…' : 'Choose the promotion document…'}
        </FileButton>
        {plan && <Preview plan={plan} />}
        {plan?.draft.pending && !plan.already && (
          <Callout kind="warning" title="The draft here has changes that are not in a snapshot">
            <div className="col gap-6">
              <span>Promoting replaces the draft with the snapshot: publish those changes first if they matter.</span>
              <Switch checked={replace} onChange={setReplace} label="Replace the draft with the snapshot" />
            </div>
          </Callout>
        )}
      </div>
    </Modal>
  );
}
