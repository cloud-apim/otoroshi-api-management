// The tags and the variables of the templates of a portal (Markdoc): the portal renders them with its
// own components, the console documents them beside its editors. A template holds no script: its
// tags are declared here, nothing else runs.

export const PORTAL_TAGS = [
  { name: 'catalogue', selfClosing: true, attributes: { category: 'string', tag: 'string', limit: 'number' }, description: 'the cards of the apis of the catalogue — of a category, of a tag — a limit of them', example: '{% catalogue category="retail" limit=6 /%}' },
  { name: 'featured', selfClosing: true, attributes: { limit: 'number' }, description: 'the cards of the featured apis', example: '{% featured limit=3 /%}' },
  { name: 'categories', selfClosing: true, attributes: {}, description: 'the categories of the catalogue, each a link to its apis', example: '{% categories /%}' },
  { name: 'api-card', selfClosing: true, attributes: { api: 'string' }, description: 'the card of one api, by its slug', example: '{% api-card api="books" /%}' },
  { name: 'api-reference', selfClosing: true, attributes: { api: 'string' }, description: 'the reference of an api, its OpenAPI rendered, tried from the page with the credentials of the consumer', example: '{% api-reference api="books" /%}' },
  { name: 'plans', selfClosing: true, attributes: { api: 'string' }, description: 'the plans of an api, what each one gives, and how to subscribe', example: '{% plans api="books" /%}' },
  { name: 'subscribe', selfClosing: true, attributes: { api: 'string', plan: 'string', label: 'string' }, description: 'a button that subscribes to an api — to a plan of it, when named', example: '{% subscribe api="books" plan="plan_free" label="Get a key" /%}' },
  { name: 'button', selfClosing: false, attributes: { href: 'string', kind: 'string' }, description: 'a link drawn as a button (kind: primary or secondary); a page of the portal is page:<slug>', example: '{% button href="page:guide" kind="primary" %}Read the guide{% /button %}' },
  { name: 'callout', selfClosing: false, attributes: { type: 'string', title: 'string' }, description: 'a highlighted note (type: info, warning, success, danger)', example: '{% callout type="info" title="Good to know" %}…{% /callout %}' },
  { name: 'columns', selfClosing: false, attributes: {}, description: 'columns side by side, each a {% column %}', example: '{% columns %}{% column %}…{% /column %}{% column %}…{% /column %}{% /columns %}' },
  { name: 'column', selfClosing: false, attributes: {}, description: 'a column of {% columns %}', example: '{% column %}…{% /column %}' },
];

export const PORTAL_VARIABLES = [
  { name: '$portal.title', description: 'the title of the portal, in the language of the page' },
  { name: '$portal.tagline', description: 'its tagline' },
  { name: '$lang', description: 'the language of the page' },
  { name: '$user.signedIn', description: 'true when a consumer is signed in' },
  { name: '$user.name', description: 'the name of the consumer signed in' },
  { name: '$api.name', description: 'in the template of an api: its name', in: 'api' },
  { name: '$api.version', description: 'its version', in: 'api' },
  { name: '$api.description', description: 'its description', in: 'api' },
  { name: '$api.slug', description: 'its slug', in: 'api' },
  { name: '$api.baseUrl', description: 'the url it is called at', in: 'api' },
];

// the templates a design can hold, in the mode `templates`
export const PORTAL_TEMPLATES = [
  { key: 'home', description: 'the home page of the portal' },
  { key: 'api', description: 'the overview of an api, the first tab of its page' },
];
