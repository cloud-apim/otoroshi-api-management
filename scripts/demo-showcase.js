// The demo, third part: a workspace whose portal is designed, for the screens of the design, idempotently.
//  - the workspace "Weather Co" (showcase), an api deployed with its OpenAPI, two plans
//  - its portal themed and published (v1): colors, a font, a radius, a logo, links, a home of blocks
//  - its draft written as templates (Markdoc), not published: seen through a preview link
const URL = (process.env.APIM_URL || 'http://localhost:9000').replace(/\/$/, '');
const TOKEN = process.env.APIM_TOKEN || 'apim-admin-token';

async function call(method, path, body) {
  const res = await fetch(`${URL}/api${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error || ''}`);
  return data;
}
const W = '/workspaces/showcase';
// a logo of 96 pixels, drawn once
const LOGO = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAB6ElEQVR42u2dQVLDMBAEoy2f4X88gHwCTuET8ID8z3wgXDkQbFe0mtVuz9llS9OakWOnyqcTQgihqmpeJ356e71lM+v746uFBpDRdG8YDdO1MAzztclvGK9Ng2G+Ng2G+VoIhvlaCIb5WgiG+VoIhkVaGatfmwLDfC0EKihyBSERAOpnXA2RACqottps9bO+bB/zfI1t+u8npssMq2SP6feOjw5jyWT8f+eICsIym+95vtQAvMyKCMGqmB8VglUyPyIEq2Z+NAhW0fxIEKyq+VGuz6OIygmI0sPKcZAANmEAlK4f9XhIABUEAAQAACAAAAABAADDFO0luWo8JIAKAkC52EcaBwmoXkHqFKivb5UrIEIFSv4bul4+Q8R/vfwB5f2cF0AU4/eMcRSIBeO1IAzztePnNjTzbejsq3/EPEhA1gRkWf3e8yEBmfcABAAAIBGA0c9UvOU1HxKQuYKypMBzHiQg+yY8ewq8x7+MnMRMv45TvQ+YCUTqN2JZb1HZhAGAAJAFgMenmtB9f0kAFQSAzZggn/ohAVQQsiNxQX3rZzMBQPA1nwqaYQ8gBX6rf3cCgOBj/qEKAkJ/8w/vAUDo75N5nhzzt/WQmXxt6fGFaYqLYn6nBFRORK/F57aCM8Ig8QihZPoBjbS7yIFt5kMAAAAASUVORK5CYII=';

if (!(await call('GET', '/workspaces')).some((w) => w.slug === 'showcase')) {
  await call('POST', '/workspaces', { name: 'Weather Co', slug: 'showcase' });
  console.log('showcase  workspace created');
}
const teams = await call('GET', `${W}/teams`);
const team = teams.find((t) => t.name === 'Weather team') || (await call('POST', `${W}/teams`, { name: 'Weather team' }));

const OPENAPI = `openapi: 3.0.3
info: { title: Forecasts, version: 1.0.0, description: Forecasts for every city, by the hour. }
paths:
  /forecasts/{city}:
    get:
      summary: The forecast of a city
      parameters: [{ name: city, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: the hours to come } }
  /cities:
    get:
      summary: The cities known
      responses: { '200': { description: the cities } }
`;
const applied = await call('POST', `${W}/apply?publish=true&deploy=true&comment=showcase`, [
  {
    apiVersion: 'otoroshi-apim.io/v1',
    kind: 'Api',
    metadata: { name: 'forecasts' },
    spec: {
      version: '1.0.0',
      name: 'Forecasts',
      description: 'Forecasts for every city, by the hour.',
      team: team.name,
      tags: ['weather'],
      draft: {
        entrypoint: { domain: 'showcase-forecasts.oto.tools', contextPath: '/v1' },
        backends: [{ id: 'backend_echo', name: 'echo', targets: [{ hostname: 'echo', port: 8080 }] }],
        flows: [{ id: 'flow_main', name: 'main', plugins: [] }],
        resources: [
          { id: 'res_forecasts', name: 'Forecasts', path: '/forecasts', methods: ['GET'], backendId: 'backend_echo', flowId: 'flow_main' },
          { id: 'res_cities', name: 'Cities', path: '/cities', methods: ['GET'], backendId: 'backend_echo', flowId: 'flow_main' },
        ],
        plans: [
          { id: 'plan_showcase_free', name: 'Free', description: 'To try it.', status: 'published', validation: 'auto', auth: { kind: 'apikey' }, rateLimit: { enabled: true, calls: 5, windowMs: 1000 }, quota: { daily: 1000 } },
          { id: 'plan_showcase_pro', name: 'Pro', description: 'For production.', status: 'published', validation: 'manual', auth: { kind: 'apikey' }, rateLimit: { enabled: true, calls: 100, windowMs: 1000 } },
        ],
        openapi: { format: 'yaml', content: OPENAPI },
      },
    },
  },
]);
applied.forEach((r) => console.log(`showcase  api ${r.api.slug} ${r.api.version}: ${r.action}${r.snapshot ? `, snapshot ${r.snapshot}` : ''}${r.deployment ? `, ${r.deployment}` : ''}`));

const state = await call('GET', `${W}/portal/design`);
const logo = state.draft.assets['assets/logo.png'] || (await call('POST', `${W}/portal/assets`, { path: 'assets/logo.png', data: LOGO })).hash;
const themed = {
  mode: 'themed',
  texts: { title: { en: 'Weather Co developers', fr: 'Développeurs Weather Co' }, tagline: { en: 'Forecasts as a service — by the hour, for every city.', fr: 'La météo en service — heure par heure, pour chaque ville.' } },
  theme: { accent: '#0e7c66', logo: 'assets/logo.png', favicon: 'assets/logo.png', font: "Georgia, 'Times New Roman', serif", radius: 'large', colors: { light: { background: '#f3f7f5' }, dark: { background: '#0b1310', surface: '#111c18' } } },
  navigation: {
    header: [{ label: { en: 'Guide', fr: 'Guide' }, href: 'page:guide' }, { label: { en: 'Status', fr: 'État' }, href: 'https://status.example.com' }],
    footer: [{ label: { en: 'Terms', fr: 'Conditions' }, href: 'page:guide' }, { label: { en: 'Contact', fr: 'Contact' }, href: 'mailto:api@example.com' }],
  },
  home: {
    blocks: [
      { kind: 'hero' },
      { kind: 'catalogue', title: { en: 'Our APIs', fr: 'Nos API' }, limit: 3 },
      { kind: 'markdown', content: { en: '## Why Weather Co\n\nForecasts you can **trust**, refreshed every hour. [Read the guide](page:guide).', fr: '## Pourquoi Weather Co\n\nDes prévisions **fiables**, rafraîchies chaque heure. [Lire le guide](page:guide).' } },
    ],
  },
  pages: [{ slug: 'guide', title: { en: 'Guide', fr: 'Guide' }, content: { en: '# Getting started\n\n1. Create an account.\n2. Subscribe to the **Free** plan.\n3. Call `/v1/forecasts/paris` with your key.', fr: '# Démarrer\n\n1. Créez un compte.\n2. Souscrivez au plan **Free**.\n3. Appelez `/v1/forecasts/paris` avec votre clé.' }, nav: false }],
  css: '.pt-hero-title { letter-spacing: -0.02em; }',
  assets: { 'assets/logo.png': logo },
};
if (!state.published.number) {
  await call('PUT', `${W}/portal/design`, themed);
  await call('POST', `${W}/portal/publish`, { comment: 'the theme of Weather Co' });
  console.log('showcase  portal design v1 published: themed');
}
// the next design, written as templates, kept as a draft
const draft = (await call('GET', `${W}/portal/design`)).draft;
if (draft.mode !== 'templates') {
  await call('PUT', `${W}/portal/design`, {
    ...themed,
    mode: 'templates',
    templates: {
      home: {
        en: '# {% $portal.title %}\n\n{% $portal.tagline %}\n\n{% button href="page:guide" %}Start with the guide{% /button %} {% subscribe api="forecasts" plan="plan_showcase_free" label="Get a free key" /%}\n\n{% callout type="info" title="New" %}Forecasts by the minute arrive next month.{% /callout %}\n\n## Our APIs\n\n{% catalogue limit=3 /%}\n\n## Plans\n\n{% plans api="forecasts" /%}',
      },
      api: { en: '# {% $api.name %}\n\n{% $api.description %} Called at {% $api.baseUrl %}.\n\n{% columns %}\n{% column %}\n### Hourly\n\nThe next 48 hours, hour by hour.\n{% /column %}\n{% column %}\n### Every city\n\nFive thousand cities, and growing.\n{% /column %}\n{% /columns %}\n\n{% api-reference api="forecasts" /%}' },
    },
  });
  console.log('showcase  portal draft written as templates (not published)');
}
