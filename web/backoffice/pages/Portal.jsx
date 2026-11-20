// The developer portal of a workspace: its live settings, and its design — edited as a draft,
// published by immutable versions, previewed before. Every action is a call of the admin api; the
// producers read it all, the administrators edit and publish.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import YAML from 'yaml';
import { Link, useRouter } from '../../shared/router.jsx';
import { Badge, Callout, Code, CopyButton, DiffView, Empty, Field, Icon, Input, Loader, Markdown, Modal, NumberInput, Seg, Select, Setting, Switch, Tabs, TagsInput, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { StatTile } from '../../shared/charts.jsx';
import { CodeEditor, CodeView } from '../../shared/code-editor.jsx';
import { fmtBytes, fmtDate, fmtRelative } from '../../shared/lib.js';
import { ListToolbar, Pager, useLocalPaging, usePaging } from '../../shared/lists.jsx';
import { PORTAL_TAGS, PORTAL_VARIABLES } from '../../shared/portal-tags.js';
import { tr, Tr } from '../../shared/i18n.jsx';
import { useWs } from '../context.jsx';
import { PageHead } from '../layout.jsx';

// ---------------------------------------------------------------- helpers

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// the json of the server does not keep the order of the keys: values are compared in a stable form
const stable = (v) => JSON.stringify(v ?? null, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const same = (a, b) => stable(a) === stable(b);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

// a text per language; a plain string is the text of the default language
const loc = (v, def = 'en') => (isObj(v) ? v : typeof v === 'string' && v ? { [def]: v } : {});
const withText = (v, lang, text, def) => {
  const next = { ...loc(v, def) };
  if (text) next[lang] = text;
  else delete next[lang];
  return next;
};
// written in the default language, not yet in this one
const lacks = (v, l, def) => !!loc(v, def)[def] && !loc(v, def)[l];

// the files a design may carry (the server's list): images, fonts, style sheets — never a script
const ASSET_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  css: 'text/css',
};
const ASSET_MAX = 2 * 1024 * 1024;
const typeOf = (path) => ASSET_TYPES[String(path).split('.').pop().toLowerCase()] || '';
const isImage = (path) => typeOf(path).startsWith('image/');

const modes = () => [
  { id: 'default', label: tr('Default'), text: tr('The template of the product, as it is: its texts, its accent color, its logo, the markdown of its home and its pages.') },
  { id: 'themed', label: tr('Themed'), text: tr('The same pages, themed — colors, font, radius, favicon, a style sheet of yours — and a home made of blocks.') },
  { id: 'templates', label: tr('Templates'), text: tr('The home, the overview of an api and the free pages written in Markdoc, the components of the portal as tags, on top of the theme.') },
];
const modeLabel = (m) => modes().find((x) => x.id === m)?.label || m || '—';

const BLOCK_KINDS = ['hero', 'featured', 'catalogue', 'categories', 'markdown'];
const blockKinds = () => ({
  hero: { label: tr('Hero'), help: tr('the title and the tagline of the portal, large — or texts of their own') },
  featured: { label: tr('Featured apis'), help: tr('the cards of the featured apis (an api is featured from its page, tab Catalogue)') },
  catalogue: { label: tr('Catalogue'), help: tr('the cards of the apis of the catalogue — of a category, of a tag') },
  categories: { label: tr('Categories'), help: tr('the categories of the catalogue, each a link to its apis') },
  markdown: { label: tr('Markdown'), help: tr('a text of yours, in each language') },
});
const NEW_BLOCK = {
  hero: { kind: 'hero', title: {}, tagline: {} },
  featured: { kind: 'featured', limit: 6 },
  catalogue: { kind: 'catalogue', category: '', tag: '', limit: 6 },
  categories: { kind: 'categories' },
  markdown: { kind: 'markdown', content: {} },
};

const COLOR_KEYS = ['background', 'surface', 'text', 'muted', 'border'];
const colorLabels = () => ({ background: tr('Background'), surface: tr('Surfaces (cards)'), text: tr('Text'), muted: tr('Secondary text'), border: tr('Borders') });

// the parts of the draft, as the save bar names them
const partLabels = () => ({
  mode: tr('mode'),
  texts: tr('texts'),
  theme: tr('theme'),
  navigation: tr('navigation'),
  home: tr('home'),
  pages: tr('pages'),
  templates: tr('templates'),
  css: tr('style sheet'),
  script: tr('script'),
  assets: tr('assets'),
});

// what an empty template editor suggests: code, not text
const PLACEHOLDERS = {
  home: '# {% $portal.title %}\n\n{% featured limit=3 /%}\n\n{% catalogue limit=6 /%}',
  api: '# {% $api.name %} {% $api.version %}\n\n{% $api.description %}\n\n{% plans api=$api.slug /%}',
  page: '# Markdoc\n\n{% callout type="info" title="Good to know" %}…{% /callout %}',
  css: ':root {\n  /* the style sheet of the portal */\n}',
  script: '// runs in the portal, in the session of every consumer — only where scripts are allowed',
};

// the languages of the portal: its texts are edited in each, the default first
function usePortalLanguages() {
  const { ws } = useWs();
  const languages = ws.portal?.languages?.length ? ws.portal.languages : ['en'];
  const def = languages.includes(ws.portal?.defaultLanguage) ? ws.portal.defaultLanguage : languages[0];
  const [chosen, setLang] = useState(def);
  return { languages, def, lang: languages.includes(chosen) ? chosen : def, setLang };
}

function LangSeg({ L, missing }) {
  return (
    <Seg
      value={L.lang}
      onChange={L.setLang}
      options={L.languages.map((l) => ({ value: l, label: `${l.toUpperCase()}${l === L.def ? ` · ${tr('default')}` : ''}${missing?.(l) ? ' · …' : ''}` }))}
    />
  );
}

function MissingNote({ L, names }) {
  if (L.lang === L.def || !names.length) return null;
  return (
    <Callout kind="info">
      <Tr text={'Not written in {0} yet: {1} — the portal shows the {2} text meanwhile.'} args={[L.lang.toUpperCase(), names.join(', '), L.def.toUpperCase()]} />
    </Callout>
  );
}

// a color of the theme: picked or typed; empty is the color of the product
const pickerValue = (v, fallback) => {
  const s = String(v || '');
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return s.slice(0, 7);
  if (/^#[0-9a-f]{3,4}$/i.test(s)) return `#${[...s.slice(1, 4)].map((c) => c + c).join('')}`;
  return fallback || '#ffffff';
};

function ColorField({ value, onChange, fallback, label, ro }) {
  return (
    <div className="color-field">
      <input type="color" className={value || fallback ? '' : 'unset'} value={pickerValue(value, fallback)} onChange={(e) => onChange(e.target.value)} disabled={ro} aria-label={label} />
      <Input value={value || ''} onChange={(v) => onChange(v.trim())} mono placeholder={fallback || tr('default')} disabled={ro} aria-label={tr('{0}, hexadecimal', [label])} />
      {!fallback && value && !ro && (
        <button type="button" className="btn ghost xs icon" onClick={() => onChange('')} aria-label={tr('back to the default: {0}', [label])}>
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

// an image of the theme: an url of the web, or an image among the assets of the design
function ImageField({ value, onChange, assets, base, label, ro }) {
  const images = Object.keys(assets || {}).filter(isImage);
  const asset = String(value || '').startsWith('assets/');
  const src = asset ? (assets?.[value] && base ? `${base}/_design/assets/${assets[value]}` : '') : value;
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      {src ? <img className="asset-thumb" src={src} alt="" /> : <span className="asset-thumb" aria-hidden="true" />}
      <div className="col gap-6 grow" style={{ minWidth: 0 }}>
        <Select
          value={asset ? value : ''}
          onChange={onChange}
          disabled={ro}
          aria-label={tr('{0}: an url or an asset', [label])}
          options={[{ value: '', label: images.length ? tr('An url — or pick an image among the assets') : tr('An url (no image among the assets yet)') }, ...images.map((p) => ({ value: p, label: p }))]}
        />
        {!asset && <Input value={value || ''} onChange={(v) => onChange(v.trim())} mono placeholder="https://…" disabled={ro} aria-label={tr('{0}: its url', [label])} />}
      </div>
    </div>
  );
}

// the tags and the variables of the templates, beside their editors
function TagsHelp({ scope }) {
  const variables = PORTAL_VARIABLES.filter((v) => !v.in || v.in === scope);
  return (
    <aside className="card tags-help" aria-label={tr('Tags and variables of the templates')}>
      <div className="card-head">
        <Icon name="info" />
        <h3 className="grow">{tr('Tags and variables')}</h3>
      </div>
      <div className="card-body col gap-12">
        <p className="muted small" style={{ margin: 0 }}>
          {tr('Markdoc: markdown, with the components of the portal as tags and the values of the page as variables. No html, no script. Copy an example and paste it in the template.')}
        </p>
        {PORTAL_TAGS.map((t) => (
          <div key={t.name} className="col gap-4">
            <div className="row" style={{ gap: 6 }}>
              <span className="mono bold small">{t.name}</span>
              {Object.keys(t.attributes || {}).length > 0 && <span className="faint mono tiny ellipsis">{Object.entries(t.attributes).map(([k, type]) => `${k}: ${type}`).join(', ')}</span>}
            </div>
            <div className="muted small">{tr(t.description)}</div>
            <div className="tag-example">
              <code>{t.example}</code>
              <CopyButton text={t.example} className="btn xs ghost icon" />
            </div>
          </div>
        ))}
        <div className="label mt-8">{tr('Variables')}</div>
        {variables.map((v) => (
          <div key={v.name} className="col" style={{ gap: 2 }}>
            <span className="mono small bold">{v.name}</span>
            <span className="muted small">{tr(v.description)}</span>
          </div>
        ))}
        <p className="faint tiny" style={{ margin: 0 }}>
          <Tr text={'A variable in a text: {0}; as the value of an attribute: {1}.'} args={[<code className="mono">{'{% $portal.title %}'}</code>, <code className="mono">{'api=$api.slug'}</code>]} />
        </p>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ data, dirty, canPublish, onPublish, onPreview }) {
  const { ws } = useWs();
  const at = data.published.number ? data.published : null;
  const publishedMode = data.published.design?.mode;
  return (
    <div className="col gap-16">
      <Callout kind="info">
        <Tr
          text={'One portal per workspace, at {0}. Its exposure — by root path, by hostname, or at the root of a single-workspace installation — is an installation setting.'}
          args={[
            <a className="link mono" href={ws.portal_url} target="_blank" rel="noreferrer">
              {ws.portal_url}
            </a>,
          ]}
        />
      </Callout>
      <div className="grid-4">
        <StatTile label={tr('Mode of the draft')} value={modeLabel(data.draft.mode)} hint={publishedMode && publishedMode !== data.draft.mode ? tr('published: {0}', [modeLabel(publishedMode)]) : ''} />
        <StatTile
          label={tr('Published version')}
          value={data.published.number ? tr('#{0}', [data.published.number]) : tr('None yet')}
          hint={at ? `${fmtDate(at.published_at)}${at.published_by_email ? ` · ${at.published_by_email}` : ''}` : data.published.number ? '' : tr('the portal shows its settings as they were')}
        />
        <StatTile label={tr('Changes in the draft')} value={data.changes.length} hint={data.changes.length ? tr('not on the portal until published') : tr('the draft is the published design')} />
        <StatTile label={tr('Versions')} value={data.versions} />
      </div>
      {data.draft.script && !data.scripts.enabled && (
        <Callout kind="warning" title={tr('A script is kept, not served')}>
          {tr('The design has a script, but scripts are not allowed on this portal: the portal does not serve it. The administrators allow them on the tab Styles & scripts.')}
        </Callout>
      )}
      <div className="card">
        <div className="card-head">
          <Icon name="layers" />
          <h3 className="grow">{tr('Changes since the published version')}</h3>
          <button className="btn sm" onClick={onPreview} disabled={dirty} title={dirty ? tr('save the draft first') : tr('the portal showing the draft, for an hour')}>
            <Icon name="eye" /> {tr('Preview the draft')}
          </button>
          {canPublish && (
            <button className="btn sm primary" onClick={onPublish} disabled={dirty || (data.published.number > 0 && !data.changes.length)} title={dirty ? tr('save the draft first') : ''}>
              <Icon name="upload" /> {tr('Publish')}
            </button>
          )}
        </div>
        <div className="card-body">
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <DiffView changes={data.changes} empty={data.published.number ? tr('None: the draft is the version the portal shows.') : tr('No version yet: the portal shows its settings as they were. Publish the draft to show its design.')} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PublishModal({ data, onClose, onDone }) {
  const { wapi } = useWs();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await wapi.post('/portal/publish', { comment });
      toast(tr('Version #{0} of the design published', [r.number]));
      onDone(r);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tr('Publish a version of the design')}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {tr('Publish')}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ margin: 0 }}>
        {tr('A version is immutable, and the portal shows it at once. Rolling back is restoring an earlier version into the draft, then publishing it.')}
      </p>
      <div className="label">{tr('Changes since the published version')}</div>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        <DiffView changes={data.changes} empty={tr('No change: the first version is the design as it is.')} />
      </div>
      <Field label={tr('Comment')}>
        <Input value={comment} onChange={setComment} placeholder={tr('what changes, and why')} autoFocus />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- settings: live, not designed

// the categories of the catalogue: the editorial axis of the discovery, a slug and a name per language
function PortalCategories({ categories, onChange, L, ro }) {
  const update = (i, patch) => onChange(categories.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">{tr('Catalogue categories')}</h3>
        <LangSeg L={L} />
        {!ro && (
          <button className="btn sm" onClick={() => onChange([...categories, { slug: `category-${categories.length + 1}`, name: { [L.def]: tr('New category') } }])}>
            <Icon name="plus" /> {tr('Add a category')}
          </button>
        )}
      </div>
      <fieldset disabled={ro} className="ro-fieldset card-body col gap-8">
        <p className="muted small">{tr('The categories the consumers browse the catalogue by; each api is placed in its own from its page, tab Catalogue.')}</p>
        {!categories.length && <span className="faint small">{tr('No category yet: the catalogue is a single list.')}</span>}
        {categories.map((c, i) => (
          <div key={i} className="row">
            <Input value={c.slug} onChange={(v) => update(i, { slug: v })} mono aria-label={tr('slug of category {0}', [i + 1])} />
            <Input
              value={loc(c.name, L.def)[L.lang] || ''}
              onChange={(v) => update(i, { name: { ...loc(c.name, L.def), [L.lang]: v } })}
              placeholder={L.lang !== L.def ? loc(c.name, L.def)[L.def] : ''}
              aria-label={tr('name of category {0} ({1})', [i + 1, L.lang])}
            />
            {!ro && (
              <button className="btn ghost sm icon" aria-label={tr('delete the category')} onClick={() => onChange(categories.filter((_, j) => j !== i))}>
                <Icon name="trash" />
              </button>
            )}
          </div>
        ))}
      </fieldset>
    </div>
  );
}

// the settings of the portal that are not its design: they apply at once, never by version
const LIVE = ['languages', 'defaultLanguage', 'selfSignup', 'localLogin', 'oidc', 'discovery', 'categories'];

function LiveSettings() {
  const { wapi, ws, session, isAdmin } = useWs();
  const ro = !isAdmin;
  const toast = useToast();
  const [p, setP] = useState(() => pick(ws.portal || {}, LIVE));
  const set = (k) => (v) => setP((x) => ({ ...x, [k]: v }));
  // the languages as edited here: the categories are named in each
  const languages = p.languages?.length ? p.languages : ['en'];
  const def = languages.includes(p.defaultLanguage) ? p.defaultLanguage : languages[0];
  const [lang, setLang] = useState(def);
  const L = { languages, def, lang: languages.includes(lang) ? lang : def, setLang };
  const save = async () => {
    try {
      // only the live keys: the rest of the portal (its scripts, its owner) is not this form's
      await wapi.put('', { portal: p });
      toast(tr('Portal settings saved'));
      session.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="col gap-16">
      <p className="muted small" style={{ margin: 0 }}>
        {tr('These settings apply to the portal as soon as they are saved: they are not part of its design, and have no version.')}
      </p>
      <div className="card">
        <div className="card-head">
          <h3>{tr('Languages and accounts')}</h3>
        </div>
        <fieldset disabled={ro} className="ro-fieldset card-body">
          <Setting label={tr('Languages')} help={tr('of the portal: its interface (English and French today) and the texts of its design; the documentation pages declare their own')}>
            <TagsInput value={p.languages || []} onChange={set('languages')} />
            <Select value={def} onChange={set('defaultLanguage')} options={languages.map((l) => ({ value: l, label: tr('default: {0}', [l]) }))} />
          </Setting>
          <Setting label={tr('Self signup')} help={tr('anyone can create an account and get a key on public plans')}>
            <Switch checked={p.selfSignup} onChange={set('selfSignup')} />
          </Setting>
          <Setting label={tr('Identity provider')} help={tr('One IdP per portal: the people of this workspace sign in with it and join as consumers. Redirect uri: {0}/front/api/auth/oidc/callback', [String(ws.portal_url || '').replace(/\/$/, '')])}>
            <Switch checked={p.oidc?.enabled} onChange={(v) => set('oidc')({ ...p.oidc, enabled: v })} label={tr('Sign in with an OpenID Connect provider')} />
            {p.oidc?.enabled && (
              <>
                <Input value={p.oidc?.label} onChange={(v) => set('oidc')({ ...p.oidc, label: v })} placeholder={tr('button label, e.g. Corporate SSO')} />
                <Input value={p.oidc?.issuer} onChange={(v) => set('oidc')({ ...p.oidc, issuer: v })} mono placeholder={tr('issuer')} />
                <div className="row">
                  <Input value={p.oidc?.clientId} onChange={(v) => set('oidc')({ ...p.oidc, clientId: v })} mono placeholder={tr('client id')} />
                  <Input value={p.oidc?.clientSecret} onChange={(v) => set('oidc')({ ...p.oidc, clientSecret: v })} mono type="password" placeholder={tr('client secret')} />
                </div>
                <Switch checked={p.localLogin !== false} onChange={set('localLogin')} label={tr('Keep local accounts on this portal')} />
              </>
            )}
          </Setting>
          <Setting label={tr('Discovery')} help={tr('what the catalogue shows beside the categories: the reviews of the consumers who subscribed, and the real usage of each api (its subscribed applications, its calls of the last thirty days)')}>
            <Switch checked={p.discovery?.reviews !== false} onChange={(v) => set('discovery')({ ...p.discovery, reviews: v })} label={tr('Consumer reviews')} />
            <Switch checked={p.discovery?.usage !== false} onChange={(v) => set('discovery')({ ...p.discovery, usage: v })} label={tr('Real usage')} />
          </Setting>
        </fieldset>
      </div>
      <PortalCategories categories={p.categories || []} onChange={set('categories')} L={L} ro={ro} />
      {!ro && (
        <div className="row">
          <button className="btn primary" onClick={save}>
            {tr('Save')}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- design: mode, texts, theme

function ModeChoice({ value, onChange, ro }) {
  return (
    <div className="mode-choice" role="radiogroup" aria-label={tr('Mode of the portal')}>
      {modes().map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={value === m.id} className={value === m.id ? 'on' : ''} disabled={ro} onClick={() => onChange(m.id)}>
          <span className="row" style={{ gap: 6 }}>
            <span className={`mode-dot ${value === m.id ? 'on' : ''}`} aria-hidden="true" />
            <span className="bold">{m.label}</span>
          </span>
          <span className="muted small">{m.text}</span>
        </button>
      ))}
    </div>
  );
}

function DesignSection({ draft, set, ro, L, base }) {
  const themed = draft.mode !== 'default';
  const t = draft.texts || {};
  const th = draft.theme || {};
  const setText = (k) => (v) => set('texts')((x) => ({ ...x, [k]: withText(x?.[k], L.lang, v, L.def) }));
  const setTheme = (patch) => set('theme')((x) => ({ ...x, ...patch }));
  const setColor = (side, k) => (v) =>
    set('theme')((x) => {
      const c = { ...(x.colors?.[side] || {}) };
      if (v) c[k] = v;
      else delete c[k];
      return { ...x, colors: { ...(x.colors || {}), [side]: c } };
    });
  const missing = (l) => ['title', 'tagline'].filter((k) => lacks(t[k], l, L.def)).map((k) => (k === 'title' ? tr('title') : tr('tagline')));
  const labels = colorLabels();
  return (
    <div className="col gap-16">
      <div className="card">
        <div className="card-head">
          <h3>{tr('Mode')}</h3>
        </div>
        <div className="card-body">
          <ModeChoice value={draft.mode} onChange={set('mode')} ro={ro} />
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{tr('Texts')}</h3>
          <LangSeg L={L} missing={(l) => missing(l).length > 0} />
        </div>
        <div className="card-body">
          <MissingNote L={L} names={missing(L.lang)} />
          <fieldset disabled={ro} className="ro-fieldset">
            <Setting label={tr('Title ({0})', [L.lang])} help={tr('the name of the portal, in its header and the browser tab')}>
              <Input value={loc(t.title, L.def)[L.lang] || ''} onChange={setText('title')} placeholder={L.lang !== L.def ? loc(t.title, L.def)[L.def] : ''} />
            </Setting>
            <Setting label={tr('Tagline ({0})', [L.lang])} help={tr('below the title, on the home page')}>
              <Input value={loc(t.tagline, L.def)[L.lang] || ''} onChange={setText('tagline')} placeholder={L.lang !== L.def ? loc(t.tagline, L.def)[L.def] : ''} />
            </Setting>
          </fieldset>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{tr('Theme')}</h3>
          {!themed && <span className="muted small">{tr('the themed and templates modes add the favicon, the font, the radius and the colors')}</span>}
        </div>
        <fieldset disabled={ro} className="ro-fieldset card-body">
          <Setting label={tr('Accent color')} help={tr('the links, the buttons, what is selected')}>
            <ColorField value={th.accent} onChange={(v) => setTheme({ accent: v })} fallback="#0061bd" label={tr('accent color')} ro={ro} />
          </Setting>
          <Setting label={tr('Logo')} help={tr('in the header of the portal: an url, or an image among the assets of the design')}>
            <ImageField value={th.logo} onChange={(v) => setTheme({ logo: v })} assets={draft.assets} base={base} label={tr('logo')} ro={ro} />
          </Setting>
          {themed && (
            <>
              <Setting label={tr('Favicon')} help={tr('the icon of the browser tab: an url, or an image among the assets (ico, png, svg)')}>
                <ImageField value={th.favicon} onChange={(v) => setTheme({ favicon: v })} assets={draft.assets} base={base} label={tr('favicon')} ro={ro} />
              </Setting>
              <Setting label={tr('Font')} help={tr('a css font-family; a font among the assets is declared with @font-face in the style sheet')}>
                <Input value={th.font || ''} onChange={(v) => setTheme({ font: v })} mono placeholder={tr('e.g. "Inter", system-ui, sans-serif')} />
              </Setting>
              <Setting label={tr('Corners')} help={tr('the radius of the cards, the buttons and the fields')}>
                <div className="row">
                  <Seg
                    value={th.radius || 'medium'}
                    onChange={(v) => setTheme({ radius: v })}
                    options={[
                      { value: 'none', label: tr('Square') },
                      { value: 'small', label: tr('Small') },
                      { value: 'medium', label: tr('Medium') },
                      { value: 'large', label: tr('Large') },
                    ]}
                  />
                </div>
              </Setting>
              <Setting label={tr('Colors')} help={tr('of the light and the dark theme of the portal; empty, the color of the product')}>
                <div className="colors-grid">
                  <span />
                  <span className="small bold">{tr('Light')}</span>
                  <span className="small bold">{tr('Dark')}</span>
                  {COLOR_KEYS.map((k) => (
                    <React.Fragment key={k}>
                      <span className="small muted">{labels[k]}</span>
                      <ColorField value={th.colors?.light?.[k]} onChange={setColor('light', k)} label={tr('{0}, light theme', [labels[k]])} ro={ro} />
                      <ColorField value={th.colors?.dark?.[k]} onChange={setColor('dark', k)} label={tr('{0}, dark theme', [labels[k]])} ro={ro} />
                    </React.Fragment>
                  ))}
                </div>
              </Setting>
            </>
          )}
        </fieldset>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- home

function HomeMarkdown({ value, onChange, ro, L }) {
  const [view, setView] = useState('write');
  const v = loc(value, L.def);
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">{tr('Home page ({0})', [L.lang])}</h3>
        <Seg
          value={view}
          onChange={setView}
          options={[
            { value: 'write', label: tr('Write') },
            { value: 'preview', label: tr('Preview') },
          ]}
        />
        <LangSeg L={L} missing={(l) => lacks(value, l, L.def)} />
      </div>
      <div className="card-body col gap-12">
        <p className="muted small" style={{ margin: 0 }}>
          {tr('markdown, below the hero of the portal home')}
        </p>
        <MissingNote L={L} names={lacks(value, L.lang, L.def) ? [tr('home page')] : []} />
        {view === 'write' ? (
          <CodeEditor key={L.lang} value={v[L.lang] || ''} onChange={(t) => onChange(withText(value, L.lang, t, L.def))} readOnly={ro} language="markdown" wordWrap="on" minHeight={260} maxHeight={640} ariaLabel={tr('home page ({0})', [L.lang])} placeholder={ro ? '' : tr('# Markdown')} />
        ) : (
          <div className="panel" style={{ background: 'var(--surface)' }}>{v[L.lang] ? <Markdown source={v[L.lang]} /> : <span className="muted small">{tr('Nothing written yet.')}</span>}</div>
        )}
      </div>
    </div>
  );
}

// the home of a themed portal: blocks, in their order
function BlocksEditor({ blocks, onChange, ro, L, categories }) {
  const [kind, setKind] = useState('markdown');
  const kinds = blockKinds();
  const update = (i, patch) => onChange(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const move = (i, d) => {
    const next = [...blocks];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const text = (b, k) => loc(b[k], L.def)[L.lang] || '';
  const setText = (i, b, k) => (v) => update(i, { [k]: withText(b[k], L.lang, v, L.def) });
  const titleField = (b, i, hint) => (
    <Field label={tr('Title ({0})', [L.lang])} hint={hint}>
      <Input value={text(b, 'title')} onChange={setText(i, b, 'title')} placeholder={L.lang !== L.def ? loc(b.title, L.def)[L.def] : ''} />
    </Field>
  );
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">{tr('Blocks of the home')}</h3>
        <LangSeg L={L} />
        {!ro && (
          <>
            <Select value={kind} onChange={setKind} options={BLOCK_KINDS.map((k) => ({ value: k, label: kinds[k].label }))} style={{ width: 170 }} aria-label={tr('kind of the new block')} />
            <button className="btn sm" disabled={blocks.length >= 30} onClick={() => onChange([...blocks, structuredClone(NEW_BLOCK[kind])])}>
              <Icon name="plus" /> {tr('Add a block')}
            </button>
          </>
        )}
      </div>
      <div className="card-body col gap-12">
        <p className="muted small" style={{ margin: 0 }}>
          {tr('The home of a themed portal, from top to bottom: 30 blocks at most.')}
        </p>
        {!blocks.length && <span className="faint small">{tr('No block: the home is empty.')}</span>}
        {blocks.map((b, i) => (
          <div key={i} className="panel col gap-8">
            <div className="row">
              <span className="faint mono small">{i + 1}</span>
              <Badge kind="accent">{kinds[b.kind]?.label || b.kind}</Badge>
              <span className="muted small grow">{kinds[b.kind]?.help}</span>
              {!ro && (
                <>
                  <button className="btn ghost sm icon" aria-label={tr('move up')} disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon name="chevronUp" size={14} />
                  </button>
                  <button className="btn ghost sm icon" aria-label={tr('move down')} disabled={i === blocks.length - 1} onClick={() => move(i, 1)}>
                    <Icon name="chevronDown" size={14} />
                  </button>
                  <button className="btn ghost sm icon" aria-label={tr('remove the block')} onClick={() => onChange(blocks.filter((_, j) => j !== i))}>
                    <Icon name="trash" />
                  </button>
                </>
              )}
            </div>
            <fieldset disabled={ro} className="ro-fieldset col gap-8">
              {b.kind === 'hero' && (
                <div className="grid-2">
                  {titleField(b, i, tr('empty, the title of the portal'))}
                  <Field label={tr('Tagline ({0})', [L.lang])} hint={tr('empty, the tagline of the portal')}>
                    <Input value={text(b, 'tagline')} onChange={setText(i, b, 'tagline')} placeholder={L.lang !== L.def ? loc(b.tagline, L.def)[L.def] : ''} />
                  </Field>
                </div>
              )}
              {b.kind === 'featured' && (
                <div className="grid-2">
                  {titleField(b, i, tr('optional'))}
                  <Field label={tr('How many')} hint={tr('1 to 24')}>
                    <NumberInput value={b.limit} onChange={(v) => update(i, { limit: v })} min={1} max={24} />
                  </Field>
                </div>
              )}
              {b.kind === 'catalogue' && (
                <>
                  <div className="grid-2">
                    {titleField(b, i, tr('optional'))}
                    <Field label={tr('How many')} hint={tr('1 to 24')}>
                      <NumberInput value={b.limit} onChange={(v) => update(i, { limit: v })} min={1} max={24} />
                    </Field>
                  </div>
                  <div className="grid-2">
                    <Field label={tr('Category')}>
                      <Select
                        value={b.category || ''}
                        onChange={(v) => update(i, { category: v })}
                        options={[{ value: '', label: tr('Every category') }, ...categories.map((c) => ({ value: c.slug, label: loc(c.name, L.def)[L.lang] || loc(c.name, L.def)[L.def] || c.slug }))]}
                      />
                    </Field>
                    <Field label={tr('Tag')} hint={tr('the apis carrying this tag only')}>
                      <Input value={b.tag || ''} onChange={(v) => update(i, { tag: v })} mono />
                    </Field>
                  </div>
                </>
              )}
              {b.kind === 'categories' && titleField(b, i, tr('optional'))}
              {b.kind === 'markdown' && (
                <>
                  {titleField(b, i, tr('optional'))}
                  <CodeEditor
                    key={`${i}-${L.lang}`}
                    value={text(b, 'content')}
                    onChange={setText(i, b, 'content')}
                    readOnly={ro}
                    language="markdown"
                    wordWrap="on"
                    minHeight={140}
                    maxHeight={420}
                    ariaLabel={tr('block {0} ({1})', [i + 1, L.lang])}
                    placeholder={ro ? '' : tr('# Markdown')}
                  />
                </>
              )}
            </fieldset>
          </div>
        ))}
      </div>
    </div>
  );
}

// a template of the design, per language, in Markdoc
function TemplateEditor({ name, title, help, value, onChange, ro, L }) {
  const v = loc(value, L.def);
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">{title}</h3>
        <LangSeg L={L} missing={(l) => lacks(value, l, L.def)} />
      </div>
      <div className="card-body col gap-12">
        <p className="muted small" style={{ margin: 0 }}>
          {help}
        </p>
        <MissingNote L={L} names={lacks(value, L.lang, L.def) ? [tr('template')] : []} />
        <CodeEditor
          key={`${name}-${L.lang}`}
          value={v[L.lang] || ''}
          onChange={(t) => onChange(withText(value, L.lang, t, L.def))}
          readOnly={ro}
          language="markdown"
          wordWrap="on"
          minHeight={320}
          maxHeight={760}
          ariaLabel={tr('template {0} ({1})', [name, L.lang])}
          placeholder={ro ? '' : PLACEHOLDERS[name]}
        />
      </div>
    </div>
  );
}

function HomeSection({ draft, set, ro, L, categories, goDesign }) {
  const home = draft.home || {};
  const setHome = (k) => (v) => set('home')((h) => ({ ...h, [k]: v }));
  const said = {
    default: tr('In the default mode, the home is the template of the product: its hero, then your markdown.'),
    themed: tr('In the themed mode, the home is made of blocks.'),
    templates: tr('In the templates mode, the home is a template of yours.'),
  };
  return (
    <div className="col gap-16">
      <div className="row">
        <p className="muted small grow" style={{ margin: 0 }}>
          {said[draft.mode]}
        </p>
        <button className="btn ghost sm" onClick={goDesign}>
          {tr('Change the mode')}
        </button>
      </div>
      {draft.mode === 'default' && <HomeMarkdown value={home.markdown} onChange={setHome('markdown')} ro={ro} L={L} />}
      {draft.mode === 'themed' && <BlocksEditor blocks={home.blocks || []} onChange={setHome('blocks')} ro={ro} L={L} categories={categories} />}
      {draft.mode === 'templates' && (
        <div className="editor-help">
          <TemplateEditor
            name="home"
            title={tr('Template of the home ({0})', [L.lang])}
            help={tr('The home page of the portal, in Markdoc: markdown, and the components of the portal as tags.')}
            value={draft.templates?.home}
            onChange={(v) => set('templates')((t) => ({ ...t, home: v }))}
            ro={ro}
            L={L}
          />
          <TagsHelp scope="home" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pages

// the pages a workspace writes for its portal, beyond its home: in each language of the portal, in
// its navigation or reached by their link only
function PortalPages({ pages, onChange, L, ro, markdoc }) {
  const [open, setOpen] = useState(null);
  const { lang, def } = L;
  const indexed = useMemo(() => pages.map((p, i) => ({ ...p, _i: i })), [pages]);
  const paging = useLocalPaging(indexed, { prefix: 'pages', size: 10, text: (p) => `${p.slug} ${Object.values(loc(p.title, def)).join(' ')}` });
  const update = (i, patch) => onChange(pages.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const move = (i, d) => {
    const next = [...pages];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
    if (open === i) setOpen(i + d);
  };
  const add = () => {
    const slugs = new Set(pages.map((p) => p.slug));
    let n = pages.length + 1;
    while (slugs.has(`page-${n}`)) n++;
    onChange([...pages, { slug: `page-${n}`, title: { [def]: tr('New page') }, content: {}, nav: true }]);
    setOpen(pages.length);
    if (paging.q) paging.setQ('');
    else paging.setPage(Math.ceil((pages.length + 1) / paging.limit));
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">{tr('Pages')}</h3>
        <LangSeg L={L} />
        {!ro && (
          <button className="btn sm" disabled={pages.length >= 30} onClick={add}>
            <Icon name="plus" /> {tr('Add a page')}
          </button>
        )}
      </div>
      <div className="card-body col gap-12">
        <p className="muted small" style={{ margin: 0 }}>
          {markdoc
            ? tr('Pages of the portal beyond its home — terms, a guide, a contact page — written in Markdoc, in each language of the portal; at /pages/<slug>.')
            : tr('Pages of the portal beyond its home — terms, a guide, a contact page — written in markdown, in each language of the portal; at /pages/<slug>.')}
        </p>
        {pages.length > 0 && <ListToolbar paging={paging} placeholder={tr('search pages, slugs, titles')} />}
        {!pages.length && <span className="faint small">{tr('No page yet.')}</span>}
        {pages.length > 0 && !paging.items.length && <Empty title={tr('No page matches')} icon="doc" />}
        {paging.items.map((p) => {
          const i = p._i;
          const title = loc(p.title, def);
          return (
            <div key={i} className="panel col gap-8">
              <div className="row">
                <button className="btn ghost sm" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                  <Icon name={open === i ? 'chevronDown' : 'chevronRight'} size={14} /> {title[lang] || title[def] || p.slug}
                </button>
                <span className="faint mono small">{`/pages/${p.slug}`}</span>
                {p.nav !== false && <Badge>{tr('in the navigation')}</Badge>}
                <span className="spacer" />
                {!ro && (
                  <>
                    <button className="btn ghost sm icon" aria-label={tr('move up')} disabled={i === 0} onClick={() => move(i, -1)}>
                      <Icon name="chevronUp" size={14} />
                    </button>
                    <button className="btn ghost sm icon" aria-label={tr('move down')} disabled={i === pages.length - 1} onClick={() => move(i, 1)}>
                      <Icon name="chevronDown" size={14} />
                    </button>
                    <button
                      className="btn ghost sm icon"
                      aria-label={tr('delete the page')}
                      onClick={() => {
                        onChange(pages.filter((_, j) => j !== i));
                        setOpen(null);
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  </>
                )}
              </div>
              {open === i && (
                <fieldset disabled={ro} className="ro-fieldset col gap-8">
                  <div className="grid-2">
                    <Field label={tr('Slug')}>
                      <Input value={p.slug} onChange={(v) => update(i, { slug: v })} mono />
                    </Field>
                    <Field label={tr('Title ({0})', [lang])}>
                      <Input value={title[lang] || ''} onChange={(v) => update(i, { title: withText(p.title, lang, v, def) })} placeholder={lang !== def ? title[def] : ''} />
                    </Field>
                  </div>
                  <Switch checked={p.nav !== false} onChange={(v) => update(i, { nav: v })} label={tr('In the navigation of the portal')} />
                  <CodeEditor
                    key={`${i}-${lang}`}
                    value={loc(p.content, def)[lang] || ''}
                    onChange={(v) => update(i, { content: withText(p.content, lang, v, def) })}
                    readOnly={ro}
                    language="markdown"
                    wordWrap="on"
                    minHeight={200}
                    maxHeight={520}
                    ariaLabel={tr('page {0} ({1})', [p.slug, lang])}
                    placeholder={ro ? '' : markdoc ? PLACEHOLDERS.page : tr('# Markdown')}
                  />
                </fieldset>
              )}
            </div>
          );
        })}
        {pages.length > 0 && <Pager paging={paging} total={paging.total} />}
      </div>
    </div>
  );
}

function PagesSection({ draft, set, ro, L }) {
  const markdoc = draft.mode === 'templates';
  const list = <PortalPages pages={draft.pages || []} onChange={set('pages')} L={L} ro={ro} markdoc={markdoc} />;
  if (!markdoc) return list;
  return (
    <div className="col gap-16">
      <Callout kind="info">{tr('In the templates mode, the content of a page is Markdoc: markdown, and the components of the portal as tags — they are listed beside.')}</Callout>
      <div className="editor-help">
        {list}
        <TagsHelp scope="page" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- templates

function TemplatesSection({ draft, set, ro, L, goDesign }) {
  if (draft.mode !== 'templates') {
    return (
      <Callout kind="info" title={tr('The templates are those of the templates mode')}>
        <div className="row">
          <span className="grow">{tr('This portal is in the {0} mode: its templates are kept, and not used.', [modeLabel(draft.mode)])}</span>
          <button className="btn sm" onClick={goDesign}>
            {tr('Change the mode')}
          </button>
        </div>
      </Callout>
    );
  }
  return (
    <div className="col gap-16">
      <p className="muted small" style={{ margin: 0 }}>
        {tr('The template of the home is on the tab Home, the pages on the tab Pages. The pages of subscribing, of the applications, of the usage and of signing in stay those of the product, themed.')}
      </p>
      <div className="editor-help">
        <TemplateEditor
          name="api"
          title={tr('Overview of an api ({0})', [L.lang])}
          help={tr('The first tab of the page of every api, in Markdoc; the variables $api.* are those of the api shown. Empty, the overview of the product.')}
          value={draft.templates?.api}
          onChange={(v) => set('templates')((t) => ({ ...t, api: v }))}
          ro={ro}
          L={L}
        />
        <TagsHelp scope="api" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- navigation

function LinksEditor({ title, help, links, onChange, ro, L }) {
  const update = (i, patch) => onChange(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i, d) => {
    const next = [...links];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">{title}</h3>
        <LangSeg L={L} missing={(l) => links.some((x) => lacks(x.label, l, L.def))} />
        {!ro && (
          <button className="btn sm" disabled={links.length >= 20} onClick={() => onChange([...links, { label: {}, href: '' }])}>
            <Icon name="plus" /> {tr('Add a link')}
          </button>
        )}
      </div>
      <div className="card-body col gap-8">
        <p className="muted small" style={{ margin: 0 }}>
          {help}
        </p>
        {!links.length && <span className="faint small">{tr('No link.')}</span>}
        {links.map((l, i) => (
          <div key={i} className="row">
            <span className="faint mono small">{i + 1}</span>
            <Input
              value={loc(l.label, L.def)[L.lang] || ''}
              onChange={(v) => update(i, { label: withText(l.label, L.lang, v, L.def) })}
              placeholder={L.lang !== L.def && loc(l.label, L.def)[L.def] ? loc(l.label, L.def)[L.def] : tr('label ({0})', [L.lang])}
              disabled={ro}
              aria-label={tr('label of link {0} ({1})', [i + 1, L.lang])}
              style={{ maxWidth: 260 }}
            />
            <Input value={l.href} onChange={(v) => update(i, { href: v.trim() })} mono list="portal-links" placeholder={tr('https://…, /path, #anchor or page:<slug>')} disabled={ro} aria-label={tr('target of link {0}', [i + 1])} />
            {!ro && (
              <>
                <button className="btn ghost sm icon" aria-label={tr('move up')} disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="chevronUp" size={14} />
                </button>
                <button className="btn ghost sm icon" aria-label={tr('move down')} disabled={i === links.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="chevronDown" size={14} />
                </button>
                <button className="btn ghost sm icon" aria-label={tr('remove the link')} onClick={() => onChange(links.filter((_, j) => j !== i))}>
                  <Icon name="trash" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function NavigationSection({ draft, set, ro, L }) {
  const nav = draft.navigation || {};
  const setList = (k) => (list) => set('navigation')((n) => ({ ...n, [k]: list }));
  return (
    <div className="col gap-16">
      <p className="muted small" style={{ margin: 0 }}>
        {tr('Links of your own, after those of the portal; 20 at most in each place. A link is an http(s) or mailto url, a path of the portal (/…), an anchor (#…) or a page of the design (page:<slug>).')}
      </p>
      <datalist id="portal-links">
        {(draft.pages || []).map((p) => (
          <option key={p.slug} value={`page:${p.slug}`} />
        ))}
      </datalist>
      <LinksEditor title={tr('Header')} help={tr('in the bar at the top of every page, after the pages of the design')} links={nav.header || []} onChange={setList('header')} ro={ro} L={L} />
      <LinksEditor title={tr('Footer')} help={tr('at the bottom of every page')} links={nav.footer || []} onChange={setList('footer')} ro={ro} L={L} />
    </div>
  );
}

// ---------------------------------------------------------------- styles & scripts

function AllowScriptsModal({ warning, onClose, onDone }) {
  const { wapi } = useWs();
  const toast = useToast();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    try {
      await wapi.put('/portal/scripts', { enabled: true, acknowledge: true });
      toast(tr('Scripts allowed on the portal'));
      onDone();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tr('Allow scripts on this portal?')}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn danger solid" disabled={!understood || busy} onClick={allow}>
            <Icon name="alert" /> {tr('Allow scripts')}
          </button>
        </>
      }
    >
      <div className="danger-warning" role="alert">
        <Icon name="alert" size={30} strokeWidth={2.2} />
        <div className="col gap-8">
          <span className="danger-title">{tr('Danger: a script acts as each of your consumers')}</span>
          <span>{warning ? tr(warning) : tr('A script of the design runs in the portal, in the session of every consumer who opens it.')}</span>
        </div>
      </div>
      <label className="checkbox danger-check">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        <span>{tr('I understand: the script runs in the session of every consumer')}</span>
      </label>
      <p className="muted small" style={{ margin: 0 }}>
        {tr('Allowing them is recorded in the audit trail, with your name; forbidding them again is immediate.')}
      </p>
    </Modal>
  );
}

function StylesSection({ draft, set, ro, data, reloadDesign }) {
  const { wapi, slug, isAdmin } = useWs();
  const toast = useToast();
  const scripts = useLoad(() => wapi.get('/portal/scripts'), [slug]);
  const [asking, setAsking] = useState(false);
  const s = scripts.data || data.scripts;
  const forbid = async () => {
    try {
      await wapi.put('/portal/scripts', { enabled: false });
      toast(tr('Scripts forbidden on the portal'));
      scripts.reload();
      reloadDesign();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="col gap-16">
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{tr('Style sheet')}</h3>
          {draft.mode === 'default' && <Badge kind="warning">{tr('not applied in the default mode')}</Badge>}
        </div>
        <div className="card-body col gap-12">
          <p className="muted small" style={{ margin: 0 }}>
            {tr('Added after the styles of the portal, in the themed and templates modes. An asset of the design is reached by its url, copied from the tab Assets.')}
          </p>
          <CodeEditor value={draft.css || ''} onChange={set('css')} readOnly={ro} language="css" minHeight={220} maxHeight={640} ariaLabel={tr('style sheet of the portal')} placeholder={ro ? '' : PLACEHOLDERS.css} />
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{tr('Script')}</h3>
          {s.enabled ? <Badge kind="negative" dot>{tr('scripts allowed')}</Badge> : <Badge dot>{tr('scripts not allowed')}</Badge>}
        </div>
        <div className="card-body col gap-12">
          <Setting label={tr('Allow scripts on this portal')} help={tr('Off by default. A script runs in the session of every consumer who opens the portal: allowing it is an act of its own, of an administrator, in the audit trail.')}>
            <Switch checked={s.enabled} disabled={!isAdmin} onChange={(v) => (v ? setAsking(true) : forbid())} label={s.enabled ? tr('Allowed') : tr('Not allowed')} />
            {s.enabled && (
              <span className="small muted">
                <Tr text={'Allowed by {0}, {1}'} args={[<b>{s.by || '—'}</b>, s.at ? fmtDate(s.at) : '—']} />
              </span>
            )}
            {!isAdmin && <span className="faint small">{tr('The administrators of the workspace allow scripts.')}</span>}
          </Setting>
          {draft.script && !s.enabled && <Callout kind="warning">{tr('The design has a script, kept but not served: scripts are not allowed on this portal.')}</Callout>}
          <p className="muted small" style={{ margin: 0 }}>
            {tr('The script of the design, served by the portal itself and loaded on every page — in every mode, once scripts are allowed.')}
          </p>
          <CodeEditor value={draft.script || ''} onChange={set('script')} readOnly={ro} language="javascript" minHeight={200} maxHeight={640} ariaLabel={tr('script of the portal')} placeholder={ro ? '' : PLACEHOLDERS.script} />
        </div>
      </div>
      {asking && (
        <AllowScriptsModal
          warning={scripts.data?.warning}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            scripts.reload();
            reloadDesign();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- assets

const readBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

// the sizes of the assets are not in the draft: read once per digest (a digest never changes)

function AssetsSection({ data, ro, write, base }) {
  const { wapi } = useWs();
  const toast = useToast();
  const confirm = useConfirm();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const assets = data.draft.assets || {};
  // the type and size of each asset, as the server knows them
  const known = new Map((data.assets || []).map((a) => [a.hash, a.size]));
  const list = useMemo(() => Object.entries(assets).map(([path, hash]) => ({ path, hash, type: typeOf(path) })).sort((a, b) => a.path.localeCompare(b.path)), [stable(assets)]);
  const paging = useLocalPaging(list, { prefix: 'assets', size: 10, text: (a) => `${a.path} ${a.type} ${a.hash}` });
  const url = (a) => (base ? `${base}/_design/assets/${a.hash}` : '');
  const upload = async (files) => {
    setBusy(true);
    const added = {};
    for (const file of files) {
      const name = file.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!ASSET_TYPES[name.split('.').pop().toLowerCase()]) {
        toast(tr('{0}: an asset is an image, a font or a style sheet ({1})', [file.name, Object.keys(ASSET_TYPES).join(', ')]), 'error');
        continue;
      }
      if (file.size > ASSET_MAX) {
        toast(tr('{0}: an asset is 2 MB at most', [file.name]), 'error');
        continue;
      }
      try {
        const r = await wapi.post('/portal/assets', { path: `assets/${name}`, data: await readBase64(file) });
        added[r.path] = r.hash;
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    }
    const n = Object.keys(added).length;
    if (n) {
      try {
        await write({ assets: { ...assets, ...added } });
        toast(tr('{0} asset(s) in the draft', [n]));
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    }
    setBusy(false);
  };
  const remove = async (a) => {
    const theme = data.draft.theme || {};
    const used = [theme.logo === a.path && tr('the logo'), theme.favicon === a.path && tr('the favicon')].filter(Boolean);
    if (used.length) {
      toast(tr('{0} is {1} of the theme: choose another one first, on the tab Design', [a.path, used.join(', ')]), 'error');
      return;
    }
    if (!(await confirm({ title: tr('Remove {0} from the design?', [a.path]), message: tr('The draft no longer holds it; the versions published with it keep it.'), confirmLabel: tr('Remove'), danger: true }))) return;
    const { [a.path]: _, ...rest } = assets;
    try {
      await write({ assets: rest });
      toast(tr('{0} removed from the draft', [a.path]));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="col gap-16">
      <div className="row">
        <p className="muted small grow" style={{ margin: 0 }}>
          {tr('The images, fonts and style sheets of the design — 2 MB each, never a script. An upload goes into the draft at once; the portal serves each file by its digest.')}
        </p>
        {!ro && (
          <>
            <input
              ref={input}
              type="file"
              hidden
              multiple
              accept={Object.keys(ASSET_TYPES).map((e) => `.${e}`).join(',')}
              onChange={(e) => {
                const files = [...(e.target.files || [])];
                e.target.value = '';
                if (files.length) upload(files);
              }}
            />
            <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>
              <Icon name="upload" /> {busy ? tr('Uploading…') : tr('Upload files')}
            </button>
          </>
        )}
      </div>
      <ListToolbar paging={paging} placeholder={tr('search paths, types')} />
      {paging.items.length ? (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 64 }} />
                  <th>{tr('Path')}</th>
                  <th>{tr('Type')}</th>
                  <th>{tr('Size')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {paging.items.map((a) => (
                  <tr key={a.path}>
                    <td>
                      {isImage(a.path) && url(a) ? (
                        <img className="asset-thumb" src={url(a)} alt="" loading="lazy" />
                      ) : (
                        <span className="asset-thumb" aria-hidden="true">
                          <Icon name="doc" />
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="mono small">{a.path}</div>
                      <div className="faint tiny mono ellipsis" title={a.hash}>
                        {a.hash.slice(0, 16)}…
                      </div>
                    </td>
                    <td className="small">{a.type || '—'}</td>
                    <td className="small nowrap">{known.get(a.hash) ? fmtBytes(known.get(a.hash)) : '—'}</td>
                    <td className="actions nowrap">
                      <CopyButton text={a.path} label={tr('Reference')} className="btn ghost sm" />
                      {url(a) && <CopyButton text={url(a)} label={tr('Url')} className="btn ghost sm" />}
                      {url(a) && (
                        <a className="btn ghost sm icon" href={url(a)} target="_blank" rel="noreferrer" aria-label={tr('open {0}', [a.path])}>
                          <Icon name="external" />
                        </a>
                      )}
                      {!ro && (
                        <button className="btn ghost sm icon" aria-label={tr('remove {0} from the design', [a.path])} onClick={() => remove(a)}>
                          <Icon name="trash" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager paging={paging} total={paging.total} />
        </div>
      ) : (
        <div className="card">
          <Empty title={paging.q ? tr('No asset matches') : tr('No asset yet')} icon="upload">
            {!paging.q && tr('A logo, a favicon, a font: upload them here, then pick them in the theme or reference them in the style sheet.')}
          </Empty>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- versions

function VersionModal({ n, onClose }) {
  const { wapi } = useWs();
  const state = useLoad(() => wapi.get(`/portal/versions/${n}`), [n]);
  return (
    <Modal title={tr('Version #{0} of the design', [n])} size="wide" onClose={onClose}>
      <Loader state={state}>
        {(v) => (
          <>
            <div className="small muted">
              {fmtDate(v.published_at)} · {modeLabel(v.design?.mode)}
              {v.comment ? ` — ${v.comment}` : ''}
            </div>
            <CodeView value={v.design} maxHeight={520} ariaLabel={tr('design of version {0}', [n])} />
          </>
        )}
      </Loader>
    </Modal>
  );
}

function VersionsSection({ data, ro, dirty, onRestored }) {
  const { wapi, slug } = useWs();
  const toast = useToast();
  const confirm = useConfirm();
  const paging = usePaging({ prefix: 'versions', size: 25 });
  const state = useLoad(() => wapi.get(`/portal/versions?${paging.query}`), [slug, paging.key, data.versions]);
  const [viewing, setViewing] = useState(null);
  const restore = async (v) => {
    const ok = await confirm({
      title: tr('Restore version #{0} into the draft?', [v.number]),
      message: tr('The draft becomes this version, its changes since lost. The portal keeps showing the published version until you publish the draft: that is the rollback.'),
      confirmLabel: tr('Restore'),
    });
    if (!ok) return;
    try {
      const design = await wapi.post(`/portal/versions/${v.number}/restore`);
      toast(tr('Version #{0} restored into the draft: publish it to show it', [v.number]));
      onRestored(design);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="col gap-12">
      <p className="muted small" style={{ margin: 0 }}>
        {tr('Each publication is an immutable version; the portal shows the last one. Restoring a version brings it back into the draft: publishing it is the rollback.')}
      </p>
      <ListToolbar paging={paging} placeholder={tr('search versions, comments')} onReload={state.reload} loading={state.loading} />
      <Loader state={state}>
        {(p) =>
          p.items.length ? (
            <div className="card">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{tr('Version')}</th>
                      <th>{tr('Published')}</th>
                      <th>{tr('By')}</th>
                      <th>{tr('Mode')}</th>
                      <th>{tr('Comment')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {p.items.map((v) => (
                      <tr key={v.number}>
                        <td className="nowrap">
                          <span className="bold">{tr('#{0}', [v.number])}</span>{' '}
                          {v.number === data.published.number && (
                            <Badge kind="positive" dot>
                              {tr('on the portal')}
                            </Badge>
                          )}
                        </td>
                        <td className="small nowrap" title={fmtDate(v.published_at)}>
                          {fmtRelative(v.published_at)}
                        </td>
                        <td className="small">{v.published_by_email || '—'}</td>
                        <td>
                          <Badge>{modeLabel(v.mode)}</Badge>
                        </td>
                        <td className="small">{v.comment || <span className="faint">—</span>}</td>
                        <td className="actions nowrap">
                          <button className="btn ghost sm" onClick={() => setViewing(v.number)}>
                            <Icon name="eye" /> {tr('View')}
                          </button>
                          {!ro && (
                            <button className="btn ghost sm" disabled={dirty} title={dirty ? tr('save or discard the changes of the draft first') : tr('bring it back into the draft')} onClick={() => restore(v)}>
                              <Icon name="refresh" /> {tr('Restore')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager paging={paging} total={p.total} />
            </div>
          ) : (
            <div className="card">
              <Empty title={paging.q ? tr('No version matches') : tr('No version yet')} icon="layers">
                {!paging.q && tr('Publish the draft: its first version is what the portal shows.')}
              </Empty>
            </div>
          )
        }
      </Loader>
      {viewing && <VersionModal n={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- sync: the design as files

function SyncSection() {
  const { wapi, slug, isAdmin } = useWs();
  const toast = useToast();
  const download = async () => {
    try {
      const doc = await wapi.get('/portal/document');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([YAML.stringify(doc)], { type: 'application/yaml' }));
      a.download = 'portal.yaml';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const files = [
    ['portal.yaml', tr('the design — mode, texts, theme, navigation, blocks — naming the files beside it')],
    ['home.<lang>.md', tr('the markdown of the home, per language')],
    ['home/block-<n>.<lang>.md', tr('the markdown blocks of the home')],
    ['pages/<slug>.<lang>.md', tr('the free pages')],
    ['templates/<name>.<lang>.md', tr('the templates: home, api')],
    ['styles.css', tr('the style sheet')],
    ['script.js', tr('the script — served only where scripts are allowed')],
    ['assets/', tr('the images, fonts and style sheets')],
  ];
  return (
    <div className="col gap-16">
      <div className="card">
        <div className="card-head">
          <Icon name="git" />
          <h3 className="grow">{tr('Work from files')}</h3>
        </div>
        <div className="card-body col gap-12">
          <p className="muted small" style={{ margin: 0 }}>
            {tr('The design can live in a folder, under version control and edited with your own tools: the cli writes the draft into files, and pushes the files back into the draft.')}
          </p>
          <div className="label">{tr('The draft into the folder portal')}</div>
          <Code lang="sh">{`apim portal pull ${slug} portal`}</Code>
          <div className="label">{tr('The folder into the draft, again on every change — with a preview link')}</div>
          <Code lang="sh">{`apim portal push ${slug} portal --watch`}</Code>
          <div className="label">{tr('The folder into the draft, and a version of it')}</div>
          <Code lang="sh">{`apim portal push ${slug} portal --publish --comment "…"`}</Code>
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <Icon name="doc" />
            <h3>{tr('The folder')}</h3>
          </div>
          <div className="card-body">
            <dl className="kv" style={{ fontVariantLigatures: 'none' }}>
              {files.map(([f, what]) => (
                <React.Fragment key={f}>
                  <dt className="mono small">{f}</dt>
                  <dd className="small">{what}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        </div>
        <div className="col gap-16">
          <div className="card">
            <div className="card-head">
              <Icon name="refresh" />
              <h3>{tr('From a remote catalog')}</h3>
            </div>
            <div className="card-body col gap-12">
              <p className="muted small" style={{ margin: 0 }}>
                {tr('A remote catalog — a git repository, an http file, an object store — can hold the same folder beside its apis. Its sync applies the design, and publishes it unless the catalog only writes drafts; the design is then managed by the catalog, read only here.')}
              </p>
              {isAdmin && (
                <Link className="btn sm" to={`/ws/${slug}/settings/catalogs`} style={{ alignSelf: 'flex-start' }}>
                  {tr('Workspace settings › Catalogs')}
                </Link>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <Icon name="download" />
              <h3>{tr('The declarative document')}</h3>
            </div>
            <div className="card-body col gap-12">
              <p className="muted small" style={{ margin: 0 }}>
                {tr('The draft as one document of kind Portal: its texts inline, its assets named by their digest.')}
              </p>
              <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={download}>
                <Icon name="download" /> {tr('Download portal.yaml')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the page

const SECTIONS = ['overview', 'settings', 'design', 'home', 'pages', 'templates', 'navigation', 'styles', 'assets', 'versions', 'sync'];

export function PortalPage({ section = 'overview' }) {
  const { wapi, slug } = useWs();
  const state = useLoad(() => wapi.get('/portal/design'), [slug]);
  return (
    <div className="page">
      <Loader state={state}>{(data) => <PortalEditor key={slug} data={data} state={state} section={SECTIONS.includes(section) ? section : 'overview'} />}</Loader>
    </div>
  );
}

function PortalEditor({ data, state, section }) {
  const { wapi, slug, ws, isAdmin } = useWs();
  const { navigate } = useRouter();
  const toast = useToast();
  const L = usePortalLanguages();
  const [draft, setDraftState] = useState(data.draft);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // the draft as the server holds it moves (a save, an upload, a restore): what is not edited here
  // follows it, what is edited stays
  const base = useRef(data.draft);
  useEffect(() => {
    const prev = base.current;
    base.current = data.draft;
    setDraftState((local) => Object.fromEntries(Object.keys({ ...data.draft, ...local }).map((k) => [k, same(local[k], prev[k]) ? data.draft[k] : local[k]])));
  }, [data.draft]);
  const dirtyKeys = Object.keys(draft).filter((k) => !same(draft[k], data.draft[k]));
  const dirty = dirtyKeys.length > 0;
  const managed = data.managedBy;
  const ro = !isAdmin || !!managed;
  const portalBase = String(ws.portal_url || '').replace(/\/$/, '');
  const set = (k) => (v) => setDraftState((d) => ({ ...d, [k]: typeof v === 'function' ? v(d[k]) : v }));

  useEffect(() => {
    const on = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, [dirty]);

  // a part of the draft written: the server merges it, checks it, and answers the whole draft
  const write = async (patch) => {
    const next = await wapi.put('/portal/design', patch);
    setDraftState((d) => ({ ...d, ...pick(next, Object.keys(patch)) }));
    state.setData({ ...data, draft: next });
    state.reload();
    return next;
  };
  const save = async () => {
    setSaving(true);
    try {
      await write(pick(draft, dirtyKeys));
      toast(tr('Draft of the design saved — the portal shows the published version'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };
  const preview = async () => {
    // the tab opened at the click, so that no popup blocker stands in the way
    const tab = window.open('', '_blank');
    try {
      const r = await wapi.post('/portal/preview');
      if (tab) {
        tab.opener = null;
        tab.location.href = r.url;
      } else window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      tab?.close();
      toast(errorMessage(e), 'error');
    }
  };
  const go = (id) => navigate(`/ws/${slug}/portal${id === 'overview' ? '' : `/${id}`}`);
  const canPublishNow = !(data.published.number > 0 && !data.changes.length);
  const parts = partLabels();
  const categories = ws.portal?.categories || [];

  const tabs = [
    { id: 'overview', label: tr('Overview') },
    { id: 'settings', label: tr('Settings') },
    { id: 'design', label: tr('Design') },
    { id: 'home', label: tr('Home') },
    { id: 'pages', label: tr('Pages'), count: (draft.pages || []).length },
    ...(draft.mode === 'templates' || section === 'templates' ? [{ id: 'templates', label: tr('Templates') }] : []),
    { id: 'navigation', label: tr('Navigation') },
    { id: 'styles', label: tr('Styles & scripts') },
    { id: 'assets', label: tr('Assets'), count: Object.keys(draft.assets || {}).length },
    { id: 'versions', label: tr('Versions'), count: data.versions },
    { id: 'sync', label: tr('Sync') },
  ];
  const props = { draft, set, ro, L };

  return (
    <>
      <PageHead
        title={tr('Developer portal')}
        sub={
          ws.portal_url ? (
            <a className="link mono small" href={ws.portal_url} target="_blank" rel="noreferrer">
              {ws.portal_url}
            </a>
          ) : (
            ws.name
          )
        }
        actions={
          <>
            {ws.portal_url && (
              <a className="btn" href={ws.portal_url} target="_blank" rel="noreferrer">
                {tr('Open the portal ↗')}
              </a>
            )}
            <button className="btn" onClick={preview} disabled={dirty} title={dirty ? tr('save the draft first') : tr('the portal showing the draft, for an hour')}>
              <Icon name="eye" /> {tr('Preview the draft')}
            </button>
            {isAdmin && (
              <button className="btn primary" onClick={() => setPublishing(true)} disabled={dirty || !canPublishNow} title={dirty ? tr('save the draft first') : !canPublishNow ? tr('nothing to publish: the draft is the published version') : ''}>
                <Icon name="upload" /> {tr('Publish')}
              </button>
            )}
          </>
        }
      />
      {managed && (
        <div className="mb-16">
          <Callout kind="info" title={tr('Managed by {0}', [managed.startsWith('catalog:') ? tr('a remote catalog') : managed])}>
            {tr('The design of this portal has its source elsewhere — the cli or a remote catalog: edit it at its source, the next push or sync brings it here. Publishing and allowing scripts stay operable from the console.')}
          </Callout>
        </div>
      )}
      {!isAdmin && (
        <div className="mb-16">
          <Callout kind="info">{tr('Read only: the administrators of the workspace design the portal and publish it.')}</Callout>
        </div>
      )}
      <div className="mb-16">
        <Tabs tabs={tabs} value={section} onChange={go} />
      </div>
      {section === 'overview' && <Overview data={data} dirty={dirty} canPublish={isAdmin} onPublish={() => setPublishing(true)} onPreview={preview} />}
      {section === 'settings' && <LiveSettings />}
      {section === 'design' && <DesignSection {...props} base={portalBase} />}
      {section === 'home' && <HomeSection {...props} categories={categories} goDesign={() => go('design')} />}
      {section === 'pages' && <PagesSection {...props} />}
      {section === 'templates' && <TemplatesSection {...props} goDesign={() => go('design')} />}
      {section === 'navigation' && <NavigationSection {...props} />}
      {section === 'styles' && <StylesSection {...props} data={data} reloadDesign={state.reload} />}
      {section === 'assets' && <AssetsSection data={data} ro={ro} write={write} base={portalBase} />}
      {section === 'versions' && (
        <VersionsSection
          data={data}
          ro={ro}
          dirty={dirty}
          onRestored={(design) => {
            setDraftState(design);
            state.setData({ ...data, draft: design });
            state.reload();
          }}
        />
      )}
      {section === 'sync' && <SyncSection />}

      {dirty && !ro && (
        <div className="savebar" role="region" aria-label={tr('unsaved changes')}>
          <Icon name="edit" />
          <span className="grow">
            <Tr text={'Unsaved changes to the draft of the design: {0}.'} args={[dirtyKeys.map((k) => parts[k] || k).join(', ')]} />
          </span>
          <button className="btn sm" onClick={() => setDraftState(data.draft)}>
            {tr('Discard')}
          </button>
          <button className="btn primary sm" disabled={saving} onClick={save}>
            {saving ? tr('Saving…') : tr('Save draft')}
          </button>
        </div>
      )}
      {publishing && (
        <PublishModal
          data={data}
          onClose={() => setPublishing(false)}
          onDone={() => {
            setPublishing(false);
            state.reload();
          }}
        />
      )}
    </>
  );
}
