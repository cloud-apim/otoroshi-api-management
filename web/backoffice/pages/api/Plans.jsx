import React, { useState } from 'react';
import { AUTH_LABELS, fmtNumber, fmtWindow } from '../../../shared/lib.js';
import { Badge, Callout, Drawer, Empty, Field, Icon, Input, NumberInput, Seg, Select, Setting, StatusBadge, Switch, TagsInput, TextArea, Tabs, useLoad } from '../../../shared/ui.jsx';
import { api as rootApi, useMetadataFields } from '../../context.jsx';
import { MetadataForm } from '../../../shared/metadata.jsx';
import { AuthorizationServer, SharedResourcePicker, TrustedCAs } from './PlanAuth.jsx';
import { THREAT_DEFAULTS, ThreatProtection } from './PlanThreats.jsx';
import { tr, Tr } from '../../../shared/i18n.jsx';

// the kinds whose extractor can pass on a call with a selection: the others are told apart by the key
const SELECTABLE = ['keyless', 'jwt', 'mtls', 'oauth2-remote'];

const rid = () => `plan_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

const AUTH_DEFAULTS = {
  apikey: { readOnly: false, rotation: { enabled: false, everyHours: 744, graceHours: 168 }, validityDays: null },
  jwt: { verifier: '', clientIdPath: 'client_id' },
  mtls: { regexSubjectDNs: [], regexIssuerDNs: [], clientIdField: 'CN', trustedCAs: [] },
  'oauth2-local': { defaultKeyPair: 'otoroshi-jwt-signing', expiration: 3600 },
  'oauth2-remote': {
    verifier: '',
    clientIdPath: 'client_id',
    fetchUser: false,
    issuer: '',
    audiences: [],
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
    selection: [],
    unit: 'calls',
    rateLimit: { enabled: true, calls: 10, windowMs: 1000 },
    quota: { daily: null, monthly: null },
    counterFailure: 'allow',
    circuitBreaker: 'api',
    resourceFilter: { mode: 'all', resources: [] },
    flowRef: null,
    threatProtection: { ...THREAT_DEFAULTS },
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
        {p.selection?.length ? tr(' · with a selection') : ''}
      </div>
      <div>
        <Icon name="chart" size={13} /> {p.rateLimit.enabled ? tr('{0} calls / {1}', [fmtNumber(p.rateLimit.calls), fmtWindow(p.rateLimit.windowMs)]) : tr('no rate limit')}
        {p.quota.daily ? tr(' · {0} / day', [fmtNumber(p.quota.daily)]) : ''}
        {p.quota.monthly ? tr(' · {0} / month', [fmtNumber(p.quota.monthly)]) : ''}
      </div>
      <div>
        <Icon name="api" size={13} /> {p.resourceFilter.mode === 'all' ? tr('all resources') : tr('{0} of {1} resources', [p.resourceFilter.resources.length, draft.resources.length])}
        {p.flowRef ? tr(' · + flow {0}', [draft.flows.find((f) => f.id === p.flowRef)?.name || p.flowRef]) : ''}
        {p.threatProtection?.enabled ? tr(' · threat protection') : ''}
      </div>
      <div>
        <Icon name="eye" size={13} /> {tr(p.visibility)} · {p.subscribable ? tr('{0} approval', [tr(p.validation)]) : tr('not subscribable')}
        {p.pricing.kind === 'paid' ? ` · ${p.pricing.amount} ${p.pricing.currency}/${tr(p.pricing.interval)}${p.pricing.usage?.enabled ? tr(' + usage') : ''}` : tr(' · free')}
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
            {tr('Without a published plan, the gateway refuses every call to this api: publish a keyless plan for an open api.')}
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

const USAGE_DEFAULTS = { enabled: false, priceRef: '', meterEventName: '', counts: 'success', unitAmount: 0 };

// the usage part of a paid plan: its calls counted by the product, billed by a metered price at Stripe
function UsagePricing({ usage, currency, onChange }) {
  const u = { ...USAGE_DEFAULTS, ...(usage || {}) };
  return (
    <>
      <Setting
        label={tr('Usage price')}
        help={tr('the calls of each subscription counted from the computed path and pushed in batches to a meter of Stripe, whose metered price bills them; with a price of 0 above, the plan is billed by its usage only')}
      >
        <Switch checked={u.enabled} onChange={(v) => onChange({ enabled: v })} label={tr('Bill the usage')} />
      </Setting>
      {u.enabled && (
        <>
          <Setting label={tr('Metered price')} help={tr('the price at Stripe that bills the usage (price_…), metered by the meter below')}>
            <Input value={u.priceRef} onChange={(v) => onChange({ priceRef: v })} mono placeholder={tr('price_…')} />
          </Setting>
          <Setting label={tr('Meter event name')} help={tr('the event name of the meter at Stripe the usage is pushed to')}>
            <Input value={u.meterEventName} onChange={(v) => onChange({ meterEventName: v })} mono placeholder="api_calls" />
          </Setting>
          <Setting label={tr('Counted calls')} help={tr('success: the calls answered below 400 · served: every call the gateway served, below 500, a 429 of the quotas aside')}>
            <Seg
              value={u.counts}
              onChange={(v) => onChange({ counts: v })}
              options={[
                { value: 'success', label: tr('success') },
                { value: 'served', label: tr('served') },
              ]}
            />
          </Setting>
          <Setting label={tr('Price of a call, shown')} help={tr('what the portal shows; the price billed is the one of the metered price at Stripe — keep them equal')}>
            <div className="row">
              <NumberInput value={u.unitAmount} onChange={(v) => onChange({ unitAmount: v })} />
              <span className="muted">{tr('{0} per call', [currency])}</span>
            </div>
          </Setting>
        </>
      )}
    </>
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
  // an apikey or oauth2-local plan is told apart by its key: it takes no selection
  const kindChange = (kind) => setP((x) => ({ ...x, auth: { kind, config: AUTH_DEFAULTS[kind] }, selection: SELECTABLE.includes(kind) ? x.selection || [] : [] }));
  const sameKind = draft.plans.filter((x) => x.id !== p.id && ['published', 'deprecated'].includes(x.status) && x.auth.kind === p.auth.kind);
  const setSelection = (i, patch) => set({ selection: p.selection.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
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
          { id: 'security', label: tr('Threat protection') },
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
          <Setting label={tr('Status')} help={tr('staging: not enforced, not subscribable · published · deprecated: closed to new subscriptions, its consumers keep calling · closed: Otoroshi deletes the keys of its subscriptions')}>
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
      {section === 'security' && <ThreatProtection value={p.threatProtection} onChange={(v) => set({ threatProtection: v })} />}
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
              <Setting label={tr('Key validity (days)')} help={tr('each key expires that many days after it is first enabled: the subscription, or its acceptance. Empty: no expiry')}>
                <NumberInput value={p.auth.config.validityDays} onChange={(v) => setAuthConfig({ validityDays: v })} placeholder={tr('no expiry')} />
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
          {['jwt', 'oauth2-remote'].includes(p.auth.kind) && <SharedResourcePicker config={p.auth.config} setAuthConfig={setAuthConfig} />}
          {p.auth.kind === 'jwt' && p.auth.config.sharedResource?.id && (
            <>
              <Setting label={tr('Expected audience')} help={tr('the aud a token must carry: the audience of this api at the authorization server')}>
                <Input value={p.auth.config.derive?.audience || ''} onChange={(v) => setAuthConfig({ derive: { ...(p.auth.config.derive || {}), audience: v } })} mono />
              </Setting>
              <Setting label={tr('Client id claim')} help={tr("where the consumer's client_id is read in the token")}>
                <Input value={p.auth.config.clientIdPath} onChange={(v) => setAuthConfig({ clientIdPath: v })} mono />
              </Setting>
            </>
          )}
          {p.auth.kind === 'jwt' && !p.auth.config.sharedResource?.id && (
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
          {p.auth.kind === 'oauth2-remote' && <AuthorizationServer config={p.auth.config} setAuthConfig={setAuthConfig} authModules={refs.data?.authModules} shared={!!p.auth.config.sharedResource?.id} />}
          {p.auth.kind === 'jwt' && !p.auth.config.derive?.enabled && !p.auth.config.sharedResource?.id && (
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
              <TrustedCAs value={p.auth.config.trustedCAs || []} onChange={(v) => setAuthConfig({ trustedCAs: v })} />
              {!(p.auth.config.trustedCAs || []).length && (
                <Callout kind="warning">{tr('Without a trusted CA, the plan accepts a client certificate from any authority the gateway trusts, JDK CAs included.')}</Callout>
              )}
              <Setting label={tr('Allowed issuer DNs')} help={tr("Java regexes on the issuer DN in Otoroshi's form (OU=…, O=…, CN=…, C=…). Both lists, when given, must match")}>
                <TagsInput value={p.auth.config.regexIssuerDNs} onChange={(v) => setAuthConfig({ regexIssuerDNs: v })} />
              </Setting>
              <Setting label={tr('Allowed subject DNs')} help={tr('Java regexes on the subject DN. Both lists, when given, must match')}>
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
          {SELECTABLE.includes(p.auth.kind) && (
            <Setting
              label={tr('Selection')}
              help={tr('the calls this plan applies to, when another {0} plan of the api can identify the same callers: conditions on the request, the claims of the token, the client certificate or the client id ($.request.headers.x-tier, $.token.tier, $.certificate.subject_dn, $.client_id), all of which must hold. A value can be Regex(…), Contains(…), Not(…).{1}', [p.auth.kind, sameKind.length ? tr(' {0} other {1} plan(s) are served on this api: the first plan in the order of the plans that identifies a caller wins.', [sameKind.length, p.auth.kind]) : ''])}
            >
              {p.selection.map((c, i) => (
                <div key={i} className="row">
                  <Input value={c.path} onChange={(v) => setSelection(i, { path: v })} mono placeholder={tr('$.token.tier')} aria-label={tr('path')} />
                  <Input value={c.value} onChange={(v) => setSelection(i, { value: v })} mono placeholder={tr('gold')} aria-label={tr('value')} />
                  <button className="btn sm ghost icon" aria-label={tr('remove the condition')} onClick={() => set({ selection: p.selection.filter((_, j) => j !== i) })}>
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
              <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ selection: [...p.selection, { path: '', value: '' }] })}>
                <Icon name="plus" /> {tr('Add a condition')}
              </button>
            </Setting>
          )}
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
          <Setting label={tr('Resource filtering')} help={tr('the resources this plan gives access to, projected as the restrictions of its consumers')}>
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
                {p.auth.kind === 'oauth2-local' && <Callout kind="warning">{tr('The gateway gives the keys of an oauth2-local plan no restrictions: on this plan the filter is not enforced.')}</Callout>}
              </div>
            )}
          </Setting>
          <Setting label={tr('Counter failure strategy')} help={tr('when the distributed quota counter is unreachable: availability or protection? Not the same answer for an open free tier and a contractual one.')}>
            <Select value={p.counterFailure} onChange={(v) => set({ counterFailure: v })} options={[{ value: 'allow', label: tr('Let the call pass') }, { value: 'deny', label: tr('Refuse the call') }]} />
          </Setting>
          <Setting label={tr('Circuit breaker granularity')} help={tr('per subscription: each consumer gets its own circuit breaker, so that one consumer making the backend fail does not open it for everyone')}>
            <Select value={p.circuitBreaker} onChange={(v) => set({ circuitBreaker: v })} options={[{ value: 'api', label: tr('Per API') }, { value: 'subscription', label: tr('Per subscription') }]} />
          </Setting>
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
              <UsagePricing usage={p.pricing.usage} currency={p.pricing.currency} onChange={(patch) => setIn('pricing', { usage: { ...USAGE_DEFAULTS, ...(p.pricing.usage || {}), ...patch } })} />
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
