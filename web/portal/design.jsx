// The design of the portal, rendered: its theme applied to the page, its links and its assets
// resolved, its templates (Markdoc) rendered with the components of the portal as tags. A template
// holds no script: Markdoc renders no html, its links and images go through the same checks as the
// navigation, and its tags are the ones of web/shared/portal-tags.js.
import React, { lazy, Suspense, useMemo, useState } from 'react';
import Markdoc from '@markdoc/markdoc';
import { Link, useRouter } from '../shared/router.jsx';
import { Callout, Icon, Loading, Markdown, useLoad } from '../shared/ui.jsx';
import { PORTAL_TAGS } from '../shared/portal-tags.js';
import { api, runtime, usePortal } from './context.jsx';
import { useI18n, usePortalText, useT } from './i18n.jsx';
import { ApiCard } from './pages/Catalogue.jsx';
import { PlanCard } from './pages/ApiPage.jsx';

const ApiReference = lazy(() => import('./pages/ApiReference.jsx'));

// ---------------------------------------------------------------- links, assets

// an asset of the design (assets/…) to its url; anything else as it is
export function assetUrl(src, design) {
  const s = String(src || '');
  if (!s) return '';
  if (s.startsWith('_design/')) return `${runtime.base}/${s}`;
  if (design?.assets?.[s]) return `${runtime.base}/${design.assets[s]}`;
  return s;
}

// a link of a design: the web, a mail, a path of the portal, an anchor, a page; nothing else
export function safeHref(href) {
  const s = String(href || '').trim();
  if (/^page:([a-z0-9-]+)$/.test(s)) return { to: `/pages/${s.slice(5)}` };
  if (/^\/(?!\/)/.test(s)) return { to: s };
  if (/^#/.test(s)) return { href: s };
  if (/^(https?:\/\/|mailto:)/i.test(s)) return { href: s, external: /^https?:/i.test(s) };
  return null;
}

// the markdown of a design: its images and links to its assets and its pages resolved
export function DesignMarkdown({ source }) {
  const { design } = usePortal();
  const resolved = String(source || '')
    .replace(/\]\((assets\/[^)\s]+)/g, (m, path) => `](${assetUrl(path, design)}`)
    .replace(/\]\(page:([a-z0-9-]+)\)/g, (m, slug) => `](${runtime.base}/pages/${slug})`);
  return <Markdown source={resolved} />;
}

export function DesignLink({ href, className, children }) {
  const target = safeHref(href);
  if (!target) return <span className={className}>{children}</span>;
  if (target.to) {
    return (
      <Link to={target.to} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={target.href} className={className} {...(target.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {children}
    </a>
  );
}

// ---------------------------------------------------------------- the theme on the page

const COLOR_VARS = { background: '--bg', surface: '--surface', text: '--ink', muted: '--muted', border: '--border' };
const RADII = { none: ['0px', '0px'], small: ['6px', '4px'], large: ['16px', '10px'] };

function styleElement(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

// the accent in every mode; the colors, font, radius, favicon and style sheet of a themed portal;
// its script once, only when the portal allows scripts (the server says so: design.script)
export function applyDesign(design, { preview } = {}) {
  if (!design) return;
  const root = document.documentElement;
  const accent = design.theme?.accent;
  if (accent && /^#[0-9a-f]{3,8}$/i.test(accent)) {
    root.style.setProperty('--brand', accent);
    root.dataset.brand = 'on';
  } else {
    root.style.removeProperty('--brand');
    delete root.dataset.brand;
  }
  const themed = design.mode !== 'default';
  let css = '';
  if (themed) {
    const vars = (c) =>
      Object.entries(COLOR_VARS)
        .filter(([k]) => c?.[k])
        .map(([k, v]) => `${v}: ${c[k]};`)
        .join(' ');
    const { light, dark } = design.theme?.colors || {};
    if (vars(light)) css += `:root { ${vars(light)} }\n`;
    if (vars(dark)) css += `:root[data-theme='dark'] { ${vars(dark)} }\n`;
    const r = RADII[design.theme?.radius];
    if (r) css += `:root { --radius: ${r[0]}; --radius-sm: ${r[1]}; }\n`;
    if (design.theme?.font) css += `:root { --font: ${design.theme.font}; }\n`;
  }
  // as text, never parsed as html: a style sheet cannot end its element
  styleElement('apim-design-theme').textContent = css;
  styleElement('apim-design-css').textContent = themed ? design.css || '' : '';
  const favicon = themed && design.theme?.favicon ? assetUrl(design.theme.favicon, design) : '';
  let icon = document.querySelector('link[rel="icon"][data-design]');
  if (favicon) {
    if (!icon) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      icon.dataset.design = 'on';
      document.head.appendChild(icon);
    }
    icon.href = favicon;
  } else if (icon) icon.remove();
  if (design.script && !document.getElementById('apim-design-script')) {
    const s = document.createElement('script');
    s.id = 'apim-design-script';
    s.src = `${runtime.base}/_design/script.js${preview ? `?preview=${encodeURIComponent(preview)}` : ''}`;
    document.head.appendChild(s);
  }
}

// ---------------------------------------------------------------- Markdoc

const TYPES = { string: String, number: Number, boolean: Boolean };
const RENDER = (name) =>
  name
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

const CONFIG = {
  tags: Object.fromEntries(
    PORTAL_TAGS.map((t) => [
      t.name,
      { render: `Tag${RENDER(t.name)}`, selfClosing: t.selfClosing, attributes: Object.fromEntries(Object.entries(t.attributes).map(([k, v]) => [k, { type: TYPES[v] || String }])) },
    ])
  ),
  nodes: {
    link: { render: 'MdLink', attributes: { href: { type: String }, title: { type: String } } },
    image: { render: 'MdImage', attributes: { src: { type: String }, alt: { type: String }, title: { type: String } } },
  },
};

function useApis() {
  return useLoad(() => api.get('/apis'), []);
}
const latestOf = (list) => Object.values((list || []).reduce((acc, a) => ({ ...acc, [a.slug]: a }), {}));

function Cards({ apis }) {
  const t = useT();
  if (!apis.length)
    return (
      <div className="card">
        <div className="empty">{t('catalogue.none')}</div>
      </div>
    );
  return (
    <div className="pt-grid">
      {apis.map((a) => (
        <ApiCard key={a.id} api={a} />
      ))}
    </div>
  );
}

function TagCatalogue({ category, tag, limit }) {
  const state = useApis();
  const list = latestOf(state.data).filter((a) => (!category || (a.categories || []).includes(category)) && (!tag || (a.tags || []).includes(tag)));
  return state.loading && !state.data ? <Loading /> : <Cards apis={list.slice(0, limit || 6)} />;
}

function TagFeatured({ limit }) {
  const state = useApis();
  const latest = latestOf(state.data);
  const list = (latest.some((a) => a.featured) ? latest.filter((a) => a.featured) : latest).slice(0, limit || 6);
  return state.loading && !state.data ? <Loading /> : <Cards apis={list} />;
}

function TagCategories() {
  const { portal } = usePortal();
  const text = usePortalText(portal);
  const cats = portal?.categories || [];
  if (!cats.length) return null;
  return (
    <div className="row wrap gap-6">
      {cats.map((c) => (
        <Link key={c.slug} to={`/apis?category=${encodeURIComponent(c.slug)}`} className="btn">
          {text(c.name)}
        </Link>
      ))}
    </div>
  );
}

function useApi(slug) {
  return useLoad(() => (slug ? api.get(`/apis/${encodeURIComponent(slug)}`) : Promise.resolve(null)), [slug]);
}

function TagApiCard({ api: slug }) {
  const state = useApi(slug);
  return state.data ? <Cards apis={[state.data]} /> : state.loading ? <Loading /> : null;
}

function TagApiReference({ api: slug }) {
  const state = useApi(slug);
  const spec = useLoad(() => (state.data ? api.get(`/apis/${state.data.id}/openapi`) : Promise.resolve(null)), [state.data?.id]);
  if (!spec.data) return spec.loading || state.loading ? <Loading /> : null;
  return (
    <Suspense fallback={<Loading />}>
      <ApiReference spec={spec.data} />
    </Suspense>
  );
}

function TagPlans({ api: slug }) {
  const state = useApi(slug);
  const { user } = usePortal();
  const { navigate } = useRouter();
  if (!state.data) return state.loading ? <Loading /> : null;
  return (
    <div className="pt-grid">
      {(state.data.plans || []).map((p) => (
        <PlanCard key={p.id} plan={p} user={user} onSubscribe={() => navigate(`/apis/${state.data.slug}/plans?subscribe=${encodeURIComponent(p.id)}`)} />
      ))}
    </div>
  );
}

function TagSubscribe({ api: slug, plan, label }) {
  const t = useT();
  const to = `/apis/${encodeURIComponent(slug || '')}/plans${plan ? `?subscribe=${encodeURIComponent(plan)}` : ''}`;
  return (
    <Link to={to} className="btn primary">
      {label || t('api.seePlans')}
    </Link>
  );
}

function TagButton({ href, kind, children }) {
  return (
    <DesignLink href={href} className={`btn ${kind === 'secondary' ? '' : 'primary'}`}>
      {children}
    </DesignLink>
  );
}

const CALLOUT = { info: 'info', warning: 'warning', success: 'positive', danger: 'negative' };
function TagCallout({ type, title, children }) {
  return (
    <Callout kind={CALLOUT[type] || 'info'} title={title}>
      {children}
    </Callout>
  );
}

function TagColumns({ children }) {
  return <div className="pt-columns">{children}</div>;
}
function TagColumn({ children }) {
  return <div className="pt-column">{children}</div>;
}

function MdLink({ href, title, children }) {
  return (
    <DesignLink href={href} className="link">
      <span title={title}>{children}</span>
    </DesignLink>
  );
}

function useDesignAsset() {
  const { design } = usePortal();
  return (src) => assetUrl(src, design);
}
function MdImage({ src, alt, title }) {
  const asset = useDesignAsset();
  const url = asset(src);
  // an image of the web or of the design; no other scheme
  if (!/^(https?:\/\/|\/)/i.test(url)) return null;
  return <img src={url} alt={alt || ''} title={title} style={{ maxWidth: '100%' }} />;
}

const COMPONENTS = { TagCatalogue, TagFeatured, TagCategories, TagApiCard, TagApiReference, TagPlans, TagSubscribe, TagButton, TagCallout, TagColumns, TagColumn, MdLink, MdImage };

// a template rendered: its variables, its tags; its errors shown in a preview of the draft only
export function Template({ source, variables = {} }) {
  const { design, user, portal } = usePortal();
  const { lang } = useI18n();
  const t = useT();
  const text = usePortalText(portal);
  const vars = { portal: { title: text(design?.texts?.title), tagline: text(design?.texts?.tagline) }, lang, user: { signedIn: !!user, name: user?.name || '' }, ...variables };
  const { content, errors } = useMemo(() => {
    const ast = Markdoc.parse(source || '');
    const config = { ...CONFIG, variables: vars };
    return { errors: Markdoc.validate(ast, config).filter((e) => ['error', 'critical'].includes(e.error.level)), content: Markdoc.transform(ast, config) };
  }, [source, JSON.stringify(vars)]);
  return (
    <div className="md pt-template">
      {design?.preview && errors.length > 0 && (
        <Callout kind="warning" title={t('design.templateErrors')}>
          {errors.slice(0, 10).map((e, i) => (
            <div key={i} className="small mono">
              {e.lines?.length ? `line ${e.lines[0] + 1}: ` : ''}
              {e.error.message}
            </div>
          ))}
        </Callout>
      )}
      {Markdoc.renderers.react(content, React, { components: COMPONENTS })}
    </div>
  );
}

// ---------------------------------------------------------------- the home of a themed portal

function Hero({ block }) {
  const { design, workspace, portal } = usePortal();
  const text = usePortalText(portal);
  const t = useT();
  const { navigate } = useRouter();
  const [q, setQ] = useState('');
  return (
    <section className="pt-hero">
      <div className="pt-container">
        <div className="pt-hero-inner">
          <div className="pt-eyebrow">{workspace?.name}</div>
          <h1 className="pt-hero-title">{text(block?.title) || text(design?.texts?.title)}</h1>
          {(text(block?.tagline) || text(design?.texts?.tagline)) && <p className="pt-hero-tagline">{text(block?.tagline) || text(design?.texts?.tagline)}</p>}
          <form
            className="pt-hero-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              navigate(`/apis${q ? `?q=${encodeURIComponent(q)}` : ''}`);
            }}
          >
            <Icon name="search" />
            <label className="sr-only" htmlFor="hero-search">
              {t('home.search')}
            </label>
            <input id="hero-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('home.search')} />
            <button className="btn primary" type="submit">
              {t('home.browse')}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

function BlockTitle({ block, fallback }) {
  const { portal } = usePortal();
  const text = usePortalText(portal);
  const title = text(block.title) || fallback;
  return title ? <h2 className="mb-16">{title}</h2> : null;
}

export function BlocksHome({ blocks }) {
  const { portal } = usePortal();
  const text = usePortalText(portal);
  const t = useT();
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'hero' ? (
          <Hero key={i} block={b} />
        ) : (
          <div key={i} className="pt-container pt-section">
            {b.kind === 'featured' && (
              <>
                <BlockTitle block={b} fallback={t('home.featured')} />
                <TagFeatured limit={b.limit} />
              </>
            )}
            {b.kind === 'catalogue' && (
              <>
                <BlockTitle block={b} />
                <TagCatalogue category={b.category} tag={b.tag} limit={b.limit} />
              </>
            )}
            {b.kind === 'categories' && (
              <>
                <BlockTitle block={b} />
                <TagCategories />
              </>
            )}
            {b.kind === 'markdown' && text(b.content) && (
              <div className="card">
                <div className="card-body">
                  <DesignMarkdown source={text(b.content)} />
                </div>
              </div>
            )}
          </div>
        )
      )}
    </>
  );
}

// a banner on a preview of the draft
export function PreviewBanner() {
  const { design } = usePortal();
  const t = useT();
  if (!design?.preview) return null;
  return (
    <div className="pt-preview-banner" role="status">
      {t('design.preview')}
    </div>
  );
}
