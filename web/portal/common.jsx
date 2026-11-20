import React, { useEffect } from 'react';
import { useRouter, Link } from '../shared/router.jsx';
import { Badge, Icon, Loading } from '../shared/ui.jsx';
import { AUTH_LABELS, fmtNumber } from '../shared/lib.js';
import { usePortal } from './context.jsx';
import { useI18n, windowLabel } from './i18n.jsx';

export function RequireUser({ children }) {
  const { user, loading } = usePortal();
  const { navigate, path, search } = useRouter();
  useEffect(() => {
    if (!loading && !user) navigate(`/signin?next=${encodeURIComponent(path + (search || ''))}`, { replace: true });
  }, [loading, user]);
  if (!user) return <Loading />;
  return children;
}

export function PageHeader({ title, subtitle, actions, back }) {
  return (
    <div className="pt-page-head">
      {back && (
        <Link to={back.to} className="link small row gap-4" style={{ display: 'inline-flex', marginBottom: 10 }}>
          <Icon name="arrowLeft" size={14} />
          {back.label}
        </Link>
      )}
      <div className="row top wrap gap-16">
        <div className="grow">
          <h1>{title}</h1>
          {subtitle && <p className="muted mt-8" style={{ maxWidth: 720 }}>{subtitle}</p>}
        </div>
        {actions && <div className="row gap-6">{actions}</div>}
      </div>
    </div>
  );
}

export function LifecycleBadge({ lifecycle }) {
  const { t } = useI18n();
  if (lifecycle === 'deprecated') return <Badge kind="warning" dot>{t('lifecycle.deprecated')}</Badge>;
  return null;
}

const SUB_KIND = { active: 'positive', pending: 'warning', pending_payment: 'warning', rejected: 'negative', suspended: 'warning', expired: 'warning', closed: '' };

export function SubStatus({ status }) {
  const { t } = useI18n();
  return (
    <Badge kind={SUB_KIND[status] ?? ''} dot>
      {t(`status.${status}`)}
    </Badge>
  );
}

export function authLabel(kind) {
  return AUTH_LABELS[kind] || kind;
}

export function rateLabel(plan, t, lang) {
  if (!plan.rate_limit) return t('plan.unlimited');
  return t('plan.per', { n: fmtNumber(plan.rate_limit.calls), w: windowLabel(plan.rate_limit.window_ms, lang) });
}

export function quotaLabel(v, t) {
  return v ? fmtNumber(v) : t('plan.unlimited');
}

// "how to call it" snippets, with the consumer's own credentials when available
export function snippets({ kind, url, clientId, clientSecret, method = 'GET' }) {
  const id = clientId || 'YOUR_CLIENT_ID';
  const secret = clientSecret || 'YOUR_CLIENT_SECRET';
  const m = method.toUpperCase();
  switch (kind) {
    case 'apikey':
    case 'oauth2-local':
      return {
        curl: `curl -X ${m} '${url}' \\\n  -u '${id}:${secret}'`,
        js: `const credentials = btoa('${id}:${secret}');\n\nconst res = await fetch('${url}', {\n  method: '${m}',\n  headers: { Authorization: \`Basic \${credentials}\` },\n});\nconsole.log(await res.json());`,
        python: `import requests\n\nres = requests.${m.toLowerCase()}(\n    '${url}',\n    auth=('${id}', '${secret}'),\n)\nprint(res.json())`,
      };
    case 'jwt':
    case 'oauth2-remote':
      return {
        curl: `curl -X ${m} '${url}' \\\n  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'`,
        js: `const res = await fetch('${url}', {\n  method: '${m}',\n  headers: { Authorization: 'Bearer YOUR_ACCESS_TOKEN' },\n});\nconsole.log(await res.json());`,
        python: `import requests\n\nres = requests.${m.toLowerCase()}(\n    '${url}',\n    headers={'Authorization': 'Bearer YOUR_ACCESS_TOKEN'},\n)\nprint(res.json())`,
      };
    case 'mtls':
      return {
        curl: `curl -X ${m} '${url}' \\\n  --cert client.pem --key client.key`,
        js: `// node.js\nimport https from 'node:https';\nimport fs from 'node:fs';\n\nconst agent = new https.Agent({\n  cert: fs.readFileSync('client.pem'),\n  key: fs.readFileSync('client.key'),\n});\nconst res = await fetch('${url}', { method: '${m}', dispatcher: agent });\nconsole.log(await res.json());`,
        python: `import requests\n\nres = requests.${m.toLowerCase()}(\n    '${url}',\n    cert=('client.pem', 'client.key'),\n)\nprint(res.json())`,
      };
    default:
      return {
        curl: `curl -X ${m} '${url}'`,
        js: `const res = await fetch('${url}', { method: '${m}' });\nconsole.log(await res.json());`,
        python: `import requests\n\nres = requests.${m.toLowerCase()}('${url}')\nprint(res.json())`,
      };
  }
}

export function Section({ title, children, aside }) {
  return (
    <section className="pt-block">
      {(title || aside) && (
        <div className="row mb-16">
          {title && <h2 className="grow">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}
