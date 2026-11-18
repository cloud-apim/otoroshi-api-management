// The gateway objects a plan's auth mechanism needs, described in the plan and derived by the
// product: the trusted CAs of an mtls plan, the authorization server of an oauth2-remote plan.
import React, { useState } from 'react';
import { fmtDate } from '../../../shared/lib.js';
import { Badge, Callout, Field, Icon, Input, Modal, Seg, Select, Setting, Switch, errorMessage, useLoad } from '../../../shared/ui.jsx';
import { CodeEditor } from '../../../shared/code-editor.jsx';
import { api as rootApi } from '../../context.jsx';

const inspect = (pem) => rootApi.post('/certificates/inspect', { pem });

function CertificateFacts({ info }) {
  if (!info) return null;
  if (info.error) return <Callout kind="negative">{info.error}</Callout>;
  return (
    <div className="col gap-4">
      <div className="row gap-6 wrap">
        <span className="bold small">{info.subject}</span>
        {info.ca ? <Badge kind="positive">CA</Badge> : <Badge kind="warning">not a CA</Badge>}
        {info.subject === info.issuer && <Badge>self-signed</Badge>}
      </div>
      <div className="faint tiny">
        valid until {fmtDate(info.validTo)} · sha-256 {info.fingerprint.slice(0, 23)}…
      </div>
      <div className="faint tiny">{info.dn ? <>Otoroshi sees the issuer of what it signs as <span className="mono">{info.dn}</span></> : 'its subject cannot be predicted in Otoroshi’s form: give the issuer patterns'}</div>
    </div>
  );
}

function AddCertificate({ onAdd, onClose }) {
  const [pem, setPem] = useState('');
  const complete = /-----END CERTIFICATE-----\s*$/.test(pem);
  const info = useLoad(() => (complete ? inspect(pem).catch((e) => ({ error: errorMessage(e) })) : Promise.resolve(null)), [pem]);
  return (
    <Modal
      title="Trust a certificate authority"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!info.data || !!info.data.error} onClick={() => onAdd(pem.trim())}>
            Trust it
          </button>
        </>
      }
    >
      <p className="muted small">
        The CA certificate (PEM) that signs the client certificates of this plan&apos;s consumers. The product derives it as a certificate of the gateway, marked as its own, and removes it with
        the api. No private key: only the certificate.
      </p>
      <CodeEditor value={pem} onChange={setPem} language="plaintext" minHeight={200} maxHeight={360} ariaLabel="ca certificate" placeholder="-----BEGIN CERTIFICATE-----" />
      <CertificateFacts info={info.data} />
    </Modal>
  );
}

export function TrustedCAs({ value = [], onChange, hasIssuerPatterns }) {
  const [adding, setAdding] = useState(false);
  const infos = useLoad(() => Promise.all(value.map((pem) => inspect(pem).catch((e) => ({ error: errorMessage(e) })))), [value.join('|')]);
  return (
    <Setting
      label="Trusted CAs"
      help={
        hasIssuerPatterns
          ? 'derived as certificates of the gateway; the issuer patterns below decide which certificates the plan accepts'
          : 'derived as certificates of the gateway; with no issuer pattern, the plan accepts the certificates they signed and nothing else'
      }
    >
      {value.map((pem, i) => (
        <div key={i} className="panel row" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <CertificateFacts info={infos.data?.[i]} />
          </div>
          <button className="btn ghost sm icon" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="remove">
            <Icon name="trash" />
          </button>
        </div>
      ))}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
        <Icon name="plus" /> Trust a CA
      </button>
      {adding && (
        <AddCertificate
          onClose={() => setAdding(false)}
          onAdd={(pem) => {
            if (!value.includes(pem)) onChange([...value, pem]);
            setAdding(false);
          }}
        />
      )}
    </Setting>
  );
}

export function AuthorizationServer({ config, setAuthConfig, authModules }) {
  const d = { discoveryUrl: '', jwksUrl: '', userInfoUrl: '', clientId: '', clientSecret: '', scope: 'openid', ...(config.derive || {}) };
  const setD = (patch) => setAuthConfig({ derive: { ...d, ...patch } });
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);
  const [error, setError] = useState(null);
  const discover = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await rootApi.post('/oidc/discovery', { url: d.discoveryUrl });
      setFound(r);
      setD({ discoveryUrl: r.discoveryUrl, jwksUrl: r.jwksUrl || d.jwksUrl, userInfoUrl: r.userInfoUrl || d.userInfoUrl });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Setting
        label="Authorization server"
        help="describe it and the product derives the Otoroshi auth module the plan validates tokens with, keeps it reconciled and removes it with the api — or reference an existing module"
      >
        <Seg
          value={d.enabled ? 'derive' : 'reference'}
          onChange={(v) => setD({ enabled: v === 'derive' })}
          options={[
            { value: 'derive', label: 'Describe it' },
            { value: 'reference', label: 'Reference an auth module' },
          ]}
        />
        {d.enabled ? (
          <>
            <Field label="Discovery" hint="the server, or its .well-known/openid-configuration: fills the urls below">
              <div className="row" style={{ width: '100%' }}>
                <div className="grow">
                  <Input value={d.discoveryUrl} onChange={(v) => setD({ discoveryUrl: v })} mono placeholder="https://idp.example/realms/partners" />
                </div>
                <button className="btn" disabled={!d.discoveryUrl || busy} onClick={discover}>
                  <Icon name="search" /> Discover
                </button>
              </div>
            </Field>
            {error && <Callout kind="negative">{error}</Callout>}
            {found && (
              <div className="hint">
                Found the issuer <span className="mono">{found.issuer || '—'}</span>.
              </div>
            )}
            <Field label="JWKS url" hint="the keys the tokens are signed with">
              <Input value={d.jwksUrl} onChange={(v) => setD({ jwksUrl: v })} mono placeholder="https://idp.example/…/jwks" />
            </Field>
            <Field label="Userinfo url" hint="where the user profile is fetched, when the plan asks for it">
              <Input value={d.userInfoUrl} onChange={(v) => setD({ userInfoUrl: v })} mono placeholder="https://idp.example/…/userinfo" />
            </Field>
            <div className="grid-2">
              <Field label="Client id" hint="of the gateway at the server, if it needs one">
                <Input value={d.clientId} onChange={(v) => setD({ clientId: v })} mono />
              </Field>
              <Field label="Client secret">
                <Input value={d.clientSecret} onChange={(v) => setD({ clientSecret: v })} mono type="password" placeholder="secret, or a vault reference ${vault://…}" />
              </Field>
            </div>
            <Field label="Scope">
              <Input value={d.scope} onChange={(v) => setD({ scope: v })} mono />
            </Field>
          </>
        ) : (
          <>
            <Select
              value={config.verifier}
              onChange={(v) => setAuthConfig({ verifier: v })}
              options={[{ value: '', label: 'choose…' }, ...(authModules || []).map((v) => ({ value: v.id, label: v.name }))]}
            />
            <Input value={config.verifier} onChange={(v) => setAuthConfig({ verifier: v })} placeholder="or an id" mono />
          </>
        )}
      </Setting>
      <Setting label="Client id claim" help="where the consumer's client_id is read in the token">
        <Input value={config.clientIdPath} onChange={(v) => setAuthConfig({ clientIdPath: v })} mono />
      </Setting>
      <Setting label="User profile" help="fetched from the userinfo url and kept in the consumer's metadata">
        <Switch checked={config.fetchUser} onChange={(v) => setAuthConfig({ fetchUser: v })} label="Fetch the user profile" />
      </Setting>
      <Callout kind="warning">On Otoroshi 18 an oauth2-remote plan checks the signature and the dates of the token, not its issuer nor its audience (upstream gap G-15).</Callout>
    </>
  );
}
