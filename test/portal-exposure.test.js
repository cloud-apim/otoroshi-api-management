// The form of the portal urls: by root path, by hostname, or at the root of a single-workspace
// installation — and the redirects from the forms served before. No infrastructure.
import { describe, expect, test } from 'bun:test';
import { checkConfig, currentForm, match, nextHistory, portalUrl, redirectFrom } from '../server/portal-exposure.js';

const cfg = (over = {}) => ({
  tenancy: 'multi',
  publicUrl: 'http://localhost:9000',
  bootstrap: { workspace: 'default' },
  ...over,
  portal: { exposure: 'path', domain: 'apis.example.com', url: 'https://portal.example.com', ...(over.portal || {}) },
});
const PATH = { kind: 'path' };
const HOST = { kind: 'hostname', domain: 'apis.example.com' };
const ROOT = { kind: 'root', workspace: 'acme' };
const workspaces = ['acme', 'beta'];
const findWorkspace = async (slug) => (workspaces.includes(slug) ? { slug } : null);
const C = cfg();

describe('the form of the installation', () => {
  test('read from the configuration, and checked', () => {
    expect(currentForm(cfg())).toEqual(PATH);
    expect(currentForm(cfg({ portal: { exposure: 'hostname', domain: 'APIs.example.com' } }))).toEqual(HOST);
    // single tenancy: the exposure does not matter, the bootstrap workspace is served at the root
    expect(currentForm(cfg({ tenancy: 'single', bootstrap: { workspace: 'acme' }, portal: { exposure: 'hostname' } }))).toEqual(ROOT);
    expect(() => checkConfig(cfg({ portal: { exposure: 'subdomain' } }))).toThrow(/APIM_PORTAL_EXPOSURE/);
    expect(() => checkConfig(cfg({ tenancy: 'mono' }))).toThrow(/APIM_TENANCY/);
  });

  test('the url of a portal in each form', () => {
    const c = cfg();
    expect(portalUrl('acme', PATH, c)).toBe('https://portal.example.com/acme/');
    expect(portalUrl('acme', HOST, c)).toBe('https://acme.apis.example.com/');
    expect(portalUrl('acme', HOST, cfg({ portal: { url: 'http://localhost:9000' } }))).toBe('http://acme.apis.example.com:9000/');
    expect(portalUrl('acme', ROOT, c)).toBe('https://portal.example.com/');
    // a root portal serves its workspace alone
    expect(portalUrl('beta', ROOT, c)).toBeNull();
    // without a portal url, the public url of the installation
    expect(portalUrl('acme', PATH, cfg({ portal: { url: null } }))).toBe('http://localhost:9000/acme/');
  });

  test('what a request designates', () => {
    expect(match(PATH, { host: 'portal.example.com', pathname: '/acme/apis/x' })).toEqual({ slug: 'acme', rest: '/apis/x' });
    expect(match(PATH, { host: 'portal.example.com', pathname: '/' })).toBeNull();
    expect(match(HOST, { host: 'acme.apis.example.com:443', pathname: '/apis/x' })).toEqual({ slug: 'acme', rest: '/apis/x' });
    expect(match(HOST, { host: 'apis.example.com', pathname: '/' })).toBeNull();
    expect(match(HOST, { host: 'a.b.apis.example.com', pathname: '/' })).toBeNull();
    expect(match(ROOT, { host: 'anything', pathname: '/apis/x' })).toEqual({ slug: 'acme', rest: '/apis/x' });
  });
});

describe('changing the form', () => {
  test('the form served until then is remembered, once, the latest first', () => {
    const first = nextHistory(null, PATH, 't1');
    expect(first).toEqual({ current: { ...PATH, since: 't1' }, previous: [] });
    // restarting with the same form changes nothing
    expect(nextHistory(first, PATH, 't2')).toBe(first);
    const second = nextHistory(first, HOST, 't2');
    expect(second.current).toEqual({ ...HOST, since: 't2' });
    expect(second.previous).toEqual([{ ...PATH, since: 't1', until: 't2' }]);
    // back to a form served before: it is current again, not a previous one
    const third = nextHistory(second, PATH, 't3');
    expect(third.previous.map((f) => f.kind)).toEqual(['hostname']);
  });

  test('path to hostname: /<workspace>/… leads to <workspace>.<domain>/…', async () => {
    const at = { host: 'portal.example.com', pathname: '/acme/apis/x' };
    expect(await redirectFrom([PATH], at, { findWorkspace, form: HOST, search: '?tab=plans', cfg: C })).toBe('https://acme.apis.example.com/apis/x?tab=plans');
    // not a workspace: not an old url
    expect(await redirectFrom([PATH], { ...at, pathname: '/nobody/x' }, { findWorkspace, form: HOST, cfg: C })).toBeNull();
  });

  test('hostname to path: <workspace>.<domain>/… leads to /<workspace>/…', async () => {
    const at = { host: 'beta.apis.example.com', pathname: '/apps' };
    expect(await redirectFrom([HOST], at, { findWorkspace, form: PATH, cfg: C })).toBe('https://portal.example.com/beta/apps');
  });

  test('single to multi: the root urls lead to the portal of the workspace served before', async () => {
    const at = { host: 'portal.example.com', pathname: '/apis/x' };
    expect(await redirectFrom([ROOT], at, { findWorkspace, form: PATH, cfg: C })).toBe('https://portal.example.com/acme/apis/x');
  });

  test('multi to single: the old urls of the workspace served lead to the root; its own pages stay pages', async () => {
    expect(await redirectFrom([PATH], { host: 'p', pathname: '/acme/apps' }, { findWorkspace, form: ROOT, cfg: C })).toBe('https://portal.example.com/apps');
    // another workspace has no portal any more
    expect(await redirectFrom([PATH], { host: 'p', pathname: '/beta/apps' }, { findWorkspace, form: ROOT, cfg: C })).toBeNull();
    // /apis/… is a page of the root portal, never the workspace "apis" of a path url
    workspaces.push('apis');
    expect(await redirectFrom([PATH], { host: 'p', pathname: '/apis/x' }, { findWorkspace, form: ROOT, cfg: C })).toBeNull();
    workspaces.pop();
  });
});
