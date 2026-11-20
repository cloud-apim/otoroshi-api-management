// The gateway objects a plan's auth mechanism needs, described in the plan and derived by the
// product: the trusted CAs of an mtls plan, the authorization server of an oauth2-remote plan.
import React, { useState } from 'react';
import { Callout, Field, Icon, Input, Seg, Select, Setting, Switch, TagsInput, errorMessage } from '../../../shared/ui.jsx';
import { CertificateList } from '../../../shared/certificates.jsx';
import { api as rootApi } from '../../context.jsx';
import { tr, Tr } from '../../../shared/i18n.jsx';

const inspect = (pem) => rootApi.post('/certificates/inspect', { pem });

export function TrustedCAs({ value = [], onChange }) {
  return (
    <CertificateList
      value={value}
      onChange={onChange}
      inspect={inspect}
      mode="ca"
      label={tr('Trusted CAs')}
      help={tr('derived as certificates of the gateway: the plan accepts the client certificates they signed, and nothing else')}
      addLabel={tr('Trust a CA')}
      addTitle={tr('Trust a certificate authority')}
      addHelp={tr("The CA certificate (PEM) that signs the client certificates of this plan's consumers. The product derives it as a certificate of the gateway, marked as its own, and removes it with the api. No private key: only the certificate.")}
      labels={{ add: tr('Trust it') }}
    />
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
      // the issuer the tokens of that server carry
      if (r.issuer && !config.issuer) setAuthConfig({ issuer: r.issuer });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Setting
        label={tr('Authorization server')}
        help={tr('describe it and the product derives the Otoroshi auth module the plan validates tokens with, keeps it reconciled and removes it with the api — or reference an existing module')}
      >
        <Seg
          value={d.enabled ? 'derive' : 'reference'}
          onChange={(v) => setD({ enabled: v === 'derive' })}
          options={[
            { value: 'derive', label: tr('Describe it') },
            { value: 'reference', label: tr('Reference an auth module') },
          ]}
        />
        {d.enabled ? (
          <>
            <Field label={tr('Discovery')} hint={tr('the server, or its .well-known/openid-configuration: fills the urls below')}>
              <div className="row" style={{ width: '100%' }}>
                <div className="grow">
                  <Input value={d.discoveryUrl} onChange={(v) => setD({ discoveryUrl: v })} mono placeholder={tr('https://idp.example/realms/partners')} />
                </div>
                <button className="btn" disabled={!d.discoveryUrl || busy} onClick={discover}>
                  <Icon name="search" /> {tr('Discover')}
                </button>
              </div>
            </Field>
            {error && <Callout kind="negative">{error}</Callout>}
            {found && (
              <div className="hint">
                <Tr text={'Found the issuer {0}.'} args={[<span className="mono">{found.issuer || '—'}</span>]} />
              </div>
            )}
            <Field label={tr('JWKS url')} hint={tr('the keys the tokens are signed with')}>
              <Input value={d.jwksUrl} onChange={(v) => setD({ jwksUrl: v })} mono placeholder={tr('https://idp.example/…/jwks')} />
            </Field>
            <Field label={tr('Userinfo url')} hint={tr('where the user profile is fetched, when the plan asks for it')}>
              <Input value={d.userInfoUrl} onChange={(v) => setD({ userInfoUrl: v })} mono placeholder={tr('https://idp.example/…/userinfo')} />
            </Field>
            <div className="grid-2">
              <Field label={tr('Client id')} hint={tr('of the gateway at the server, if it needs one')}>
                <Input value={d.clientId} onChange={(v) => setD({ clientId: v })} mono />
              </Field>
              <Field label={tr('Client secret')}>
                <Input value={d.clientSecret} onChange={(v) => setD({ clientSecret: v })} mono type="password" placeholder={tr('secret, or a vault reference ${vault://…}')} />
              </Field>
            </div>
            <Field label={tr('Scope')}>
              <Input value={d.scope} onChange={(v) => setD({ scope: v })} mono />
            </Field>
          </>
        ) : (
          <>
            <Select
              value={config.verifier}
              onChange={(v) => setAuthConfig({ verifier: v })}
              options={[{ value: '', label: tr('choose…') }, ...(authModules || []).map((v) => ({ value: v.id, label: v.name }))]}
            />
            <Input value={config.verifier} onChange={(v) => setAuthConfig({ verifier: v })} placeholder={tr('or an id')} mono />
          </>
        )}
      </Setting>
      <Setting label={tr('Client id claim')} help={tr("where the consumer's client_id is read in the token")}>
        <Input value={config.clientIdPath} onChange={(v) => setAuthConfig({ clientIdPath: v })} mono />
      </Setting>
      <Setting label={tr('User profile')} help={tr("fetched from the userinfo url and kept in the consumer's metadata")}>
        <Switch checked={config.fetchUser} onChange={(v) => setAuthConfig({ fetchUser: v })} label={tr('Fetch the user profile')} />
      </Setting>
      <Setting label={tr('Issuer')} help={tr('the iss a token must carry, compared exactly: the issuer of the discovery document of the server')}>
        <Input value={config.issuer || ''} onChange={(v) => setAuthConfig({ issuer: v })} mono placeholder={tr('https://idp.example.com')} />
      </Setting>
      <Setting label={tr('Audiences')} help={tr('the token must carry one of them in its aud claim: the audience of this api at the authorization server')}>
        <TagsInput value={config.audiences || []} onChange={(v) => setAuthConfig({ audiences: v })} />
      </Setting>
      {!config.issuer && !(config.audiences || []).length && (
        <Callout kind="warning">{tr('Without an issuer nor an audience, the plan accepts any token signed with the keys of the server — the ones it issued for other clients and other apis included.')}</Callout>
      )}
    </>
  );
}
