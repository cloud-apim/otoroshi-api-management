// The policy of the ingester, without infrastructure: its settings checked, the pseudonyms, the
// templates of the paths, the sampling of the raw path, the percentiles of the rollups.
import { describe, expect, test } from 'bun:test';
import { normalize, publicPolicy, pseudonym, pseudonymise, sampled, templatePath, truncateIp, urlOf, ipOf, userOf } from '../server/domain/ingest-policy.js';
import { percentile } from '../server/domain/retention.js';

const policy = (privacy = {}, raw = {}) => normalize({ privacy, raw });

describe('the settings', () => {
  test('completed with the defaults, checked, the key made once and never shown', () => {
    const p = normalize({});
    expect(p.raw).toEqual({ sampleRate: 1, keepErrors: true, headers: 'keep' });
    expect(p.privacy).toEqual({ ip: 'keep', user: 'keep', userAgent: 'keep', paths: 'keep' });
    expect(p.retention).toEqual({ callsDays: 30, rollupsDays: 400, aiDays: 90, rawDays: 7 });
    expect(p.key).toMatch(/^[0-9a-f]{64}$/);
    expect(normalize({ raw: { sampleRate: 0.1 } }, p).key).toBe(p.key);
    expect(normalize({ rotateKey: true }, p).key).not.toBe(p.key);
    expect(publicPolicy(p)).not.toHaveProperty('key');
    expect(publicPolicy(p).keyed).toBe(true);
  });

  test('a value out of its range or its list is refused', () => {
    expect(() => normalize({ raw: { sampleRate: 1.5 } })).toThrow(/sampleRate/);
    expect(() => normalize({ privacy: { ip: 'encrypt' } })).toThrow(/privacy.ip/);
    expect(() => normalize({ retention: { callsDays: 0 } })).toThrow(/callsDays/);
    // the rollups outlive the calls they are made of
    expect(() => normalize({ retention: { callsDays: 60, rollupsDays: 30 } })).toThrow(/rollupsDays/);
  });
});

describe('the pseudonymisation', () => {
  test('an address kept, cut to its network, replaced by a pseudonym, or left out', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0');
    expect(truncateIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::');
    expect(ipOf(policy({ ip: 'truncate' }), '203.0.113.42, 10.0.0.7')).toBe('203.0.113.0, 10.0.0.0');
    const p = policy({ ip: 'hash' });
    expect(ipOf(p, '203.0.113.42')).toMatch(/^ip:[0-9a-f]{16}$/);
    // one caller, one token — but another token with another key
    expect(ipOf(p, '203.0.113.42')).toBe(ipOf(p, '203.0.113.42'));
    expect(ipOf(p, '203.0.113.42')).not.toBe(ipOf(p, '203.0.113.43'));
    expect(ipOf({ ...p, key: 'another' }, '203.0.113.42')).not.toBe(ipOf(p, '203.0.113.42'));
    expect(ipOf(policy({ ip: 'drop' }), '203.0.113.42')).toBeNull();
    expect(pseudonym('k', 'user', 'jane@example.com')).toBe(pseudonym('k', 'user', 'jane@example.com'));
  });

  test('an event: the address, its headers, the signed-in user, the agent; the client id of a key stays', () => {
    const p = policy({ ip: 'truncate', user: 'hash', userAgent: 'drop' });
    const e = pseudonymise(p, {
      from: '203.0.113.42',
      headers: [
        { key: 'X-Forwarded-For', value: '198.51.100.7' },
        { key: 'User-Agent', value: 'curl/8' },
        { key: 'Accept', value: '*/*' },
      ],
      identity: { identityType: 'PRIVATEAPP', identity: 'jane@example.com', label: 'Jane Doe' },
      geolocationInfo: { city: 'Lyon' },
      userAgentInfo: { browser: 'curl' },
    });
    expect(e.from).toBe('203.0.113.0');
    expect(e.headers).toEqual([
      { key: 'X-Forwarded-For', value: '198.51.100.0' },
      { key: 'Accept', value: '*/*' },
    ]);
    expect(e.identity.identity).toBe(userOf(p, 'jane@example.com'));
    expect(e.identity.label).toMatch(/^user:/);
    expect(e.geolocationInfo).toBeUndefined();
    expect(e.userAgentInfo).toBeUndefined();
    const key = pseudonymise(p, { identity: { identityType: 'APIKEY', identity: 'client-1', label: 'Acme app' } });
    expect(key.identity.identity).toBe('client-1');
  });

  test('the identifiers of a path templated; the secrets of a url masked, and its query values left out', () => {
    expect(templatePath('/v1/users/jane@example.com/orders/1234/items/550e8400-e29b-41d4-a716-446655440000')).toBe('/v1/users/{email}/orders/{n}/items/{uuid}');
    expect(templatePath('/apis/api_01a1ed46538b70289e335a62a361cc28/docs/getting-started')).toBe('/apis/{id}/docs/getting-started');
    expect(templatePath('/v2/pets')).toBe('/v2/pets');
    expect(urlOf(policy(), 'http://x.oto.tools/users/42?page=2&api_key=abc')).toBe('http://x.oto.tools/users/42?page=2&api_key=********');
    expect(urlOf(policy({ paths: 'template' }), 'http://x.oto.tools/users/42?email=jane@example.com')).toBe('http://x.oto.tools/users/{n}?email=*');
  });
});

describe('the sampling of the raw path', () => {
  test('a share of the requests, decided by request; their errors always', () => {
    const p = policy({}, { sampleRate: 0.2 });
    const kept = Array.from({ length: 5000 }, (_, i) => sampled(p, { reqId: `req-${i}`, status: 200 })).filter(Boolean).length;
    expect(kept).toBeGreaterThan(850);
    expect(kept).toBeLessThan(1150);
    // the events of one request together: the same answer each time
    expect(sampled(p, { reqId: 'req-7', status: 200 })).toBe(sampled(p, { reqId: 'req-7', '@type': 'LLMUsageAudit' }));
    const none = policy({}, { sampleRate: 0 });
    expect(sampled(none, { reqId: 'x', status: 200 })).toBe(false);
    expect(sampled(none, { reqId: 'x', status: 502 })).toBe(true);
    expect(sampled(none, { reqId: 'x', status: 200, err: true })).toBe(true);
    expect(sampled(policy({}, { sampleRate: 0, keepErrors: false }), { reqId: 'x', status: 502 })).toBe(false);
  });
});

describe('the rollups', () => {
  test('a percentile read from a histogram of durations, within its bucket', () => {
    // buckets: 0 is < 5 ms, 1 is 5–10, 2 is 10–25 … 11 is ≥ 10 s
    expect(percentile({}, 0.95)).toBe(0);
    expect(percentile({ 2: 100 }, 0.5)).toBe(17.5);
    expect(percentile({ 0: 90, 4: 10 }, 0.95)).toBe(75);
    expect(percentile({ 11: 3 }, 0.95)).toBe(10000);
  });
});
