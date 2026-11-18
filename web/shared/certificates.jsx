// A list of certificates read by the product: the trusted CAs of an mtls plan, the client
// certificates of an application. The browser cannot read X.509: `inspect` asks the server.
import React, { useState } from 'react';
import { fmtDate } from './lib.js';
import { Badge, Callout, Field, Icon, Modal, Setting, errorMessage, useLoad } from './ui.jsx';
import { CodeEditor } from './code-editor.jsx';

const EN = {
  ca: 'CA',
  notCa: 'not a CA',
  selfSigned: 'self-signed',
  validUntil: 'valid until',
  issuerAs: 'Otoroshi sees the issuer of what it signs as',
  unpredictable: 'its subject cannot be predicted in Otoroshi’s form: give the issuer patterns',
  identifiedAs: 'the plans that read the CN identify the application as',
  useAsClientId: 'use as the expected client_id',
  issuedBy: 'issued by',
  remove: 'remove',
  cancel: 'Cancel',
  add: 'Add',
  incomplete: 'paste the whole certificate, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----',
};

const cnOf = (subject) => /CN=([^,]+)/.exec(subject || '')?.[1] || null;

export function CertificateFacts({ info, mode = 'ca', labels = {}, clientId, onClientId }) {
  const L = { ...EN, ...labels };
  if (!info) return null;
  if (info.error) return <Callout kind="negative">{info.error}</Callout>;
  const cn = cnOf(info.subject);
  return (
    <div className="col gap-4">
      <div className="row gap-6 wrap">
        <span className="bold small">{info.subject}</span>
        {mode === 'ca' && (info.ca ? <Badge kind="positive">{L.ca}</Badge> : <Badge kind="warning">{L.notCa}</Badge>)}
        {info.subject === info.issuer && <Badge>{L.selfSigned}</Badge>}
      </div>
      <div className="faint tiny">
        {L.validUntil} {fmtDate(info.validTo)} · sha-256 {info.fingerprint.slice(0, 23)}…{mode === 'client' && info.subject !== info.issuer ? ` · ${L.issuedBy} ${info.issuer}` : ''}
      </div>
      {mode === 'ca' ? (
        <div className="faint tiny">
          {info.dn ? (
            <>
              {L.issuerAs} <span className="mono">{info.dn}</span>
            </>
          ) : (
            L.unpredictable
          )}
        </div>
      ) : (
        cn && (
          <div className="row gap-6 faint tiny">
            <span>
              {L.identifiedAs} <span className="mono">{cn}</span>
            </span>
            {onClientId && cn !== clientId && (
              <button type="button" className="btn xs" onClick={() => onClientId(cn)}>
                {L.useAsClientId}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}

function AddCertificate({ inspect, mode, labels, title, help, onAdd, onClose }) {
  const L = { ...EN, ...labels };
  const [pem, setPem] = useState('');
  const complete = /-----END CERTIFICATE-----\s*$/.test(pem);
  const info = useLoad(() => (complete ? inspect(pem).catch((e) => ({ error: errorMessage(e) })) : Promise.resolve(null)), [pem]);
  return (
    <Modal
      title={title}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {L.cancel}
          </button>
          <button className="btn primary" disabled={!info.data || !!info.data.error} onClick={() => onAdd(pem.trim())}>
            {L.add}
          </button>
        </>
      }
    >
      <p className="muted small">{help}</p>
      <CodeEditor value={pem} onChange={setPem} language="plaintext" minHeight={200} maxHeight={360} ariaLabel={title} placeholder="-----BEGIN CERTIFICATE-----" />
      {pem.trim() && !complete && <div className="hint">{L.incomplete}</div>}
      <CertificateFacts info={info.data} mode={mode} labels={labels} />
    </Modal>
  );
}

// label / help: of the setting; addLabel, addTitle, addHelp: of the button and its modal
// layout: 'setting' (a label on the left, the console) or 'field' (a label above, the portal)
export function CertificateList({ value = [], onChange, inspect, mode = 'ca', label, help, addLabel, addTitle, addHelp, labels = {}, readOnly = false, clientId, onClientId, layout = 'setting' }) {
  const L = { ...EN, ...labels };
  const [adding, setAdding] = useState(false);
  const infos = useLoad(() => Promise.all(value.map((pem) => inspect(pem).catch((e) => ({ error: errorMessage(e) })))), [value.join('|')]);
  const Wrap = layout === 'field' ? FieldWrap : Setting;
  return (
    <Wrap label={label} help={help}>
      {value.map((pem, i) => (
        <div key={i} className="panel row" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <CertificateFacts info={infos.data?.[i]} mode={mode} labels={labels} clientId={clientId} onClientId={readOnly ? null : onClientId} />
          </div>
          {!readOnly && (
            <button type="button" className="btn ghost sm icon" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={L.remove}>
              <Icon name="trash" />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
          <Icon name="plus" /> {addLabel}
        </button>
      )}
      {adding && (
        <AddCertificate
          inspect={inspect}
          mode={mode}
          labels={labels}
          title={addTitle}
          help={addHelp}
          onClose={() => setAdding(false)}
          onAdd={(pem) => {
            if (!value.includes(pem)) onChange([...value, pem]);
            setAdding(false);
          }}
        />
      )}
    </Wrap>
  );
}

function FieldWrap({ label, help, children }) {
  return (
    <Field label={label} hint={help}>
      <div className="col gap-6">{children}</div>
    </Field>
  );
}
