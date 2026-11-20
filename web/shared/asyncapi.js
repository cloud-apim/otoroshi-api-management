// Reading an AsyncAPI specification, 2.x or 3.x: its channels and their operations, from the side of a
// consumer of the api. Pure, shared by the console and the portal.

// a local reference of the document (#/components/messages/x), resolved — a cycle or a depth past
// a few levels is left as the reference it is
export function resolver(spec) {
  const get = (ref) =>
    ref
      .replace(/^#\//, '')
      .split('/')
      .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), spec);
  const resolve = (v, depth = 0, seen = new Set()) => {
    if (!v || typeof v !== 'object' || depth > 8) return v;
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth + 1, seen));
    if (typeof v.$ref === 'string' && v.$ref.startsWith('#/')) {
      if (seen.has(v.$ref)) return v;
      const target = get(v.$ref);
      return target === undefined ? v : resolve(target, depth + 1, new Set([...seen, v.$ref]));
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, depth + 1, seen)]));
  };
  return resolve;
}

// the channels of the document, from the consumer's side: what it sends, what it receives. AsyncAPI 3
// describes the operations of the api (send: the api sends, the consumer receives); AsyncAPI 2 the
// ones of the others (publish: a consumer publishes, subscribe: a consumer receives)
export function channelsOf(spec) {
  const resolve = resolver(spec);
  const channels = spec?.channels && typeof spec.channels === 'object' ? spec.channels : {};
  const messagesOf = (m) => {
    if (!m) return [];
    const r = resolve(m);
    if (Array.isArray(r?.oneOf)) return r.oneOf.map((x) => resolve(x));
    return [r];
  };
  if (String(spec?.asyncapi || '').startsWith('2'))
    return Object.entries(channels).map(([name, raw]) => {
      const c = resolve(raw) || {};
      return {
        name,
        address: name,
        description: c.description,
        operations: [
          ...(c.publish ? [{ side: 'send', summary: c.publish.summary || c.publish.description, messages: messagesOf(c.publish.message) }] : []),
          ...(c.subscribe ? [{ side: 'receive', summary: c.subscribe.summary || c.subscribe.description, messages: messagesOf(c.subscribe.message) }] : []),
        ],
      };
    });
  const operations = Object.entries(spec?.operations || {});
  return Object.entries(channels).map(([name, raw]) => {
    const c = resolve(raw) || {};
    const all = Object.values(c.messages || {}).map((x) => resolve(x));
    return {
      name,
      address: c.address ?? name,
      description: c.description,
      operations: operations
        .filter(([, o]) => o?.channel?.$ref === `#/channels/${name}`)
        .map(([id, o]) => ({
          id,
          side: o.action === 'send' ? 'receive' : 'send',
          summary: o.summary || o.description,
          messages: Array.isArray(o.messages) && o.messages.length ? o.messages.map((x) => resolve(x)) : all,
        })),
    };
  });
}
