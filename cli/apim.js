#!/usr/bin/env bun
// apim — the command line of otoroshi-api-management, in the manner of otoroshictl/kubectl.
// It only talks to the admin api: every action of the console replays from here.
//
//   APIM_URL=http://localhost:9000 APIM_TOKEN=... bun cli/apim.js <command>

import YAML from 'yaml';
import { readFileSync } from 'node:fs';

const HELP = `apim — otoroshi-api-management command line

Usage: apim <command> [args] [--flags]

Global flags / env:
  --url <url>        APIM_URL      (default http://localhost:9000)
  --token <token>    APIM_TOKEN    (an api token from the console, or the bootstrap admin token)
  -o, --output       json | yaml | table (default table)

Commands:
  whoami
  gateway status
  workspaces list
  apis list <ws>
  apis get <ws> <api>                  the declarative document of an api-version (-o yaml)
  apis changes <ws> <api>              what the draft changes since the last snapshot
  apis publish <ws> <api> [--comment c] [--deploy]
  apis deploy <ws> <api> [--snapshot n] [--dry-run]
  apis undeploy <ws> <api>
  apis snapshots <ws> <api>
  apply <ws> -f <file.yaml|json> [--publish] [--deploy] [--managed-by <source>]
  subscriptions list <ws> [--status s] [--api id]
  subscriptions accept|reject|suspend|resume|close <ws> <id> [--message m]
  subscriptions transfer <ws> <id> --plan <plan> [--api <api>]
  applications list <ws>
  drift <ws>                            run drift detection and print the reports
  audit <ws> [--limit n] [--q text]
  export <ws>                           full export, re-importable
  import <ws> -f <file>
`;

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-o' || a === '-f') {
      flags[a === '-o' ? 'output' : 'file'] = argv[++i];
    } else args.push(a);
  }
  return { args, flags };
}

const { args, flags } = parseArgs(process.argv.slice(2));
const URL_BASE = (flags.url || process.env.APIM_URL || 'http://localhost:9000').replace(/\/$/, '');
const TOKEN = flags.token || process.env.APIM_TOKEN;
const OUTPUT = flags.output || 'table';

async function call(method, path, body) {
  const res = await fetch(`${URL_BASE}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  if (!res.ok) {
    const details = data?.details?.errors ? `\n  - ${data.details.errors.map((e) => e.message).join('\n  - ')}` : data?.details ? ` (${JSON.stringify(data.details)})` : '';
    throw new Error(`${res.status} ${data?.error || text}${details}`);
  }
  return data;
}

function print(data, columns) {
  if (OUTPUT === 'json') return console.log(JSON.stringify(data, null, 2));
  if (OUTPUT === 'yaml') return console.log(YAML.stringify(data));
  if (!columns || !Array.isArray(data)) return console.log(YAML.stringify(data));
  const rows = data.map((d) => columns.map(([, f]) => String(typeof f === 'function' ? f(d) : d[f] ?? '')));
  const widths = columns.map(([h], i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(columns.map(([h]) => h.toUpperCase())));
  rows.forEach((r) => console.log(line(r)));
}

function readDocs(file) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const d = JSON.parse(text);
    return Array.isArray(d) ? d : [d];
  }
  return YAML.parseAllDocuments(text).map((d) => d.toJSON()).filter(Boolean);
}

const need = (v, what) => {
  if (!v) {
    console.error(`missing ${what}\n\n${HELP}`);
    process.exit(2);
  }
  return v;
};

const deployLabel = (a) => (!a.last_snapshot ? 'draft only' : a.deployment?.action === 'deploy' && a.deployment?.status === 'deployed' ? 'deployed' : a.deployment?.status || 'not deployed');

async function main() {
  const [cmd, sub, a1, a2] = args;
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);
  if (!TOKEN) throw new Error('no token: set APIM_TOKEN or --token (create one in the console: user menu > API tokens)');
  const ws = (w) => `/workspaces/${need(w, '<ws>')}`;
  switch (cmd) {
    case 'whoami':
      return print((await call('GET', '/me')).user);
    case 'gateway':
      return print(await call('GET', '/gateway/status'));
    case 'workspaces':
      return print(await call('GET', '/workspaces'), [['slug', 'slug'], ['name', 'name'], ['id', 'id']]);
    case 'apis': {
      const w = a1;
      const api = a2;
      switch (sub) {
        case 'list':
          return print(await call('GET', `${ws(w)}/apis`), [
            ['name', 'name'],
            ['version', 'version'],
            ['slug', 'slug'],
            ['lifecycle', 'lifecycle'],
            ['gateway', deployLabel],
            ['snapshot', (a) => (a.last_snapshot ? `#${a.last_snapshot}` : '')],
            ['plans', 'plans_count'],
            ['subs', 'active_subscriptions'],
            ['id', 'id'],
          ]);
        case 'get': {
          const doc = await call('GET', `${ws(w)}/apis/${need(api, '<api>')}/document`);
          if (OUTPUT === 'table') return console.log(YAML.stringify(doc));
          return print(doc);
        }
        case 'changes': {
          const c = await call('GET', `${ws(w)}/apis/${need(api, '<api>')}/changes`);
          if (!c.changes) return console.log('no snapshot yet: everything is new');
          if (!c.changes.length) return console.log(`no change since snapshot #${c.snapshot.number}`);
          c.changes.forEach((x) => console.log(`${x.op === 'add' ? '+' : x.op === 'remove' ? '-' : '~'} ${x.path}`));
          return;
        }
        case 'publish': {
          const r = await call('POST', `${ws(w)}/apis/${need(api, '<api>')}/publish`, { comment: flags.comment || '', deploy: !!flags.deploy });
          console.log(`snapshot #${r.snapshot.number} published${r.deployment ? `, deployment ${r.deployment.deployment.status}` : ''}`);
          (r.warnings || []).forEach((x) => console.log(`warning: ${x.message}`));
          return;
        }
        case 'deploy': {
          const r = await call('POST', `${ws(w)}/apis/${need(api, '<api>')}/deploy`, { snapshot: flags.snapshot, dry_run: !!flags['dry-run'] });
          if (r.dryRun) {
            console.log(`dry run: snapshot #${r.snapshot.number}${r.running ? ` replaces #${r.running.number}` : ' (first deployment)'}`);
            console.log('catalogue changes:');
            (r.changes || []).forEach((x) => console.log(`  ${x.op} ${x.path}`));
            console.log('gateway changes:');
            (r.gatewayChanges || []).forEach((x) => console.log(`  ${x.op} ${x.path}`));
            if (!r.gatewayChanges?.length) console.log('  none: the gateway already holds exactly this');
            (r.warnings || []).forEach((x) => console.log(`warning: ${x.message}`));
            return;
          }
          console.log(`snapshot #${r.snapshot.number}: ${r.deployment.status}${r.deployment.error ? ` (${r.deployment.error})` : ''}`);
          return;
        }
        case 'undeploy':
          return print(await call('POST', `${ws(w)}/apis/${need(api, '<api>')}/undeploy`));
        case 'snapshots':
          return print(await call('GET', `${ws(w)}/apis/${need(api, '<api>')}/snapshots`), [
            ['number', 'number'],
            ['published', 'published_at'],
            ['by', 'published_by_email'],
            ['comment', 'comment'],
          ]);
        default:
          throw new Error(`unknown apis subcommand ${sub}`);
      }
    }
    case 'apply': {
      const docs = readDocs(need(flags.file, '-f <file>'));
      const q = new URLSearchParams();
      if (flags.publish) q.set('publish', 'true');
      if (flags.deploy) q.set('deploy', 'true');
      if (flags['managed-by']) q.set('managed_by', flags['managed-by']);
      if (flags.comment) q.set('comment', flags.comment);
      const res = await call('POST', `${ws(sub)}/apply?${q}`, docs);
      res.forEach((r) => console.log(`api ${r.api.slug} ${r.api.version} ${r.action}${r.snapshot ? `, snapshot ${r.snapshot}` : ''}${r.deployment ? `, ${r.deployment}` : ''}`));
      return;
    }
    case 'subscriptions': {
      if (sub === 'list') {
        const q = new URLSearchParams();
        if (flags.status) q.set('status', flags.status);
        if (flags.api) q.set('api', flags.api);
        return print(await call('GET', `${ws(a1)}/subscriptions?${q}`), [
          ['id', 'id'],
          ['application', 'application_name'],
          ['api', (s) => `${s.api_name} ${s.api_version}`],
          ['plan', (s) => s.request?.plan_name || s.plan_id],
          ['status', 'status'],
          ['gateway', (s) => s.projection?.status || ''],
        ]);
      }
      if (['accept', 'reject', 'suspend', 'resume', 'close', 'resync'].includes(sub)) {
        const r = await call('POST', `${ws(a1)}/subscriptions/${need(a2, '<id>')}/${sub}`, { message: flags.message || '' });
        return console.log(`subscription ${r.id || a2}: ${r.status || 'done'}`);
      }
      if (sub === 'transfer') {
        const r = await call('POST', `${ws(a1)}/subscriptions/${need(a2, '<id>')}/transfer`, { plan_id: need(flags.plan, '--plan'), api_id: flags.api });
        return console.log(`subscription ${r.id} is now on plan ${r.plan_id}`);
      }
      throw new Error(`unknown subscriptions subcommand ${sub}`);
    }
    case 'applications':
      return print(await call('GET', `${ws(a1)}/applications`), [
        ['id', 'id'],
        ['name', 'name'],
        ['team', 'team_name'],
        ['client_id', 'client_id'],
        ['subs', 'active_subscriptions'],
      ]);
    case 'drift': {
      await call('POST', `${ws(sub)}/drift`);
      return print(await call('GET', `${ws(sub)}/drift`), [
        ['status', 'status'],
        ['kind', 'otoroshi_kind'],
        ['object', (r) => r.label || r.entity_id],
        ['changes', (r) => (r.diff || []).map((d) => d.path).join(', ')],
      ]);
    }
    case 'audit':
      return print((await call('GET', `${ws(sub)}/audit?limit=${flags.limit || 50}${flags.q ? `&q=${encodeURIComponent(flags.q)}` : ''}`)).items, [
        ['at', 'at'],
        ['actor', (e) => e.actor?.email],
        ['action', 'action'],
        ['summary', 'summary'],
      ]);
    case 'export':
      return console.log(JSON.stringify(await call('GET', `${ws(sub)}/export`), null, 2));
    case 'import': {
      const doc = JSON.parse(readFileSync(need(flags.file, '-f <file>'), 'utf8'));
      return print(await call('POST', `${ws(sub)}/import`, doc));
    }
    default:
      throw new Error(`unknown command ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
