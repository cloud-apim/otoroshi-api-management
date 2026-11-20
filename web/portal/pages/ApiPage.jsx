import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link, useQuery, useRouter } from '../../shared/router.jsx';
import { Badge, Callout, Code, CopyButton, Empty, ErrorBox, Icon, Loader, Loading, Markdown, Seg, Select, useLoad } from '../../shared/ui.jsx';
import { api, usePortal } from '../context.jsx';
import { pickLang, useI18n } from '../i18n.jsx';
import { LifecycleBadge, authLabel, priceLabel, quotaLabel, rateLabel, snippets } from '../common.jsx';
import { SubscribeModal } from './Subscribe.jsx';
import { Reviews } from './Reviews.jsx';
import { Events } from './AsyncApi.jsx';
import { Stars } from '../../shared/stars.jsx';
import { RequestComposer } from '../../shared/composer.jsx';

const ApiReference = lazy(() => import('./ApiReference.jsx'));

const LANG_NAMES = { en: 'English', fr: 'Français', de: 'Deutsch', es: 'Español', it: 'Italiano', nl: 'Nederlands', pt: 'Português' };

export function ApiPage({ id, tab, page }) {
  const { user } = usePortal();
  const state = useLoad(() => api.get(`/apis/${id}`), [id, user?.id]);
  const { t } = useI18n();
  if (state.error?.status === 404)
    return (
      <div className="pt-container pt-section">
        <div className="card">
          <Empty title={t('api.notFound')} action={<Link to="/apis" className="btn">{t('nav.apis')}</Link>} />
        </div>
      </div>
    );
  return (
    <Loader state={state}>
      {(a) => <ApiView a={a} tab={tab} page={page} />}
    </Loader>
  );
}

function ApiView({ a, tab, page }) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const base = `/apis/${a.id}`;
  const suffix = tab === 'overview' ? '' : `/${tab}`;
  const tabs = [
    { id: 'overview', label: t('api.tab.overview'), to: base },
    { id: 'docs', label: t('api.tab.docs'), to: `${base}/docs` },
    // the reference of an api with its specification lets one try it (Scalar); the composer otherwise
    ...(a.has_openapi ? [{ id: 'reference', label: t('api.tab.reference'), to: `${base}/reference` }] : [{ id: 'try', label: t('api.tab.try'), to: `${base}/try` }]),
    ...(a.has_asyncapi ? [{ id: 'events', label: t('api.tab.events'), to: `${base}/events` }] : []),
    { id: 'plans', label: t('api.tab.plans'), to: `${base}/plans`, count: a.plans.length },
    ...(a.rating !== undefined ? [{ id: 'reviews', label: t('api.tab.reviews'), to: `${base}/reviews`, count: a.rating?.count || 0 }] : []),
  ];
  return (
    <>
      <div className="pt-api-head">
        <div className="pt-container">
          <Link to="/apis" className="link small row gap-4" style={{ display: 'inline-flex', marginBottom: 12 }}>
            <Icon name="arrowLeft" size={14} />
            {t('catalogue.title')}
          </Link>
          <div className="row top wrap gap-16">
            <span className="pt-api-icon lg" aria-hidden="true">
              {a.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="grow">
              <div className="row wrap gap-6">
                <h1>{a.name}</h1>
                <LifecycleBadge lifecycle={a.lifecycle} />
              </div>
              <p className="muted mt-8" style={{ maxWidth: 760 }}>
                {a.description}
              </p>
              {(a.rating || a.usage?.applications > 0) && (
                <div className="row wrap gap-8 mt-8 small">
                  {a.rating && (
                    <Link to={`${base}/reviews`} className="row gap-4 link">
                      <Stars value={a.rating.average} label={t('reviews.rating', { n: a.rating.average })} />
                      <span>{a.rating.count === 1 ? t('reviews.one') : t('reviews.count', { n: a.rating.count })}</span>
                    </Link>
                  )}
                  {a.usage?.applications > 0 && <span className="muted">{a.usage.applications === 1 ? t('catalogue.app') : t('catalogue.apps', { n: a.usage.applications })}</span>}
                  {a.usage?.calls_30d > 0 && <span className="muted">{t('catalogue.calls', { n: a.usage.calls_30d.toLocaleString() })}</span>}
                </div>
              )}
              <div className="row wrap gap-6 mt-8">
                {(a.tags || []).map((x) => (
                  <Link key={x} to={`/apis?tag=${encodeURIComponent(x)}`} className="tag">
                    {x}
                  </Link>
                ))}
              </div>
            </div>
            <div className="row gap-6">
              <label className="small muted" htmlFor="api-version">
                {t('api.version')}
              </label>
              <select id="api-version" className="select" style={{ width: 'auto', minWidth: 110 }} value={a.id} onChange={(e) => navigate(`/apis/${e.target.value}${suffix}`)}>
                {(a.versions || [{ id: a.id, version: a.version }]).map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}
                    {v.lifecycle === 'deprecated' ? ` (${t('lifecycle.deprecated').toLowerCase()})` : ''}
                  </option>
                ))}
              </select>
              <Link to={`${base}/plans`} className="btn primary">
                {t('api.seePlans')}
              </Link>
            </div>
          </div>
          <nav className="tabs mt-24" aria-label="api sections">
            {tabs.map((x) => (
              <Link key={x.id} to={x.to} className={tab === x.id ? 'on' : ''} aria-current={tab === x.id ? 'page' : undefined}>
                {x.label}
                {x.count !== undefined && <span className="count">{x.count}</span>}
              </Link>
            ))}
          </nav>
        </div>
      </div>
      <div className="pt-container pt-section">
        {a.lifecycle === 'deprecated' && (
          <div className="mb-16">
            <Callout kind="warning">{t('api.deprecated')}</Callout>
          </div>
        )}
        {tab === 'overview' && <Overview a={a} />}
        {tab === 'docs' && <Docs a={a} page={page} />}
        {tab === 'reference' && <Reference a={a} />}
        {tab === 'try' && <Try a={a} />}
        {tab === 'plans' && <Plans a={a} />}
        {tab === 'reviews' && <Reviews a={a} />}
        {tab === 'events' && <Events a={a} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ a }) {
  const { t } = useI18n();
  const { user } = usePortal();
  const kinds = [...new Set(a.plans.map((p) => p.auth_kind))];
  const [kind, setKind] = useState(kinds[0] || 'apikey');
  const [lang, setLang] = useState('curl');
  const [appId, setAppId] = useState('');
  const [creds, setCreds] = useState(null);
  const [credsMissing, setCredsMissing] = useState(false);
  const apps = useLoad(() => (user ? api.get('/applications') : Promise.resolve([])), [user?.id]);
  const spec = useLoad(() => (a.has_openapi ? api.get(`/apis/${a.id}/openapi`).catch(() => null) : Promise.resolve(null)), [a.id]);
  const sample = useMemo(() => {
    const paths = Object.entries(spec.data?.paths || {});
    const first = paths.find(([p, ops]) => ops.get && !p.includes('{')) || paths[0];
    if (first) return { path: first[0], method: first[1].get ? 'GET' : Object.keys(first[1])[0] };
    const res = a.resources.find((r) => r.path && r.path !== '/');
    return { path: res ? res.path : '/', method: res?.methods?.[0] || 'GET' };
  }, [spec.data, a]);
  useEffect(() => {
    if (!appId) {
      setCreds(null);
      setCredsMissing(false);
      return;
    }
    api
      .get(`/applications/${appId}`)
      .then((app) => {
        const sub = (app.subscriptions || []).find((s) => s.api_id === a.id && s.status === 'active' && (s.credentials || []).some((c) => c.status === 'active'));
        const c = sub?.credentials?.find((x) => x.status === 'active');
        if (c) {
          setCreds({ clientId: c.client_id, clientSecret: c.client_secret });
          setCredsMissing(false);
          if (['apikey', 'oauth2-local'].includes(sub.auth_kind)) setKind(sub.auth_kind);
        } else {
          setCreds(null);
          setCredsMissing(true);
        }
      })
      .catch(() => setCreds(null));
  }, [appId, a.id]);
  const url = `${a.base_url}${sample.path === '/' ? '/' : sample.path}`;
  const code = snippets({ kind, url, method: sample.method, ...(creds || {}) });
  return (
    <div className="pt-two-col">
      <div className="col gap-24">
        <div className="card">
          <div className="card-head">
            <h3 className="grow">{t('api.howto')}</h3>
          </div>
          <div className="card-body col gap-16">
            <div>
              <div className="label mb-8">{t('api.baseUrl')}</div>
              <div className="row gap-6">
                <code className="pt-url grow">{a.base_url}</code>
                <CopyButton text={a.base_url} />
              </div>
            </div>
            <ol className="pt-howto">
              <li>
                <Link to={`/apis/${a.id}/plans`} className="link">
                  {t('api.howto.1')}
                </Link>
              </li>
              <li>{t('api.howto.2')}</li>
              <li>{t('api.howto.3')}</li>
            </ol>
            <div className="row wrap gap-6">
              {kinds.length > 1 && <Seg value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: authLabel(k) }))} />}
              <Seg
                value={lang}
                onChange={setLang}
                options={[
                  { value: 'curl', label: 'curl' },
                  { value: 'js', label: 'JavaScript' },
                  { value: 'python', label: 'Python' },
                ]}
              />
              <span className="spacer" />
              {user && (apps.data || []).length > 0 && (
                <label className="row gap-6 small">
                  <span className="muted">{t('api.howto.fill')}</span>
                  <select className="select" style={{ width: 'auto', minHeight: 30, padding: '4px 30px 4px 8px' }} value={appId} onChange={(e) => setAppId(e.target.value)}>
                    <option value="">{t('api.howto.placeholder')}</option>
                    {apps.data.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {credsMissing && <div className="muted small">{t('api.howto.nocreds')}</div>}
            <Code>{code[lang]}</Code>
          </div>
        </div>
      </div>
      <aside className="col gap-16">
        <div className="card">
          <div className="card-head">
            <h3>{t('api.resources')}</h3>
          </div>
          <div className="card-body col gap-6">
            {a.resources.map((r, i) => (
              <div key={i} className="row gap-6 small">
                <span className="tag mono">{r.methods?.length ? r.methods.join(' ') : t('api.allmethods')}</span>
                <code className="ellipsis">{r.path}</code>
                <span className="muted ellipsis grow">{r.name}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3 className="grow">{t('api.tab.plans')}</h3>
            <Link to={`/apis/${a.id}/plans`} className="link small">
              {t('api.seePlans')}
            </Link>
          </div>
          <div className="card-body col gap-6">
            {a.plans.map((p) => (
              <div key={p.id} className="row gap-6 small">
                <span className="bold grow ellipsis">{p.name}</span>
                <span className="tag">{authLabel(p.auth_kind)}</span>
              </div>
            ))}
            {!a.plans.length && <div className="muted small">{t('plan.none')}</div>}
          </div>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- documentation (n languages)

function orderPages(pages) {
  const byParent = {};
  pages.forEach((p) => (byParent[p.parent_id || ''] = [...(byParent[p.parent_id || ''] || []), p]));
  Object.values(byParent).forEach((l) => l.sort((x, y) => (x.position ?? 0) - (y.position ?? 0)));
  const out = [];
  const walk = (parent, depth) => (byParent[parent] || []).forEach((p) => {
    out.push({ ...p, depth });
    walk(p.id, depth + 1);
  });
  walk('', 0);
  // orphans (parent missing)
  pages.forEach((p) => !out.find((x) => x.id === p.id) && out.push({ ...p, depth: 0 }));
  return out;
}

function Docs({ a, page }) {
  const { t, lang } = useI18n();
  const pages = useMemo(() => orderPages(a.pages || []), [a.pages]);
  const languages = a.languages?.length ? a.languages : ['en'];
  const [docLang, setDocLang] = useState(languages.includes(lang) ? lang : a.default_language || languages[0]);
  useEffect(() => {
    if (languages.includes(lang)) setDocLang(lang);
  }, [lang]);
  const current = page || pages[0]?.slug;
  const state = useLoad(() => (current ? api.get(`/apis/${a.id}/pages/${current}`) : Promise.resolve(null)), [a.id, current]);
  if (!pages.length)
    return (
      <div className="card">
        <Empty title={t('api.noDocs')} icon="doc" />
      </div>
    );
  return (
    <div className="pt-docs">
      <nav className="pt-docs-nav" aria-label={t('api.tab.docs')}>
        {pages.map((p) => (
          <Link
            key={p.id}
            to={`/apis/${a.id}/docs/${p.slug}`}
            className={`pt-docs-link ${p.slug === current ? 'on' : ''}`}
            style={{ paddingLeft: 10 + p.depth * 14 }}
            aria-current={p.slug === current ? 'page' : undefined}
          >
            {pickLang(p.title, docLang, a.default_language) || p.slug}
          </Link>
        ))}
      </nav>
      <article className="card pt-docs-body">
        <div className="card-body">
          {languages.length > 1 && (
            <div className="row mb-16">
              <span className="spacer" />
              <label className="row gap-6 small muted">
                <Icon name="globe" size={14} />
                <span className="sr-only">{t('api.docLang')}</span>
                <select className="select" style={{ width: 'auto', minHeight: 30, padding: '4px 30px 4px 8px' }} value={docLang} onChange={(e) => setDocLang(e.target.value)} aria-label={t('api.docLang')}>
                  {languages.map((l) => (
                    <option key={l} value={l}>
                      {LANG_NAMES[l] || l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {state.loading && !state.data ? (
            <Loading />
          ) : state.error ? (
            <ErrorBox error={state.error} onRetry={state.reload} />
          ) : state.data ? (
            <DocPage page={state.data} docLang={docLang} fallback={a.default_language} />
          ) : null}
        </div>
      </article>
    </div>
  );
}

function DocPage({ page, docLang, fallback }) {
  const has = !!page.content?.[docLang];
  const shownLang = has ? docLang : page.content?.[fallback] ? fallback : Object.keys(page.content || {})[0];
  return (
    <>
      {!has && shownLang && (
        <div className="mb-16">
          <Badge kind="info">{`${LANG_NAMES[docLang] || docLang} → ${LANG_NAMES[shownLang] || shownLang}`}</Badge>
        </div>
      )}
      <div lang={shownLang}>
        <Markdown source={pickLang(page.content, docLang, fallback)} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- try (the composer shared with the console)

function Try({ a }) {
  const { t } = useI18n();
  const { user } = usePortal();
  const subs = useLoad(() => api.get(`/apis/${a.id}/my-subscriptions`), [a.id, user?.id]);
  return (
    <div className="col gap-16">
      <p className="muted small">{t('try.help')}</p>
      <Loader state={subs}>
        {(list) => (
          <RequestComposer
            baseLabel={a.base_url}
            paths={a.resources.map((r) => r.path)}
            credentials={list.map((s) => ({ value: s.id, label: `${s.application_name} — ${s.plan_name}` }))}
            labels={{ send: t('try.send'), credential: t('try.credentials'), none: t('try.none'), headers: t('try.headers'), body: t('try.body'), response: t('try.response') }}
            send={(r) => api.post(`/apis/${a.id}/test`, { method: r.method, path: r.path, query: r.query, headers: r.headers, body: r.body, subscription_id: r.credential || undefined })}
          />
        )}
      </Loader>
    </div>
  );
}

// ---------------------------------------------------------------- reference (Scalar)

function Reference({ a }) {
  const { t } = useI18n();
  const state = useLoad(() => api.get(`/apis/${a.id}/openapi`), [a.id]);
  if (state.error?.status === 404)
    return (
      <div className="card">
        <Empty title={t('api.noSpec')} icon="doc" />
      </div>
    );
  return (
    <Loader state={state}>
      {(spec) => (
        <Suspense fallback={<Loading />}>
          <ApiReference spec={spec} />
        </Suspense>
      )}
    </Loader>
  );
}

// ---------------------------------------------------------------- plans

export function PlanCard({ plan, onSubscribe, user }) {
  const { t, lang } = useI18n();
  return (
    <div className="card pt-plan">
      <div className="card-body col gap-16" style={{ height: '100%' }}>
        <div>
          <div className="row gap-6 wrap">
            <h3 className="grow">{plan.name}</h3>
            {plan.status === 'deprecated' && <Badge kind="warning">{t('lifecycle.deprecated')}</Badge>}
          </div>
          <div className="pt-price">{priceLabel(t, plan.pricing)}</div>
          {plan.description && <p className="muted small mt-8">{plan.description}</p>}
        </div>
        <dl className="pt-plan-facts">
          <div>
            <dt>{t('plan.auth')}</dt>
            <dd>{authLabel(plan.auth_kind)}</dd>
          </div>
          <div>
            <dt>{t('plan.rate')}</dt>
            <dd>{rateLabel(plan, t, lang)}</dd>
          </div>
          <div>
            <dt>{t('plan.daily')}</dt>
            <dd>{quotaLabel(plan.quota?.daily, t)}</dd>
          </div>
          <div>
            <dt>{t('plan.monthly')}</dt>
            <dd>{quotaLabel(plan.quota?.monthly, t)}</dd>
          </div>
          <div>
            <dt>{t('plan.resources')}</dt>
            <dd>
              {plan.resources ? (
                <span className="col gap-4">
                  {plan.resources.map((r, i) => (
                    <code key={i} className="small">
                      {r.methods?.length ? r.methods.join(',') + ' ' : ''}
                      {r.path}
                    </code>
                  ))}
                </span>
              ) : (
                t('plan.allResources')
              )}
            </dd>
          </div>
        </dl>
        <div className="row wrap gap-6">
          <Badge kind={plan.validation === 'manual' ? 'warning' : 'positive'} dot>
            {t(`plan.validation.${plan.validation === 'manual' ? 'manual' : 'auto'}`)}
          </Badge>
          {plan.terms && (
            <a className="badge info" href={plan.terms.url || '#'} target="_blank" rel="noreferrer">
              {t('plan.terms')}
            </a>
          )}
        </div>
        <div className="spacer" />
        {plan.subscribable ? (
          <button className="btn primary" onClick={() => onSubscribe(plan)}>
            {user ? t('api.subscribe') : t('api.signinToSubscribe')}
          </button>
        ) : (
          <button className="btn" disabled>
            {t('plan.closed')}
          </button>
        )}
      </div>
    </div>
  );
}

function Plans({ a }) {
  const { t } = useI18n();
  const { user } = usePortal();
  const { navigate, path } = useRouter();
  const [params, setParams] = useQuery();
  const wanted = params.get('subscribe');
  const [plan, setPlan] = useState(null);
  useEffect(() => {
    if (wanted && user) {
      const p = a.plans.find((x) => x.id === wanted);
      if (p) setPlan(p);
    }
  }, [wanted, user, a.plans]);
  const onSubscribe = (p) => {
    if (!user) {
      navigate(`/signin?next=${encodeURIComponent(`${path}?subscribe=${p.id}`)}`);
      return;
    }
    setPlan(p);
  };
  if (!a.plans.length)
    return (
      <div className="card">
        <Empty title={t('plan.none')} icon="layers" />
      </div>
    );
  return (
    <>
      <div className="pt-plans">
        {a.plans.map((p) => (
          <PlanCard key={p.id} plan={p} user={user} onSubscribe={onSubscribe} />
        ))}
      </div>
      <p className="muted small mt-16 row gap-6">
        <Icon name="info" size={14} />
        {t('plan.perCredential')}
      </p>
      {plan && (
        <SubscribeModal
          api={a}
          plan={plan}
          onClose={() => {
            setPlan(null);
            if (wanted) setParams({ subscribe: null });
          }}
        />
      )}
    </>
  );
}
