import React, { useState } from 'react';
import { AUTH_LABELS, fmtNumber, fmtWindow } from '../../../shared/lib.js';
import { Badge, Callout, Drawer, Empty, Field, Icon, Input, NumberInput, Select, Setting, StatusBadge, Switch, TagsInput, TextArea, Tabs, useLoad } from '../../../shared/ui.jsx';
import { api as rootApi } from '../../context.jsx';

const rid = () => `plan_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

const AUTH_DEFAULTS = {
  apikey: { readOnly: false, validityDays: null, rotation: { enabled: false, everyHours: 744, graceHours: 168 } },
  jwt: { verifier: '', clientIdPath: 'client_id' },
  mtls: { regexSubjectDNs: [], regexIssuerDNs: [], clientIdField: '' },
  'oauth2-local': { defaultKeyPair: 'otoroshi-jwt-signing', expiration: 3600 },
  'oauth2-remote': { verifier: '', clientIdPath: 'client_id', fetchUser: false },
  keyless: { expr: '${req.ip}' },
};

const AUTH_HELP = {
  apikey: 'The subscription mints an Otoroshi apikey (client id / secret). Throttling, quotas and path restrictions are enforced on the key.',
  'oauth2-local': 'The gateway is the token endpoint (client_credentials). The subscription mints the client id / secret used to get tokens.',
  jwt: 'The consumer calls with a JWT validated by an Otoroshi JWT verifier; the consumer is identified by a claim, matched to the client_id declared on the application.',
  mtls: 'The consumer is identified by its client certificate (subject / issuer DN).',
  'oauth2-remote': 'Tokens issued by a remote IdP, validated through an Otoroshi auth module.',
  keyless: 'No credential: an identity is still derived (e.g. from the IP) so the quotas of the plan apply per caller.',
};

export function newPlan(kind = 'apikey') {
  return {
    id: rid(),
    name: 'New plan',
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
    usageStatement: { enabled: false, required: false, prompt: 'What do you plan to build with this API?' },
    pricing: { kind: 'free', amount: 0, currency: 'EUR', interval: 'month', provider: 'stripe', priceRef: '', graceDays: 7 },
    metadata: {},
  };
}

function PlanSummary({ p, draft }) {
  return (
    <div className="col gap-6 small muted">
      <div>
        <Icon name="shield" size={13} /> {AUTH_LABELS[p.auth.kind]}
        {p.selectionRule ? ' · with a selection rule' : ''}
      </div>
      <div>
        <Icon name="chart" size={13} /> {p.rateLimit.enabled ? `${fmtNumber(p.rateLimit.calls)} calls / ${fmtWindow(p.rateLimit.windowMs)}` : 'no rate limit'}
        {p.quota.daily ? ` · ${fmtNumber(p.quota.daily)} / day` : ''}
        {p.quota.monthly ? ` · ${fmtNumber(p.quota.monthly)} / month` : ''}
      </div>
      <div>
        <Icon name="api" size={13} /> {p.resourceFilter.mode === 'all' ? 'all resources' : `${p.resourceFilter.resources.length} of ${draft.resources.length} resources`}
        {p.flowRef ? ` · + flow ${draft.flows.find((f) => f.id === p.flowRef)?.name || p.flowRef}` : ''}
      </div>
      <div>
        <Icon name="eye" size={13} /> {p.visibility} · {p.subscribable ? `${p.validation} approval` : 'not subscribable'}
        {p.pricing.kind === 'paid' ? ` · ${p.pricing.amount} ${p.pricing.currency}/${p.pricing.interval}` : ' · free'}
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
          The policy lives in the plan (D-5): adding a tier is a catalogue operation, never an infrastructure one. One API, N plans, N auth mechanisms, on a single set of routes.
        </p>
        {!readOnly && (
          <button className="btn primary" onClick={() => setEditing(newPlan())}>
            <Icon name="plus" /> Add plan
          </button>
        )}
      </div>
      {draft.plans.length === 0 ? (
        <div className="card">
          <Empty title="No plan" icon="layers" action={!readOnly && <button className="btn primary" onClick={() => setEditing(newPlan())}>Add a plan</button>}>
            On Otoroshi 18 an API without a published plan has open routes.
          </Empty>
        </div>
      ) : (
        <div className="grid-3">
          {draft.plans.map((p) => (
            <div key={p.id} className="card plan-card">
              <div className="row">
                <span className="plan-kind">{AUTH_LABELS[p.auth.kind]}</span>
                <span className="spacer" />
                <StatusBadge status={p.status} />
              </div>
              <h3>{p.name}</h3>
              {p.description && <p className="small muted">{p.description}</p>}
              <PlanSummary p={p} draft={draft} />
              {!readOnly && (
                <div className="row mt-8">
                  <button className="btn sm" onClick={() => setEditing(p)}>
                    <Icon name="edit" /> Edit
                  </button>
                  <button className="btn sm ghost" onClick={() => duplicate(p)}>
                    <Icon name="copy" /> Duplicate
                  </button>
                  <span className="spacer" />
                  <button className="btn sm ghost icon" aria-label="delete plan" onClick={() => setDraft((d) => ({ ...d, plans: d.plans.filter((x) => x.id !== p.id) }))}>
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
  const set = (patch) => setP((x) => ({ ...x, ...patch }));
  const setIn = (key, patch) => setP((x) => ({ ...x, [key]: { ...x[key], ...patch } }));
  const setAuthConfig = (patch) => setP((x) => ({ ...x, auth: { ...x.auth, config: { ...x.auth.config, ...patch } } }));
  const kindChange = (kind) => setP((x) => ({ ...x, auth: { kind, config: AUTH_DEFAULTS[kind] } }));
  const sameKind = draft.plans.filter((x) => x.id !== p.id && x.status === 'published' && x.auth.kind === p.auth.kind);
  const windows = [
    { value: 1000, label: 'second' },
    { value: 60000, label: 'minute' },
    { value: 3600000, label: 'hour' },
    { value: 86400000, label: 'day' },
  ];
  return (
    <Drawer
      title={value.name}
      subtitle={`plan ${value.id}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(p)}>
            Apply to the draft
          </button>
        </>
      }
    >
      <Tabs
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'general', label: 'General' },
          { id: 'access', label: 'Access' },
          { id: 'limits', label: 'Limits' },
          { id: 'catalogue', label: 'Catalogue & approval' },
          { id: 'pricing', label: 'Pricing' },
        ]}
      />
      {section === 'general' && (
        <div>
          <Setting label="Name">
            <Input value={p.name} onChange={(v) => set({ name: v })} />
          </Setting>
          <Setting label="Description" help="shown to consumers on the portal">
            <TextArea value={p.description} onChange={(v) => set({ description: v })} rows={3} />
          </Setting>
          <Setting label="Status" help="staging: not enforced, not subscribable · published · deprecated: enforced, closed to new subscriptions · closed: Otoroshi deletes the keys of its subscriptions">
            <Select value={p.status} onChange={(v) => set({ status: v })} options={['staging', 'published', 'deprecated', 'closed']} />
          </Setting>
          <Setting label="Plan plugins" help="a flow of this api added on top of the route's flow for the consumers of this plan (ApiPlanPlugins.flow_ref)">
            <Select value={p.flowRef || ''} onChange={(v) => set({ flowRef: v || null })} options={[{ value: '', label: 'none' }, ...draft.flows.map((f) => ({ value: f.id, label: f.name }))]} />
          </Setting>
        </div>
      )}
      {section === 'access' && (
        <div>
          <Setting label="Auth mechanism" help={AUTH_HELP[p.auth.kind]}>
            <Select value={p.auth.kind} onChange={kindChange} options={Object.entries(AUTH_LABELS).map(([value, label]) => ({ value, label }))} />
          </Setting>
          {p.auth.kind === 'apikey' && (
            <>
              <Setting label="Read only" help="the key only allows GET, HEAD and OPTIONS">
                <Switch checked={p.auth.config.readOnly} onChange={(v) => setAuthConfig({ readOnly: v })} />
              </Setting>
              <Setting label="Secret rotation" help="Otoroshi rotates the secret itself, with a grace period where both work">
                <Switch checked={p.auth.config.rotation?.enabled} onChange={(v) => setAuthConfig({ rotation: { ...p.auth.config.rotation, enabled: v } })} label="Rotate automatically" />
                {p.auth.config.rotation?.enabled && (
                  <div className="row">
                    <Field label="every (hours)">
                      <NumberInput value={p.auth.config.rotation.everyHours} onChange={(v) => setAuthConfig({ rotation: { ...p.auth.config.rotation, everyHours: v } })} />
                    </Field>
                    <Field label="grace (hours)">
                      <NumberInput value={p.auth.config.rotation.graceHours} onChange={(v) => setAuthConfig({ rotation: { ...p.auth.config.rotation, graceHours: v } })} />
                    </Field>
                  </div>
                )}
              </Setting>
            </>
          )}
          {(p.auth.kind === 'jwt' || p.auth.kind === 'oauth2-remote') && (
            <>
              <Setting label={p.auth.kind === 'jwt' ? 'JWT verifier' : 'Auth module'} help="infrastructure of the gateway the plan references (D-15)">
                <Select
                  value={p.auth.config.verifier}
                  onChange={(v) => setAuthConfig({ verifier: v })}
                  options={[
                    { value: '', label: 'choose…' },
                    ...((p.auth.kind === 'jwt' ? refs.data?.jwtVerifiers : refs.data?.authModules) || []).map((v) => ({ value: v.id, label: v.name })),
                  ]}
                />
                <Input value={p.auth.config.verifier} onChange={(v) => setAuthConfig({ verifier: v })} placeholder="or an id" mono />
              </Setting>
              <Setting label="Client id claim" help="where the consumer's client_id is read in the token">
                <Input value={p.auth.config.clientIdPath} onChange={(v) => setAuthConfig({ clientIdPath: v })} mono />
              </Setting>
            </>
          )}
          {p.auth.kind === 'mtls' && (
            <>
              <Setting label="Allowed subject DNs" help="regexes">
                <TagsInput value={p.auth.config.regexSubjectDNs} onChange={(v) => setAuthConfig({ regexSubjectDNs: v })} />
              </Setting>
              <Setting label="Allowed issuer DNs" help="regexes">
                <TagsInput value={p.auth.config.regexIssuerDNs} onChange={(v) => setAuthConfig({ regexIssuerDNs: v })} />
              </Setting>
              <Setting label="Client id field" help="the certificate field used as client id">
                <Input value={p.auth.config.clientIdField} onChange={(v) => setAuthConfig({ clientIdField: v })} mono placeholder="CN" />
              </Setting>
            </>
          )}
          {p.auth.kind === 'oauth2-local' && (
            <>
              <Setting label="Signing key pair">
                <Select value={p.auth.config.defaultKeyPair} onChange={(v) => setAuthConfig({ defaultKeyPair: v })} options={[{ value: 'otoroshi-jwt-signing', label: 'otoroshi-jwt-signing' }, ...(refs.data?.keyPairs || []).filter((k) => k.id !== 'otoroshi-jwt-signing').map((k) => ({ value: k.id, label: k.name }))]} />
              </Setting>
              <Setting label="Token lifetime (s)">
                <NumberInput value={p.auth.config.expiration} onChange={(v) => setAuthConfig({ expiration: v })} />
              </Setting>
            </>
          )}
          {p.auth.kind === 'keyless' && (
            <Setting label="Caller identity" help="an expression language value the quotas are counted against">
              <Input value={p.auth.config.expr} onChange={(v) => setAuthConfig({ expr: v })} mono />
            </Setting>
          )}
          <Setting
            label="Selection rule"
            help={`an expression that disambiguates two plans of the same kind whose extractors can both succeed on a request.${sameKind.length ? ` ${sameKind.length} other published ${p.auth.kind} plan(s) exist on this api.` : ''}`}
          >
            <Input value={p.selectionRule} onChange={(v) => set({ selectionRule: v })} mono placeholder="${token.aud} == 'partner'" />
            {p.selectionRule && <Callout kind="warning">Recorded and projected as plan metadata, not yet enforced by Otoroshi 18 (upstream work).</Callout>}
          </Setting>
          {['jwt', 'mtls', 'oauth2-remote', 'keyless'].includes(p.auth.kind) && (
            <Callout kind="warning">On Otoroshi 18 the gateway mints the consumer itself on the first call: any valid {p.auth.kind === 'keyless' ? 'caller' : 'token or certificate'} passes, subscribed or not (D-6, upstream gap).</Callout>
          )}
        </div>
      )}
      {section === 'limits' && (
        <div>
          <Setting label="Unit of measure" help="calls, tokens or an AI budget (D-41). Tokens and budget need an LLM backend, out of this version.">
            <Select value={p.unit} onChange={(v) => set({ unit: v })} options={[{ value: 'calls', label: 'Calls' }, { value: 'tokens', label: 'Tokens (LLM)' }, { value: 'budget', label: 'Budget (LLM)' }]} />
          </Setting>
          <Setting label="Rate limit" help="per credential — a credential has its own quotas, nothing is pooled (D-31)">
            <Switch checked={p.rateLimit.enabled} onChange={(v) => setIn('rateLimit', { enabled: v })} label="Limit the rate" />
            {p.rateLimit.enabled && (
              <div className="row">
                <NumberInput value={p.rateLimit.calls} onChange={(v) => setIn('rateLimit', { calls: v })} style={{ width: 140 }} />
                <span className="muted">calls per</span>
                <Select value={p.rateLimit.windowMs} onChange={(v) => setIn('rateLimit', { windowMs: Number(v) })} options={windows} style={{ width: 140 }} />
              </div>
            )}
          </Setting>
          <Setting label="Quotas" help="empty = unlimited. On a leader/worker cluster the quota is global, within a few seconds of synchronisation.">
            <div className="row">
              <Field label="Daily">
                <NumberInput value={p.quota.daily} onChange={(v) => setIn('quota', { daily: v })} placeholder="unlimited" />
              </Field>
              <Field label="Monthly">
                <NumberInput value={p.quota.monthly} onChange={(v) => setIn('quota', { monthly: v })} placeholder="unlimited" />
              </Field>
            </div>
          </Setting>
          <Setting label="Resource filtering" help="the resources this plan gives access to. Projected as apikey restrictions — enforced on apikey plans.">
            <Select value={p.resourceFilter.mode} onChange={(v) => setIn('resourceFilter', { mode: v })} options={[{ value: 'all', label: 'All resources' }, { value: 'only', label: 'Only some resources' }]} />
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
                {p.auth.kind !== 'apikey' && <Callout kind="warning">Only apikey plans carry restrictions on Otoroshi 18: on a {p.auth.kind} plan this filter is not enforced.</Callout>}
              </div>
            )}
          </Setting>
          <Setting label="Counter failure strategy" help="when the distributed quota counter is unreachable: availability or protection? Not the same answer for an open free tier and a contractual one.">
            <Select value={p.counterFailure} onChange={(v) => set({ counterFailure: v })} options={[{ value: 'allow', label: 'Let the call pass' }, { value: 'deny', label: 'Refuse the call' }]} />
          </Setting>
          <Setting label="Circuit breaker granularity" help="per subscription keeps one abusive consumer from opening the circuit for everyone">
            <Select value={p.circuitBreaker} onChange={(v) => set({ circuitBreaker: v })} options={[{ value: 'api', label: 'Per API' }, { value: 'subscription', label: 'Per subscription' }]} />
          </Setting>
          {(p.counterFailure !== 'allow' || p.circuitBreaker !== 'api') && <Callout kind="warning">Recorded and projected as plan metadata, not yet enforced by Otoroshi 18 (upstream work).</Callout>}
        </div>
      )}
      {section === 'catalogue' && (
        <div>
          <Callout kind="info">Nothing in this section is projected on the gateway (D-2): it belongs to the portal.</Callout>
          <Setting label="Visibility" help="who sees this plan on the portal">
            <Select value={p.visibility} onChange={(v) => set({ visibility: v })} options={[{ value: 'public', label: 'Public' }, { value: 'authenticated', label: 'Authenticated' }, { value: 'restricted', label: 'Restricted (ACL tags)' }]} />
            {p.visibility === 'restricted' && <TagsInput value={p.acl} onChange={(v) => set({ acl: v })} placeholder="user:…, team:…, role:…" />}
          </Setting>
          <Setting label="Subscribable" help="an internal tier can be visible but not subscribable">
            <Switch checked={p.subscribable} onChange={(v) => set({ subscribable: v })} />
          </Setting>
          <Setting label="Approval" help="automatic: the key is issued at once · manual: a producer reviews the request">
            <Select value={p.validation} onChange={(v) => set({ validation: v })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual review' }]} />
          </Setting>
          <Setting label="Terms of use" help="the subscriber must accept them">
            <Switch checked={p.terms.enabled} onChange={(v) => setIn('terms', { enabled: v })} label="Require terms acceptance" />
            {p.terms.enabled && <Input value={p.terms.url} onChange={(v) => setIn('terms', { url: v })} placeholder="https://… or a documentation page slug" />}
          </Setting>
          <Setting label="Usage statement" help="ask the subscriber what they plan to do with the api">
            <Switch checked={p.usageStatement.enabled} onChange={(v) => setIn('usageStatement', { enabled: v })} label="Ask for a usage statement" />
            {p.usageStatement.enabled && (
              <>
                <Input value={p.usageStatement.prompt} onChange={(v) => setIn('usageStatement', { prompt: v })} />
                <Switch checked={p.usageStatement.required} onChange={(v) => setIn('usageStatement', { required: v })} label="Required" />
              </>
            )}
          </Setting>
        </div>
      )}
      {section === 'pricing' && (
        <div>
          <Callout kind="info">
            The product decides access; a payment provider decides the money (D-36). A paid subscription waits for the payment before its key is projected. Frozen in the snapshot: changing a price is a publication.
          </Callout>
          <Setting label="Pricing">
            <Select value={p.pricing.kind} onChange={(v) => setIn('pricing', { kind: v })} options={[{ value: 'free', label: 'Free' }, { value: 'paid', label: 'Paid' }]} />
          </Setting>
          {p.pricing.kind === 'paid' && (
            <>
              <Setting label="Price">
                <div className="row">
                  <NumberInput value={p.pricing.amount} onChange={(v) => setIn('pricing', { amount: v })} />
                  <Select value={p.pricing.currency} onChange={(v) => setIn('pricing', { currency: v })} options={['EUR', 'USD', 'GBP', 'CHF']} style={{ width: 100 }} />
                  <span className="muted">per</span>
                  <Select value={p.pricing.interval} onChange={(v) => setIn('pricing', { interval: v })} options={['month', 'year']} style={{ width: 110 }} />
                </div>
              </Setting>
              <Setting label="Provider price reference" help="e.g. a Stripe price id. The connector is a narrow interface; Stripe Checkout comes first.">
                <Input value={p.pricing.priceRef} onChange={(v) => setIn('pricing', { priceRef: v })} mono placeholder="price_…" />
              </Setting>
              <Setting label="Grace period (days)" help="after a failed payment, before the key is disabled">
                <NumberInput value={p.pricing.graceDays} onChange={(v) => setIn('pricing', { graceDays: v })} />
              </Setting>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
