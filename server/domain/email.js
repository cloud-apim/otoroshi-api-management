// Email: the notifications of a workspace sent to its people, when its administrators turn it on — to
// the people of its portal, to its producers — then kind by kind; a person of the portal does not
// choose. The transport is the installation's: SMTP (nodemailer), or a provider over its HTTP API
// (Mailgun, Mailjet, SendGrid); `log` writes them to the log of the product, for development.
//
// Never in the request path: a notification queues its emails (a task), and each person's email of
// a notification is sent once, whatever the retries.

import { config } from '../config.js';
import { db, newId } from '../db/index.js';
import { open } from './secrets.js';
import { registerTaskHandler } from './tasks.js';
import { portalUrl } from '../portal-exposure.js';
import { likePattern } from '../http/paging.js';

export const TRANSPORTS = ['none', 'smtp', 'mailgun', 'mailjet', 'sendgrid', 'log'];
export const SMTP_SECURITY = ['starttls', 'tls', 'none'];
const PROVIDER_BASE = {
  mailgun: { us: 'https://api.mailgun.net', eu: 'https://api.eu.mailgun.net' },
  mailjet: 'https://api.mailjet.com',
  sendgrid: 'https://api.sendgrid.com',
};

// the kinds of notification a workspace sends by email, per face: what its settings turn on or off
export const EMAIL_KINDS = {
  portal: [
    'subscription.accept',
    'subscription.reject',
    'subscription.suspend',
    'subscription.resume',
    'subscription.close',
    'subscription.expire',
    'subscription.renew',
    'subscription.ending',
    'subscription.payment',
    'subscription.payment.suspended',
    'subscription.payment.resumed',
    'subscription.payment.canceled',
    'subscription.transfer',
    'subscription.transfer.payment',
    'subscription.transfer.consent',
    'subscription.transfer.decline',
    'api.announcement',
    'api.deprecated',
    'api.archived',
  ],
  console: ['subscription.request', 'subscription.transfer.request', 'subscription.transfer.decline', 'pin.behind'],
};

const env = process.env;
let cached = null;

// the transport of the installation: its stored settings, the APIM_EMAIL_* variables by default
export async function emailSettings() {
  if (cached && cached.at > Date.now() - 5000) return cached.value;
  const stored = (await db`select value from settings where key = 'email'`)[0]?.value || {};
  const smtp = stored.smtp || {};
  const value = {
    transport: stored.transport || env.APIM_EMAIL_TRANSPORT || 'none',
    from: stored.from || env.APIM_EMAIL_FROM || '',
    smtp: {
      host: smtp.host || env.APIM_EMAIL_SMTP_HOST || '',
      port: Number(smtp.port || env.APIM_EMAIL_SMTP_PORT || 587),
      security: smtp.security || env.APIM_EMAIL_SMTP_SECURITY || 'starttls',
      user: smtp.user || env.APIM_EMAIL_SMTP_USER || '',
      password: open(smtp.password) || env.APIM_EMAIL_SMTP_PASSWORD || '',
    },
    apiKey: open(stored.apiKey) || env.APIM_EMAIL_API_KEY || '',
    apiSecret: open(stored.apiSecret) || env.APIM_EMAIL_API_SECRET || '',
    domain: stored.domain || env.APIM_EMAIL_DOMAIN || '',
    region: stored.region || env.APIM_EMAIL_REGION || 'us',
    apiBase: stored.apiBase || env.APIM_EMAIL_API_BASE || '',
  };
  cached = { at: Date.now(), value };
  return value;
}

export function invalidateEmailSettings() {
  cached = null;
}

// "API portal <no-reply@example.com>", or the address alone
export function parseAddress(value) {
  const s = String(value || '').trim();
  const m = /^(.*)<([^>]+)>$/.exec(s);
  const email = (m ? m[2] : s).trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  return { name: m ? m[1].trim().replace(/^"|"$/g, '') : '', email };
}

// what a transport lacks, said plainly
export function emailProblems(s) {
  if (!TRANSPORTS.includes(s.transport)) return [`unknown transport ${s.transport}: ${TRANSPORTS.join(', ')}`];
  if (s.transport === 'none') return [];
  const out = [];
  if (!parseAddress(s.from)) out.push('a from address is needed, e.g. "API portal <no-reply@example.com>"');
  if (s.transport === 'smtp') {
    if (!s.smtp.host) out.push('the host of the SMTP server is needed');
    if (!SMTP_SECURITY.includes(s.smtp.security)) out.push(`the security of SMTP is one of ${SMTP_SECURITY.join(', ')}`);
  }
  if (['mailgun', 'mailjet', 'sendgrid'].includes(s.transport) && !s.apiKey) out.push(`the API key of ${s.transport} is needed`);
  if (s.transport === 'mailgun' && !s.domain) out.push('the sending domain of Mailgun is needed');
  if (s.transport === 'mailgun' && !['us', 'eu'].includes(s.region)) out.push('the region of Mailgun is us or eu');
  if (s.transport === 'mailjet' && !s.apiSecret) out.push('the secret key of Mailjet is needed');
  return out;
}

export const emailReady = (s) => s.transport !== 'none' && !emailProblems(s).length;

const baseOf = (s) => (s.apiBase || (s.transport === 'mailgun' ? PROVIDER_BASE.mailgun[s.region] || PROVIDER_BASE.mailgun.us : PROVIDER_BASE[s.transport])).replace(/\/$/, '');
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function answered(res, provider) {
  if (res.ok) return res.json().catch(() => ({}));
  const text = await res.text().catch(() => '');
  throw new Error(`${provider} answered ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
}

// one email, through the transport of the installation; what the transport answers, or an error
export async function sendEmail({ to, subject, text, html }, s = null) {
  s ??= await emailSettings();
  if (s.transport === 'none') throw new Error('no email transport is set for this installation');
  const problems = emailProblems(s);
  if (problems.length) throw new Error(problems.join('; '));
  const from = parseAddress(s.from);
  const timeout = AbortSignal.timeout(20000);
  switch (s.transport) {
    case 'log':
      console.log(`[apim] email to ${to} — ${subject}\n${text}`);
      return { id: newId('mail') };
    case 'smtp': {
      const { default: nodemailer } = await import('nodemailer');
      const transport = nodemailer.createTransport({
        host: s.smtp.host,
        port: s.smtp.port,
        secure: s.smtp.security === 'tls',
        requireTLS: s.smtp.security === 'starttls',
        ignoreTLS: s.smtp.security === 'none',
        auth: s.smtp.user ? { user: s.smtp.user, pass: s.smtp.password } : undefined,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      });
      try {
        const info = await transport.sendMail({ from: s.from, to, subject, text, html });
        return { id: info.messageId };
      } finally {
        transport.close();
      }
    }
    case 'mailgun': {
      const body = new URLSearchParams({ from: s.from, to, subject, text, ...(html ? { html } : {}) });
      const res = await fetch(`${baseOf(s)}/v3/${encodeURIComponent(s.domain)}/messages`, { method: 'POST', headers: { authorization: basic('api', s.apiKey) }, body, signal: timeout });
      return { id: (await answered(res, 'Mailgun')).id || null };
    }
    case 'mailjet': {
      const message = { From: { Email: from.email, ...(from.name ? { Name: from.name } : {}) }, To: [{ Email: to }], Subject: subject, TextPart: text, ...(html ? { HTMLPart: html } : {}) };
      const res = await fetch(`${baseOf(s)}/v3.1/send`, { method: 'POST', headers: { authorization: basic(s.apiKey, s.apiSecret), 'content-type': 'application/json' }, body: JSON.stringify({ Messages: [message] }), signal: timeout });
      const out = await answered(res, 'Mailjet');
      return { id: out.Messages?.[0]?.To?.[0]?.MessageID ?? null };
    }
    case 'sendgrid': {
      const content = [{ type: 'text/plain', value: text }, ...(html ? [{ type: 'text/html', value: html }] : [])];
      const res = await fetch(`${baseOf(s)}/v3/mail/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from.email, ...(from.name ? { name: from.name } : {}) }, subject, content }),
        signal: timeout,
      });
      await answered(res, 'SendGrid');
      return { id: res.headers.get('x-message-id') };
    }
  }
}

// what a workspace sends by email: off unless its administrators turn a face on; then every kind of
// that face, but the ones turned off
export function normalizeWorkspaceEmail(input = {}) {
  const out = {};
  for (const face of Object.keys(EMAIL_KINDS)) {
    const f = input[face] || {};
    const kinds = {};
    for (const [k, v] of Object.entries(f.kinds || {})) if (EMAIL_KINDS[face].includes(k) && v === false) kinds[k] = false;
    out[face] = { enabled: !!f.enabled, kinds };
  }
  return out;
}

export const wantsEmail = (cfg, face, kind) => !!cfg?.[face]?.enabled && EMAIL_KINDS[face]?.includes(kind) && cfg[face].kinds?.[kind] !== false;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// the email of a notification: its title, its text, a link to where it is dealt with — the portal of
// the workspace, or the console
export function renderNotification(ws, n) {
  const base = (n.face === 'portal' ? portalUrl(ws.slug) || `${config.publicUrl}/${ws.slug}/` : `${config.publicUrl}/backoffice/ws/${ws.slug}/`).replace(/\/$/, '');
  const link = `${base}${n.link || ''}`;
  const where = n.face === 'portal' ? `the developer portal of ${ws.name}` : `the API management console, workspace ${ws.name}`;
  const text = [n.title, n.body, `Open: ${link}`, `—\nYou receive this email as a member of ${where}.`].filter(Boolean).join('\n\n');
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;color:#1a1d21;max-width:560px">
<p style="font-size:17px;font-weight:600;margin:0 0 12px">${escapeHtml(n.title)}</p>
${n.body ? `<p style="margin:0 0 16px">${escapeHtml(n.body)}</p>` : ''}<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="color:#0061bd">Open</a></p>
<p style="font-size:12px;color:#6b7280;margin:0">You receive this email as a member of ${escapeHtml(where)}.</p>
</div>`;
  return { subject: n.title, text, html };
}

// the emails of a notification: each person it is addressed to — a person, or the members of a team —
// once; a failed one is tried again with the task, the sent ones never twice
registerTaskHandler('email_notification', async ({ notification_id }) => {
  const n = (await db`select * from notifications where id = ${notification_id}`)[0];
  if (!n) return { skipped: 'the notification is gone' };
  const ws = (await db`select id, slug, name, email from workspaces where id = ${n.workspace_id}`)[0];
  if (!ws || !wantsEmail(ws.email, n.face, n.kind)) return { skipped: 'not sent by email in this workspace' };
  const s = await emailSettings();
  if (!emailReady(s)) return { skipped: 'no email transport for this installation' };
  const people = n.user_id
    ? await db`select id, email from users where id = ${n.user_id}`
    : await db`select u.id, u.email from team_members tm join users u on u.id = tm.user_id where tm.team_id = ${n.team_id}`;
  const sent = new Set((await db`select user_id from email_deliveries where notification_id = ${n.id} and status = 'sent'`).map((r) => r.user_id));
  const message = renderNotification(ws, n);
  let done = 0;
  const errors = [];
  for (const p of people) {
    if (!p.email || sent.has(p.id)) continue;
    let error = null;
    try {
      await sendEmail({ to: p.email, ...message }, s);
      done++;
    } catch (e) {
      error = String(e.message || e).slice(0, 500);
      errors.push(error);
    }
    await db`insert into email_deliveries (id, notification_id, user_id, workspace_id, kind, address, subject, status, error)
      values (${newId('mail')}, ${n.id}, ${p.id}, ${ws.id}, ${n.kind}, ${p.email}, ${message.subject}, ${error ? 'failed' : 'sent'}, ${error})
      on conflict (notification_id, user_id) where notification_id is not null
      do update set status = excluded.status, error = excluded.error, updated_at = now()`;
  }
  if (errors.length) throw new Error(`${errors.length} email(s) not sent: ${errors[0]}`);
  return { sent: done };
});

// a test from the settings: to an address, recorded beside the others
export async function sendTestEmail(to, s = null) {
  const subject = 'A test email from Otoroshi API Management';
  const text = `This email says that the transport of this installation sends: ${config.publicUrl}.`;
  let error = null;
  let result = null;
  try {
    result = await sendEmail({ to, subject, text, html: `<p>${escapeHtml(text)}</p>` }, s);
  } catch (e) {
    error = String(e.message || e).slice(0, 500);
  }
  await db`insert into email_deliveries (id, address, subject, kind, status, error) values (${newId('mail')}, ${to}, ${subject}, ${'test'}, ${error ? 'failed' : 'sent'}, ${error})`;
  return { sent: !error, error, id: result?.id || null };
}

// the emails sent and the ones that failed, the most recent first: searched by address, subject, kind
export async function listDeliveries({ q = '', status = null, limit = 50, offset = 0 } = {}) {
  const pattern = q ? likePattern(q) : null;
  const where = () => db`(${pattern}::text is null or d.address ilike ${pattern} or d.subject ilike ${pattern} or d.kind ilike ${pattern} or w.slug ilike ${pattern})
    and (${status}::text is null or d.status = ${status})`;
  const [items, [{ total }]] = await Promise.all([
    db`select d.id, d.address, d.subject, d.kind, d.status, d.error, d.created_at, d.updated_at, w.slug as workspace
      from email_deliveries d left join workspaces w on w.id = d.workspace_id where ${where()} order by d.created_at desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from email_deliveries d left join workspaces w on w.id = d.workspace_id where ${where()}`,
  ]);
  return { items, total, limit, offset };
}
