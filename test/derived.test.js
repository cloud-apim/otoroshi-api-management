// Derived objects: what follows from a plan's description is derived as an Otoroshi entity of the
// product — trusted CAs of mtls plans (certificates), authorization servers of oauth2-remote plans
// (auth modules) — and the plan references it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalizeDraft, validateDraft, defaultPlan } from '../server/domain/model.js';
import { otoroshiDn, issuerPatterns, readCertificate } from '../server/domain/pki.js';
import { buildOtoroshiApi, comparableDerived, derivedAuthModuleId, derivedCaId, derivedEntities } from '../server/otoroshi/projection.js';
import { diff } from '../server/domain/diff.js';

const CA = readFileSync(new URL('./fixtures/atlas-partner-ca.pem', import.meta.url), 'utf8');
const ODD_CA = readFileSync(new URL('./fixtures/odd-dn-ca.pem', import.meta.url), 'utf8');

function snapshot(plans) {
  const draft = normalizeDraft({
    entrypoint: { domain: 'atlas.oto.tools', contextPath: '/v1' },
    backends: [{ id: 'b1', name: 'echo', targets: [{ hostname: 'echo', port: 8080 }] }],
    flows: [{ id: 'f1', name: 'flow', plugins: [] }],
    resources: [{ id: 'r1', name: 'Docs', path: '/documents', methods: ['GET'], backendId: 'b1', flowId: 'f1' }],
    plans,
  });
  return { api: { id: 'api_atlas', name: 'Atlas', version: '1.0.0', slug: 'atlas' }, draft, docs: {} };
}

const mtlsPlan = (config) => defaultPlan({ id: 'plan_bulk', name: 'Bulk', status: 'published', auth: { kind: 'mtls', config } });
const remotePlan = (config) => defaultPlan({ id: 'plan_sso', name: 'SSO', status: 'published', auth: { kind: 'oauth2-remote', config } });

describe('certificates', () => {
  test('a CA reads as a CA, its subject in the form Otoroshi compares', () => {
    const c = readCertificate(CA);
    expect(c.ca).toBe(true);
    // attributes in upper case, sorted by name, descending, joined with ", " (DN.stringify)
    expect(c.dn).toBe('OU=Platform, O=Atlas Data, CN=Atlas Partner CA, C=FR');
    expect(issuerPatterns([CA])).toEqual(['\\QOU=Platform, O=Atlas Data, CN=Atlas Partner CA, C=FR\\E']);
  });

  test('a DN that cannot be predicted is not guessed', () => {
    expect(readCertificate(ODD_CA).dn).toBeNull();
    expect(issuerPatterns([CA, ODD_CA])).toBeNull();
    expect(otoroshiDn('CN=a, with a comma')).toBeNull();
    expect(otoroshiDn('CN=Plain\nO=Org')).toBe('O=Org, CN=Plain');
  });
});

describe('mtls plans', () => {
  test('trusted CAs are derived as certificates of the gateway, marked as the product’s', () => {
    const snap = snapshot([mtlsPlan({ clientIdField: 'CN', trustedCAs: [CA] })]);
    const [cert] = derivedEntities(snap);
    expect(cert.kind).toBe('Certificate');
    expect(cert.path).toBe('/apis/pki.otoroshi.io/v1/certificates');
    expect(cert.id).toBe(derivedCaId('api_atlas', 'plan_bulk', CA));
    expect(cert.entity.ca).toBe(true);
    expect(cert.entity.privateKey).toBe('');
    expect(cert.entity.chain).toBe(CA.trim());
    expect(cert.entity.metadata).toMatchObject({ apim_api_id: 'api_atlas', apim_plan_id: 'plan_bulk', apim_derived: 'true' });
    // the id follows the certificate, not its position: reordering the CAs changes nothing
    expect(derivedCaId('api_atlas', 'plan_bulk', `\n${CA}\n`)).toBe(cert.id);
  });

  test('without issuer patterns, the plan accepts what its CAs signed and nothing else', () => {
    const plan = (cfg) => buildOtoroshiApi(snapshot([mtlsPlan(cfg)])).plans[0].access_mode_configuration;
    expect(plan({ trustedCAs: [CA] }).regex_issuer_dns).toEqual(['\\QOU=Platform, O=Atlas Data, CN=Atlas Partner CA, C=FR\\E']);
    // explicit patterns win
    expect(plan({ trustedCAs: [CA], regexIssuerDNs: ['.*Atlas.*'] }).regex_issuer_dns).toEqual(['.*Atlas.*']);
    expect(plan({}).regex_issuer_dns).toEqual([]);
  });

  test('validation: unreadable certificates block, unpredictable or missing issuers warn', () => {
    const codes = (cfg) => validateDraft(snapshot([mtlsPlan(cfg)]).draft);
    expect(codes({ trustedCAs: ['not a certificate'] }).ok).toBe(false);
    expect(codes({ trustedCAs: [ODD_CA] }).warnings.map((w) => w.code)).toContain('issuer_not_derived');
    expect(codes({ trustedCAs: [ODD_CA], regexIssuerDNs: ['.*Odd.*'] }).warnings.map((w) => w.code)).not.toContain('issuer_not_derived');
    expect(codes({ regexSubjectDNs: ['CN=.*'] }).warnings.map((w) => w.code)).toContain('subject_without_issuer');
    expect(codes({ regexSubjectDNs: ['CN=.*'], trustedCAs: [CA] }).warnings.map((w) => w.code)).not.toContain('subject_without_issuer');
  });

  test('the gateway’s own fields on a certificate are not drift', () => {
    const [cert] = derivedEntities(snapshot([mtlsPlan({ trustedCAs: [CA] })]));
    const onGateway = { ...cert.entity, chain: cert.entity.chain.replace(/\n/g, '\r\n'), subject: 'CN=Atlas Partner CA', from: 1, to: 2, sans: ['x'] };
    expect(diff(comparableDerived(cert.entity), comparableDerived(onGateway))).toEqual([]);
    expect(diff(comparableDerived(cert.entity), comparableDerived({ ...onGateway, revoked: true })).length).toBe(1);
  });
});

describe('oauth2-remote plans', () => {
  const described = { derive: { enabled: true, discoveryUrl: 'https://idp/.well-known/openid-configuration', jwksUrl: 'https://idp/jwks', userInfoUrl: 'https://idp/userinfo', clientId: 'gw', clientSecret: 's', scope: 'openid' } };

  test('the authorization server is derived as an auth module the plan references', () => {
    const snap = snapshot([remotePlan(described)]);
    const [mod] = derivedEntities(snap);
    expect(mod.kind).toBe('AuthModule');
    expect(mod.path).toBe('/apis/security.otoroshi.io/v1/auth-modules');
    expect(mod.entity.type).toBe('oauth2');
    expect(mod.entity.jwtVerifier).toMatchObject({ type: 'JWKSAlgoSettings', url: 'https://idp/jwks' });
    expect(mod.entity.userInfoUrl).toBe('https://idp/userinfo');
    expect(mod.entity.metadata).toMatchObject({ apim_api_id: 'api_atlas', apim_derived: 'true' });
    // Otoroshi names the field verifier, it holds an auth module id
    const plan = buildOtoroshiApi(snap).plans[0];
    expect(plan.access_mode_configuration.verifier).toBe(derivedAuthModuleId('api_atlas', 'plan_sso'));
  });

  test('a referenced module is not derived', () => {
    const snap = snapshot([remotePlan({ verifier: 'existing_module' })]);
    expect(derivedEntities(snap)).toEqual([]);
    expect(buildOtoroshiApi(snap).plans[0].access_mode_configuration.verifier).toBe('existing_module');
  });

  test('validation: a described server needs its JWKS, a fetched profile its userinfo; claims are not checked', () => {
    const check = (cfg) => validateDraft(snapshot([remotePlan(cfg)]).draft);
    expect(check({ derive: { enabled: true, jwksUrl: '' } }).ok).toBe(false);
    expect(check({ fetchUser: true, derive: { enabled: true, jwksUrl: 'https://idp/jwks' } }).ok).toBe(false);
    expect(check({ verifier: '' }).ok).toBe(false);
    const ok = check(described);
    expect(ok.ok).toBe(true);
    expect(ok.warnings.map((w) => w.code)).toContain('token_claims_not_checked');
  });

  test('the module secret is not compared: the gateway may not give it back', () => {
    const [mod] = derivedEntities(snapshot([remotePlan(described)]));
    expect(diff(comparableDerived(mod.entity), comparableDerived({ ...mod.entity, clientSecret: '********' }))).toEqual([]);
    expect(diff(comparableDerived(mod.entity), comparableDerived({ ...mod.entity, jwtVerifier: { type: 'JWKSAlgoSettings', url: 'https://other/jwks' } })).length).toBe(1);
  });
});

describe('client certificates of applications', () => {
  test('only readable certificates, never a private key, each once', async () => {
    const { normalizeCertificates } = await import('../server/domain/applications.js');
    expect(normalizeCertificates([CA, ` ${CA} `, ''])).toEqual([CA.trim()]);
    expect(() => normalizeCertificates(['-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'])).toThrow(/private key/);
    expect(() => normalizeCertificates(['not a certificate'])).toThrow(/PEM/);
  });

  test('derived as certificates of the gateway, marked with their application', async () => {
    const { applicationCertificates, derivedApplicationCertId } = await import('../server/otoroshi/projection.js');
    const [cert] = applicationCertificates({ id: 'app_1', name: 'Partner app', workspace_id: 'ws_1', certificates: [CA] });
    expect(cert.id).toBe(derivedApplicationCertId('app_1', CA));
    expect(cert.entity.privateKey).toBe('');
    expect(cert.entity.selfSigned).toBe(true);
    expect(cert.entity.metadata).toMatchObject({ apim_application_id: 'app_1', apim_derived: 'true' });
  });

  test('an mtls plan reads the CN by default, and says when it reads nothing', () => {
    expect(mtlsPlan({}).auth.config.clientIdField).toBe('CN');
    const codes = validateDraft(snapshot([mtlsPlan({ clientIdField: '' })]).draft).warnings.map((w) => w.code);
    expect(codes).toContain('no_client_id_field');
  });
});

describe('subscriptions of token and certificate plans', () => {
  const sub = (auth_kind) => ({ id: 'sub_1', workspace_id: 'ws_1', api_id: 'api_atlas', plan_id: 'plan_1', application_id: 'app_1', auth_kind, status: 'active', dates: {} });
  const app = { id: 'app_1', name: 'Partner app', client_id: 'partner-42' };

  test('carry the client id the application declares, for when Otoroshi reads one', async () => {
    const { buildOtoroshiSubscription } = await import('../server/otoroshi/projection.js');
    for (const kind of ['jwt', 'mtls', 'oauth2-remote']) expect(buildOtoroshiSubscription(sub(kind), { application: app }).metadata.apim_client_id).toBe('partner-42');
    // the key of an apikey plan is its identity; an application without a client id has nothing to carry
    for (const kind of ['apikey', 'oauth2-local', 'keyless']) expect(buildOtoroshiSubscription(sub(kind), { application: app }).metadata.apim_client_id).toBeUndefined();
    expect(buildOtoroshiSubscription(sub('jwt'), { application: { ...app, client_id: null } }).metadata.apim_client_id).toBeUndefined();
  });
});

describe('plan ids shared between apis (G-18)', () => {
  test('a token, certificate or open plan warns when another api has a plan of the same id and kind', async () => {
    const { sharedPlanWarnings } = await import('../server/domain/model.js');
    const draft = snapshot([remotePlan({ verifier: 'm' }), defaultPlan({ id: 'plan_keys', name: 'Keys', auth: { kind: 'apikey' } }), mtlsPlan({ trustedCAs: [CA] })]).draft;
    const others = [
      { name: 'Other', planId: 'plan_sso', kind: 'oauth2-remote' },
      { name: 'Other', planId: 'plan_keys', kind: 'apikey' }, // the keys of an apikey plan come from its subscriptions
      { name: 'Other', planId: 'plan_bulk', kind: 'jwt' }, // another kind, another prefix
    ];
    const warnings = sharedPlanWarnings(draft, others, (o) => `the API "${o.name}"`);
    expect(warnings.map((w) => [w.code, w.path])).toEqual([['plan_id_shared', 'plans[0]']]);
    expect(warnings[0].message).toContain('the API "Other"');
    // a closed plan has no extractor any more
    draft.plans[0].status = 'closed';
    expect(sharedPlanWarnings(draft, others, () => '')).toEqual([]);
  });
});

