// The inventory of the Otoroshi entities (D-15): what is not API management is derived from the
// description of the apis, or consumed as the infrastructure it is — the product never becomes a
// second administration console. The criterion: does the entity follow from the description of an
// api? Then the product derives it, marks it as its own and reconciles it. Otherwise it is
// infrastructure: referenced, read, never owned.
//
// One row per kind the gateway declares (GET /apis/entities): a kind the gateway declares and this
// inventory does not know fails `test/inventory.test.js`.
//
//   projected   written from a snapshot or a subscription, the product's own (drift, removal)
//   derived     follows from the description of an api, the product's own, reconciled with it
//   setup       made once by the setup of the gateway, the product's own, its marker on it
//   minted      made by Otoroshi from what the product projects: the product reads it, never writes it
//   consumed    infrastructure the product references or reads, never owns
//   unused      the product neither reads nor writes it

export const INVENTORY = [
  // the api management itself
  { kind: 'Api', group: 'apis.otoroshi.io', treatment: 'projected', how: 'one per deployed api: the snapshot projected, managed as code (`created_by=external=otoroshi-api-management`, `deployment_ref`); an Api the product does not manage can be adopted' },
  { kind: 'ApiSubscription', group: 'apis.otoroshi.io', treatment: 'projected', how: 'one per effective subscription (active, suspended, expired), its id the product\'s, the client id of the application on token and certificate plans' },
  { kind: 'Apikey', group: 'apim.otoroshi.io', treatment: 'minted', how: 'minted by Otoroshi for the subscriptions and the consumers of the plans: the product reads them (credentials, drift, quotas), rotates a secret on demand; the key of the product itself, `apim_product_admin`, is made by the setup' },
  // derived from the description of an api
  { kind: 'JwtVerifier', group: 'security.otoroshi.io', treatment: 'derived', how: 'from a jwt plan that describes how its tokens are validated (`apim_jwt_<api>_<plan>`); a plan may reference an existing verifier instead: consumed' },
  { kind: 'AuthModule', group: 'security.otoroshi.io', treatment: 'derived', how: 'from an oauth2-remote plan that describes its authorization server (`apim_auth_<api>_<plan>`); a plan may reference an existing module instead, and the console route of the setup may sit behind one: consumed' },
  { kind: 'Certificate', group: 'pki.otoroshi.io', treatment: 'derived', how: 'the trusted CAs of the mtls plans (`apim_ca_…`), the client certificates of the applications while they hold an mtls subscription (`apim_appcert_…`); the key pairs that sign the tokens of oauth2-local plans and the certificates of the hosts served over https are consumed' },
  // made by the setup
  { kind: 'Route', group: 'proxy.otoroshi.io', treatment: 'setup', how: 'the routes of the console and of the portals (`apim_setup_console`, `apim_setup_portals`); the routes of an api are inside its Api, not Route entities' },
  { kind: 'DataExporter', group: 'events.otoroshi.io', treatment: 'setup', how: 'the exporter of the events to the ingester, `apim_ingester_exporter`; the other exporters are the operator\'s' },
  // infrastructure the product references or reads
  { kind: 'GlobalConfig', group: 'config.otoroshi.io', treatment: 'consumed', how: 'read: the TLS settings (client authentication of mtls plans, trusted CAs) and the env of the local vault; the setup sets the TLS client authentication when asked' },
  { kind: 'Script', group: 'plugins.otoroshi.io', treatment: 'consumed', how: 'the plugins of the flows of an api, chosen in the catalog of the gateway, by their id' },
  { kind: 'WasmPlugin', group: 'plugins.otoroshi.io', treatment: 'consumed', how: 'a wasm plugin a flow of an api uses, referenced in its configuration' },
  { kind: 'Workflow', group: 'plugins.otoroshi.io', treatment: 'consumed', how: 'a workflow a flow of an api calls, referenced in its configuration' },
  { kind: 'CorazaConfig', group: 'coraza-waf.extensions.otoroshi.io', treatment: 'consumed', how: 'a firewall configuration a flow of an api references (threat protection)' },
  // the Threat Protection Suite (otoroshi-waf-extension), when the gateway has it
  { kind: 'ThreatPolicy', group: 'waf.extensions.cloud-apim.com', treatment: 'consumed', how: 'a threat policy a plan with threat protection references: how a score turns into an action; read to say when it records only, or can challenge a caller' },
  { kind: 'BotPolicy', group: 'waf.extensions.cloud-apim.com', treatment: 'consumed', how: 'a bot policy a plan with threat protection references' },
  { kind: 'WafConfig', group: 'waf.extensions.cloud-apim.com', treatment: 'consumed', how: 'a firewall configuration a plan with threat protection references' },
  { kind: 'ApiContract', group: 'waf.extensions.cloud-apim.com', treatment: 'consumed', how: 'an api contract a plan with threat protection checks its calls against' },
  { kind: 'Organization', group: 'organize.otoroshi.io', treatment: 'consumed', how: 'everything the product writes is in the `default` location: a workspace is never a tenant of the gateway' },
  { kind: 'Tenant', group: 'organize.otoroshi.io', treatment: 'consumed', how: 'the same, under its other name: the `default` tenant' },
  { kind: 'Team', group: 'organize.otoroshi.io', treatment: 'consumed', how: 'the `default` team; the teams of the product are its own' },
  // not used
  { kind: 'Backend', group: 'proxy.otoroshi.io', treatment: 'unused', how: 'the backends of an api are inside its Api' },
  { kind: 'RouteComposition', group: 'proxy.otoroshi.io', treatment: 'unused', how: '' },
  { kind: 'RouteTemplate', group: 'proxy.otoroshi.io', treatment: 'unused', how: '' },
  { kind: 'Draft', group: 'proxy.otoroshi.io', treatment: 'unused', how: 'the drafts of an api are the product\'s: they never reach the gateway' },
  { kind: 'TcpService', group: 'proxy.otoroshi.io', treatment: 'unused', how: '' },
  { kind: 'ErrorTemplate', group: 'proxy.otoroshi.io', treatment: 'unused', how: '' },
  { kind: 'HttpListener', group: 'http-listeners.proxy.otoroshi.io', treatment: 'unused', how: 'the routes of an api answer on the standard listeners' },
  { kind: 'ServiceGroup', group: 'organize.otoroshi.io', treatment: 'unused', how: '' },
  { kind: 'AdminSession', group: 'security.otoroshi.io', treatment: 'unused', how: 'the product calls the gateway with its key, not a session' },
  { kind: 'SimpleAdminUser', group: 'security.otoroshi.io', treatment: 'unused', how: '' },
  { kind: 'AuthModuleUser', group: 'security.otoroshi.io', treatment: 'unused', how: 'the people of the console and of the portals are the product\'s' },
  { kind: 'UserRightsPolicy', group: 'security.otoroshi.io', treatment: 'unused', how: '' },
  { kind: 'UserDashboard', group: 'analytics.otoroshi.io', treatment: 'unused', how: 'the dashboards are the product\'s, from its ingester' },
  { kind: 'UserAlert', group: 'analytics.otoroshi.io', treatment: 'unused', how: '' },
  { kind: 'RemoteCatalog', group: 'catalogs.otoroshi.io', treatment: 'unused', how: 'the remote catalogs of the product are its own: they write drafts, not Apis' },
  { kind: 'GreenScore', group: 'green-score.extensions.otoroshi.io', treatment: 'unused', how: '' },
  { kind: 'WafRuleset', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: 'the rules of a firewall configuration: the operator\'s, in Threat Studio' },
  { kind: 'ChallengeProvider', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: 'the challenges of a threat policy' },
  { kind: 'HoneypotPolicy', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: '' },
  { kind: 'MalwareScanner', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: '' },
  { kind: 'RuleFeed', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: '' },
  { kind: 'ThreatFeed', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: '' },
  { kind: 'GeoDatabase', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: '' },
  { kind: 'AsnDatabase', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: '' },
  { kind: 'AlertRule', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: '' },
  { kind: 'CrowdSecBouncer', group: 'waf.extensions.cloud-apim.com', treatment: 'unused', how: '' },
];

export const TREATMENTS = ['projected', 'derived', 'setup', 'minted', 'consumed', 'unused'];
