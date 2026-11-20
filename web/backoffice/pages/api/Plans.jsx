import React, { useState } from 'react';
import { AUTH_LABELS, fmtNumber, fmtWindow } from '../../../shared/lib.js';
import { Badge, Callout, Drawer, Empty, Field, Icon, Input, NumberInput, Seg, Select, Setting, StatusBadge, Switch, TagsInput, TextArea, Tabs, useLoad } from '../../../shared/ui.jsx';
import { api as rootApi, useMetadataFields } from '../../context.jsx';
import { MetadataForm } from '../../../shared/metadata.jsx';
import { AuthorizationServer, TrustedCAs } from './PlanAuth.jsx';
import { tr, Tr } from '../../../shared/i18n.jsx';

const rid = () => `plan_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

const AUTH_DEFAULTS = {
  apikey: { readOnly: false, rotation: { enabled: false, everyHours: 744, graceHours: 168 } },
  jwt: { verifier: '', clientIdPath: 'client_id' },
  mtls: { regexSubjectDNs: [], regexIssuerDNs: [], clientIdField: 'CN', trustedCAs: [] },
  'oauth2-local': { defaultKeyPair: 'otoroshi-jwt-signing', expiration: 3600 },
  'oauth2-remote': {
    verifier: '',
    clientIdPath: 'client_id',
    fetchUser: false,
    derive: { enabled: false, discoveryUrl: '', jwksUrl: '', userInfoUrl: '', clientId: '', clientSecret: '', scope: 'openid' },
  },
  keyless: { expr: '${req.ip}' },
};

const AUTH_HELP = () => ({
  apikey: tr('The subscription mints an Otoroshi apikey (client id / secret). Throttling, quotas and path restrictions are enforced on the key.'),
  'oauth2-local': tr('The gateway is the token endpoint (client_credentials). The subscription mints the client id / secret used to get tokens.'),
  jwt: tr('The consumer calls with a JWT validated by an Otoroshi JWT verifier, identified by a claim: only the client_id of a subscribed application is served.'),
  mtls: tr('The consumer is identified by its client certificate (subject / issuer DN): only the client_id of a subscribed application is served.'),
  'oauth2-remote': tr('Tokens issued by a remote IdP, validated through an Otoroshi auth module: only the client_id of a subscribed application is served.'),
  keyless: tr('No credential: an identity is still derived (e.g. from the IP) so the quotas of the plan apply per caller.'),
});

export function newPlan(kind = 'apikey') {
  return {
    id: rid(),
    name: tr('New plan'),
    description: '',
    status: 'staging',
    auth: { kind, config: AUTH_DEFAULTS[kind] },
    selectionRule: '',
    unit: 'calls',
    rateLimit: { enabled: true, calls: 10, windowMs: 1000 },
    quota: { daily: null, monthly: null },
    counterFailure: 'allow',
    circuitBreaker: 'api',
    resourceFilter: { mode: 'all', resources: [] },
    flowRef: null,
    visibility: 'public',
    acl: [],
    subscribable: true,
    validation: 'auto',
    terms: { enabled: false, url: '', pageSlug: '' },
    usageStatement: { enabled: false, required: false, prompt: tr('What do you plan to build with this API?') },
    pricing: { kind: 'free', amount: 0, currency: 'EUR', interval: 'month', provider: 'stripe', priceRef: '', graceDays: 7 },
    metadata: {},
  };
}

function PlanSummary({ p, draft }) {
  return (
    <div className="col gap-6 small muted">
      <div>
        <Icon name="shield" size={13} /> {tr(AUTH_LABELS[p.auth.kind])}
        {p.selectionRule ? tr(' · with a selection rule') : ''}
      </div>
      <div>
        <Icon name="chart" size={13} /> {p.rateLimit.enabled ? tr('{0} calls / {1}', [fmtNumber(p.rateLimit.calls), fmtWindow(p.rateLimit.windowMs)]) : tr('no rate limit')}
        {p.quota.daily ? tr(' · {0} / day', [fmtNumber(p.quota.daily)]) : ''}
        {p.quota.monthly ? tr(' · {0} / month', [fmtNumber(p.quota.monthly)]) : ''}
      </div>
      <div>
        <Icon name="api" size={13} /> {p.resourceFilter.mode === 'all' ? tr('all resources') : tr('{0} of {1} resources', [p.resourceFilter.resources.length, draft.resources.length])}
        {p.flowRef ? tr(' · + flow {0}', [draft.flows.find((f) => f.id === p.flowRef)?.name || p.flowRef]) : ''}
      </div>
      <div>
        <Icon name="eye" size={13} /> {tr(p.visibility)} · {p.subscribable ? tr('{0} approval', [tr(p.validation)]) : tr('not subscribable')}
        {p.pricing.kind === 'paid' ? ` · ${p.pricing.amount} ${p.pricing.currency}/${tr(p.pricing.interval)}` : tr(' · free')}
      </div>
    </div>
  );
}

export function PlansTab({ draft, setDraft, readOnly, order }) {
  const [editing, setEditing] = useState(null);
  const save = (p) => {
    setDraft((d) => ({ ...d, plans: d.plans.some((x) => x.id === p.id) ? d.plans.map((x) => (x.id === p.id ? p : x)) : [...d.plans, p] }));
    setEditing(null);
  };
  const duplicate = (p) => setEditing({ ...JSON.parse(JSON.stringify(p)), id: rid(), name: `${p.name} (copy)`, status: 'staging' });
  return (
    <div className="col gap-16">
      <div className="row">
        <p className="muted small grow">
          {tr('The policy lives in the plan: adding a tier is a catalogue operation, never an infrastructure one. One API, N plans, N auth mechanisms, on a single set of routes.')}
        </p>
        {!readOnly && (
          <button className="btn primary" onClick={() => setEditing(newPlan())}>
            <Icon name="plus" /> {tr('Add plan')}
          </button>
        )}
      </div>
      {draft.plans.length === 0 ? (
        <div className="card">
          <Empty title={tr('No plan')} icon="layers" action={!readOnly && <button className="btn primary" onClick={() => setEditing(newPlan())}>{tr('Add a plan')}</button>}>
            {tr('On Otoroshi 18 an API without a published plan has open routes.')}
          </Empty>
        </div>
      ) : (
        <div className="grid-3">
          {draft.plans.map((p) => (
            <div key={p.id} className="card plan-card">
              <div className="row">
                <span className="plan-kind">{tr(AUTH_LABELS[p.auth.kind])}</span>
                <span className="spacer" />
                <StatusBadge status={p.status} />
              </div>
              <h3>{p.name}</h3>
              {p.description && <p className="small muted">{p.description}</p>}
              <PlanSummary p={p} draft={draft} />
              {!readOnly && (
                <div className="row mt-8">
                  <button className="btn sm" onClick={() => setEditing(p)}>
                    <Icon name="edit" /> {tr('Edit')}
                  </button>
                  <button className="btn sm ghost" onClick={() => duplicate(p)}>
                    <Icon name="copy" /> {tr('Duplicate')}
                  </button>
                  <span className="spacer" />
                  <button className="btn sm ghost icon" aria-label={tr('delete plan')} onClick={() => setDraft((d) => ({ ...d, plans: d.plans.filter((x) => x.id !== p.id) }))}>
                    <Icon name="trash" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && <PlanEditor value={editing} draft={draft} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PlanEditor({ value, draft, onSave, onClose }) {
  const [p, setP] = useState(value);
  const [section, setSection] = useState('general');
  const refs = useLoad(() => rootApi.get('/gateway/references').catch(() => ({ jwtVerifiers: [], authModules: [], keyPairs: [] })), []);
  const metaFields = useMetadataFields('plan');
  const set = (patch) => setP((x) => ({ ...x, ...patch }));
  const setIn = (key, patch) => setP((x) => ({ ...x, [key]: { ...x[key], ...patch } }));
  const setAuthConfig = (patch) => setP((x) => ({ ...x, auth: { ...x.auth, config: { ...x.auth.config, ...patch } } }));
  const kindChange = (kind) => setP((x) => ({ ...x, auth: { kind, config: AUTH_DEFAULTS[kind] } }));
  const sameKind = draft.plans.filter((x) => x.id !== p.id && x.status === 'published' && x.auth.kind === p.auth.kind);
  const windows = [
    { value: 1000, label: tr('second') },
    { value: 60000, label: tr('minute') },
    { value: 3600000, label: tr('hour') },
    { value: 86400000, label: tr('day') },
  ];
  return (
    <Drawer
      title={value.name}
      subtitle={`plan ${value.id}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" onClick={() => onSave(p)}>
            {tr('Apply to the draft')}
          </button>
        </>
      }
    >
      <Tabs
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'general', label: tr('General') },
          { id: 'access', label: tr('Access') },
          { id: 'limits', label: tr('Limits') },
          { id: 'catalogue', label: tr('Catalogue & approval') },
          { id: 'pricing', label: tr('Pricing') },
        ]}
      />
      {section === 'general' && (
        <div>
          <Setting label={tr('Name')}>
            <Input value={p.name} onChange={(v) => set({ name: v })} />
          </Setting>
          <Setting label={tr('Description')} help={tr('shown to consumers on the portal')}>
            <TextArea value={p.description} onChange={(v) => set({ description: v })} rows={3} />
          </Setting>
          <Setting label={tr('Status')} help={tr('staging: not enforced, not subscribable · published · deprecated: closed to new subscriptions — on Otoroshi 18 its consumers also lose access (G-13) · closed: Otoroshi deletes the keys of its subscriptions')}>
            <Select value={p.status} onChange={(v) => set({ status: v })} options={['staging', 'published', 'deprecated', 'closed']} />
          </Setting>
          <Setting label={tr('Plan plugins')} help={tr("a flow of this api added on top of the route's flow for the consumers of this plan (ApiPlanPlugins.flow_ref)")}>
            <Select value={p.flowRef || ''} onChange={(v) => set({ flowRef: v || null })} options={[{ value: '', label: tr('none') }, ...draft.flows.map((f) => ({ value: f.id, label: f.name }))]} />
          </Setting>
          {metaFields.length > 0 && (
            <Setting label={tr('Metadata')} help={tr('typed fields declared for the plans of this workspace — never projected')}>
              <MetadataForm fields={metaFields} values={p.metadata} onChange={(v) => set({ metadata: v })} />
            </Setting>
          )}
        </div>
      )}
      {section === 'access' && (
        <div>
          <Setting label={tr('Auth mechanism')} help={AUTH_HELP()[p.auth.kind]}>
            <Select value={p.auth.kind} onChange={kindChange} options={Object.entries(AUTH_LABELS).map(([value, label]) => ({ value, label: tr(label) }))} />
          </Setting>
          {p.auth.kind === 'apikey' && (
            <>
              <Setting label={tr('Read only')} help={tr('the key only allows GET, HEAD and OPTIONS')}>
                <Switch checked={p.auth.config.readOnly} onChange={(v) => setAuthConfig({ readOnly: v })} />
              </Setting>
              <Setting label={tr('Secret rotation')} help={tr('Otoroshi rotates the secret itself, with a grace period where both work')}>
                <Switch checked={p.auth.config.rotation?.enabled} onChange={(v) => setAuthConfig({ rotation: { ...p.auth.config.rotation, enabled: v } })} label={tr('Rotate automatically')} />
                {p.auth.config.rotation?.enabled && (
                  <div className="row">
                    <Field label={tr('every (hours)')}>
                      <NumberInput value={p.auth.config.rotation.everyHours} onChange={(v) => setAuthConfig({ rotation: { ...p.auth.config.rotation, everyHours: v } })} />
                    </Field>
                    <Field label={tr('grace (hours)')}>
                      <NumberInput value={p.auth.config.rotation.graceHours} onChange={(v) => setAuthConfig({ rotation: { ...p.auth.config.rotation, graceHours: v } })} />
                    </Field>
                  </div>
                )}
              </Setting>
            </>
          )}
          {p.auth.kind === 'jwt' && (
            <Setting label={tr('Token validation')} help={tr('describe how the tokens are validated and the product derives the Otoroshi JWT verifier, keeps it reconciled and removes it with the api — or reference an existing one')}>
              <Seg
                value={p.auth.config.derive?.enabled ? 'derive' : 'reference'}
                onChange={(v) => setAuthConfig({ derive: { kind: 'jwks', header: 'Authorization', prefix: 'Bearer ', size: 256, ...(p.auth.config.derive || {}), enabled: v === 'derive' } })}
                options={[{ value: 'derive', label: tr('Describe it') }, { value: 'reference', label: tr('Reference a verifier') }]}
              />
              {p.auth.config.derive?.enabled && (
                <>
                  <Select
                    value={p.auth.config.derive.kind}
                    onChange={(v) => setAuthConfig({ derive: { ...p.auth.config.derive, kind: v } })}
                    options={[{ value: 'jwks', label: tr('Signed by the IdP — keys from a JWKS url') }, { value: 'hmac', label: tr('HMAC shared secret') }]}
                  />
                  {p.auth.config.derive.kind === 'jwks' ? (
                    <Input value={p.auth.config.derive.jwksUrl} onChange={(v) => setAuthConfig({ derive: { ...p.auth.config.derive, jwksUrl: v } })} mono placeholder={tr('https://idp/.well-known/jwks.json')} />
                  ) : (
                    <Input value={p.auth.config.derive.secret} onChange={(v) => setAuthConfig({ derive: { ...p.auth.config.derive, secret: v } })} mono type="password" placeholder={tr('secret, or a vault reference ${vault://…}')} />
                  )}
                  <div className="row">
                    <Input value={p.auth.config.derive.issuer} onChange={(v) => setAuthConfig({ derive: { ...p.auth.config.derive, issuer: v } })} mono placeholder={tr('expected issuer (iss)')} />
                    <Input value={p.auth.config.derive.audience} onChange={(v) => setAuthConfig({ derive: { ...p.auth.config.derive, audience: v } })} mono placeholder={tr('expected audience (aud)')} />
                  </div>
                </>
              )}
            </Setting>
          )}
          {p.auth.kind === 'oauth2-remote' && <AuthorizationServer config={p.auth.config} setAuthConfig={setAuthConfig} authModules={refs.data?.authModules} />}
          {p.auth.kind === 'jwt' && !p.auth.config.derive?.enabled && (
            <>
              <Setting label={tr('JWT verifier')} help={tr('infrastructure of the gateway the plan references')}>
                <Select
                  value={p.auth.config.verifier}
                  onChange={(v) => setAuthConfig({ verifier: v })}
                  options={[{ value: '', label: tr('choose…') }, ...(refs.data?.jwtVerifiers || []).map((v) => ({ value: v.id, label: v.name }))]}
                />
                <Input value={p.auth.config.verifier} onChange={(v) => setAuthConfig({ verifier: v })} placeholder={tr('or an id')} mono />
              </Setting>
              <Setting label={tr('Client id claim')} help={tr("where the consumer's client_id is read in the token")}>
                <Input value={p.auth.config.clientIdPath} onChange={(v) => setAuthConfig({ clientIdPath: v })} mono />
              </Setting>
            </>
          )}
          {p.auth.kind === 'mtls' && (
            <>
              <TrustedCAs value={p.auth.config.trustedCAs || []} onChange={(v) => setAuthConfig({ trustedCAs: v })} hasIssuerPatterns={(p.auth.config.regexIssuerDNs || []).length > 0} />
              <Setting label={tr('Allowed issuer DNs')} help={tr("Java regexes on the issuer DN in Otoroshi's form (OU=…, O=…, CN=…, C=…); empty: derived from the trusted CAs")}>
                <TagsInput value={p.auth.config.regexIssuerDNs} onChange={(v) => setAuthConfig({ regexIssuerDNs: v })} />
              </Setting>
              <Setting label={tr('Allowed subject DNs')} help={tr('Java regexes on the subject DN. Otoroshi accepts a certificate when its subject OR its issuer matches (upstream gap G-16)')}>
                <TagsInput value={p.auth.config.regexSubjectDNs} onChange={(v) => setAuthConfig({ regexSubjectDNs: v })} />
              </Setting>
              <Setting label={tr('Client id field')} help={tr('the certificate field used as client id')}>
                <Input value={p.auth.config.clientIdField} onChange={(v) => setAuthConfig({ clientIdField: v })} mono placeholder={tr('CN')} />
              </Setting>
            </>
          )}
          {p.auth.kind === 'oauth2-local' && (
            <>
              <Setting label={tr('Signing key pair')}>
                <Select value={p.auth.config.defaultKeyPair} onChange={(v) => setAuthConfig({ defaultKeyPair: v })} options={[{ value: 'otoroshi-jwt-signing', label: tr('otoroshi-jwt-signing') }, ...(refs.data?.keyPairs || []).filter((k) => k.id !== 'otoroshi-jwt-signing').map((k) => ({ value: k.id, label: k.name }))]} />
              </Setting>
              <Setting label={tr('Token lifetime (s)')}>
                <NumberInput value={p.auth.config.expiration} onChange={(v) => setAuthConfig({ expiration: v })} />
              </Setting>
            </>
          )}
          {p.auth.kind === 'keyless' && (
            <Setting label={tr('Caller identity')} help={tr('an expression language value the quotas are counted against')}>
              <Input value={p.auth.config.expr} onChange={(v) => setAuthConfig({ expr: v })} mono />
            </Setting>
          )}
          <Setting
            label={tr('Selection rule')}
            help={tr('an expression that disambiguates two plans of the same kind whose extractors can both succeed on a request.{0}', [sameKind.length ? tr(' {0} other published {1} plan(s) exist on this api.', [sameKind.length, p.auth.kind]) : ''])}
          >
            <Input value={p.selectionRule} onChange={(v) => set({ selectionRule: v })} mono placeholder={tr("${token.aud} == 'partner'")} />
            {p.selectionRule && <Callout kind="warning">{tr('Recorded and projected as plan metadata, not yet enforced by Otoroshi 18 (upstream work).')}</Callout>}
          </Setting>
        </div>
      )}
      {section === 'limits' && (
        <div>
          <Setting label={tr('Unit of measure')} help={tr('calls, tokens or an AI budget. Tokens and budget need an LLM backend, out of this version.')}>
            <Select value={p.unit} onChange={(v) => set({ unit: v })} options={[{ value: 'calls', label: tr('Calls') }, { value: 'tokens', label: tr('Tokens (LLM)') }, { value: 'budget', label: tr('Budget (LLM)') }]} />
          </Setting>
          <Setting label={tr('Rate limit')} help={tr('per credential — a credential has its own quotas, nothing is pooled')}>
            <Switch checked={p.rateLimit.enabled} onChange={(v) => setIn('rateLimit', { enabled: v })} label={tr('Limit the rate')} />
            {p.rateLimit.enabled && (
              <div className="row">
                <NumberInput value={p.rateLimit.calls} onChange={(v) => setIn('rateLimit', { calls: v })} style={{ width: 140 }} />
                <span className="muted">{tr('calls per')}</span>
                <Select value={p.rateLimit.windowMs} onChange={(v) => setIn('rateLimit', { windowMs: Number(v) })} options={windows} style={{ width: 140 }} />
              </div>
            )}
          </Setting>
          <Setting label={tr('Quotas')} help={tr('empty = unlimited. On a leader/worker cluster the quota is global, within a few seconds of synchronisation.')}>
            <div className="row">
              <Field label={tr('Daily')}>
                <NumberInput value={p.quota.daily} onChange={(v) => setIn('quota', { daily: v })} placeholder={tr('unlimited')} />
              </Field>
              <Field label={tr('Monthly')}>
                <NumberInput value={p.quota.monthly} onChange={(v) => setIn('quota', { monthly: v })} placeholder={tr('unlimited')} />
              </Field>
            </div>
          </Setting>
          <Setting label={tr('Resource filtering')} help={tr('the resources this plan gives access to. Projected as apikey restrictions — enforced on apikey plans.')}>
            <Select value={p.resourceFilter.mode} onChange={(v) => setIn('resourceFilter', { mode: v })} options={[{ value: 'all', label: tr('All resources') }, { value: 'only', label: tr('Only some resources') }]} />
            {p.resourceFilter.mode === 'only' && (
              <div className="col gap-6">
                {draft.resources.map((r) => (
                  <label key={r.id} className="checkbox small">
                    <input
                      type="checkbox"
                      checked={p.resourceFilter.resources.includes(r.id)}
                      onChange={(e) => setIn('resourceFilter', { resources: e.target.checked ? [...p.resourceFilter.resources, r.id] : p.resourceFilter.resources.filter((x) => x !== r.id) })}
                    />
                    {r.name} <span className="mono faint">{(r.methods.length ? r.methods : ['*']).join(' ')} {r.path}</span>
                  </label>
                ))}
                {p.auth.kind !== 'apikey' && <Callout kind="warning"><Tr text={'Only apikey plans carry restrictions on Otoroshi 18: on a {0} plan this filter is not enforced.'} args={[p.auth.kind]} /></Callout>}
              </div>
            )}
          </Setting>
          <Setting label={tr('Counter failure strategy')} help={tr('when the distributed quota counter is unreachable: availability or protection? Not the same answer for an open free tier and a contractual one.')}>
            <Select value={p.counterFailure} onChange={(v) => set({ counterFailure: v })} options={[{ value: 'allow', label: tr('Let the call pass') }, { value: 'deny', label: tr('Refuse the call') }]} />
          </Setting>
          <Setting label={tr('Circuit breaker granularity')} help={tr('per subscription keeps one abusive consumer from opening the circuit for everyone')}>
            <Select value={p.circuitBreaker} onChange={(v) => set({ circuitBreaker: v })} options={[{ value: 'api', label: tr('Per API') }, { value: 'subscription', label: tr('Per subscription') }]} />
          </Setting>
          {(p.counterFailure !== 'allow' || p.circuitBreaker !== 'api') && <Callout kind="warning">{tr('Recorded and projected as plan metadata, not yet enforced by Otoroshi 18 (upstream work).')}</Callout>}
        </div>
      )}
      {section === 'catalogue' && (
        <div>
          <Callout kind="info">{tr('Nothing in this section is projected on the gateway: it belongs to the portal.')}</Callout>
          <Setting label={tr('Visibility')} help={tr('who sees this plan on the portal')}>
            <Select value={p.visibility} onChange={(v) => set({ visibility: v })} options={[{ value: 'public', label: tr('Public') }, { value: 'authenticated', label: tr('Authenticated') }, { value: 'restricted', label: tr('Restricted (ACL tags)') }]} />
            {p.visibility === 'restricted' && <TagsInput value={p.acl} onChange={(v) => set({ acl: v })} placeholder={tr('user:…, team:…, role:…')} />}
          </Setting>
          <Setting label={tr('Subscribable')} help={tr('an internal tier can be visible but not subscribable')}>
            <Switch checked={p.subscribable} onChange={(v) => set({ subscribable: v })} />
          </Setting>
          <Setting label={tr('Approval')} help={tr('automatic: the key is issued at once · manual: a producer reviews the request')}>
            <Select value={p.validation} onChange={(v) => set({ validation: v })} options={[{ value: 'auto', label: tr('Automatic') }, { value: 'manual', label: tr('Manual review') }]} />
          </Setting>
          <Setting label={tr('Terms of use')} help={tr('the subscriber must accept them')}>
            <Switch checked={p.terms.enabled} onChange={(v) => setIn('terms', { enabled: v })} label={tr('Require terms acceptance')} />
            {p.terms.enabled && <Input value={p.terms.url} onChange={(v) => setIn('terms', { url: v })} placeholder={tr('https://… or a documentation page slug')} />}
          </Setting>
          <Setting label={tr('Usage statement')} help={tr('ask the subscriber what they plan to do with the api')}>
            <Switch checked={p.usageStatement.enabled} onChange={(v) => setIn('usageStatement', { enabled: v })} label={tr('Ask for a usage statement')} />
            {p.usageStatement.enabled && (
              <>
                <Input value={p.usageStatement.prompt} onChange={(v) => setIn('usageStatement', { prompt: v })} />
                <Switch checked={p.usageStatement.required} onChange={(v) => setIn('usageStatement', { required: v })} label={tr('Required')} />
              </>
            )}
          </Setting>
        </div>
      )}
      {section === 'pricing' && (
        <div>
          <Callout kind="info">
            {tr('The product decides access; Stripe decides the money, on the Stripe account the workspace links (Workspace settings › Payments). A paid subscription waits for the payment before its key is projected. Frozen in the snapshot: changing a price is a publication.')}
          </Callout>
          <Setting label={tr('Pricing')}>
            <Select value={p.pricing.kind} onChange={(v) => setIn('pricing', { kind: v })} options={[{ value: 'free', label: tr('Free') }, { value: 'paid', label: tr('Paid') }]} />
          </Setting>
          {p.pricing.kind === 'paid' && (
            <>
              <Setting label={tr('Price')}>
                <div className="row">
                  <NumberInput value={p.pricing.amount} onChange={(v) => setIn('pricing', { amount: v })} />
                  <Select value={p.pricing.currency} onChange={(v) => setIn('pricing', { currency: v })} options={['EUR', 'USD', 'GBP', 'CHF']} style={{ width: 100 }} />
                  <span className="muted">{tr('per')}</span>
                  <Select value={p.pricing.interval} onChange={(v) => setIn('pricing', { interval: v })} options={['month', 'year']} style={{ width: 110 }} />
                </div>
              </Setting>
              <Setting label={tr('Provider price reference')} help={tr('a price at Stripe (price_…): empty, Stripe is given the price of the plan — its amount, its currency, its interval')}>
                <Input value={p.pricing.priceRef} onChange={(v) => setIn('pricing', { priceRef: v })} mono placeholder={tr('price_…')} />
              </Setting>
              <Setting label={tr('Grace period (days)')} help={tr('after a failed payment, before the key is disabled')}>
                <NumberInput value={p.pricing.graceDays} onChange={(v) => setIn('pricing', { graceDays: v })} />
              </Setting>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
