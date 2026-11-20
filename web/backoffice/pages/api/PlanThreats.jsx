import React from 'react';
import { Badge, Callout, Loader, Seg, Select, Setting, Switch, TagsInput, useLoad } from '../../../shared/ui.jsx';
import { api as rootApi } from '../../context.jsx';
import { tr } from '../../../shared/i18n.jsx';

// the defaults of the preset of the Threat Protection Suite, as the model has them
export const THREAT_DEFAULTS = {
  enabled: false,
  threatPolicy: '',
  gate: true,
  response: true,
  waf: true,
  wafConfig: '',
  bots: true,
  botPolicy: '',
  reputation: true,
  reputationMode: 'block',
  fail2ban: false,
  fail2banDryRun: true,
  sensitiveData: false,
  sensitiveDataMode: 'enforce',
  errorLeakage: false,
  errorLeakageMode: 'mask',
  uploads: false,
  uploadsMode: 'enforce',
  login: false,
  loginPaths: [],
  apiContract: false,
  apiContractId: '',
  apiContractMode: 'monitor',
};

const options = (list, none) => [{ value: '', label: none }, ...(list || []).map((e) => ({ value: e.id, label: e.name }))];

// The Threat Protection Suite on the calls of a plan: the product configures the preset of the
// extension, the extension implements it. Its policies are the operator's, referenced here.
export function ThreatProtection({ value, onChange }) {
  const tp = { ...THREAT_DEFAULTS, ...(value || {}) };
  const set = (patch) => onChange({ ...tp, ...patch });
  const catalog = useLoad(() => rootApi.get('/gateway/threat-protection').catch(() => ({ installed: null })), []);
  return (
    <div>
      <p className="muted small" style={{ padding: '12px 0' }}>
        {tr('The Threat Protection Suite of the gateway (otoroshi-waf-extension) on the calls of this plan: a firewall, bots, IP reputation, abuse — configured here, enforced by the extension. Its events are in Observability, tab Security.')}
      </p>
      <Loader state={catalog}>
        {(c) => (
          <>
            {c.installed === false && <Callout kind="warning">{tr('The gateway has no Threat Protection Suite: a plan that asks for it would run unprotected until an operator installs the extension.')}</Callout>}
            {c.installed === null && <Callout kind="info">{tr('The plugin catalog of the gateway cannot be read: whether the extension is installed is checked again at deployment.')}</Callout>}
            <Setting label={tr('Threat protection')}>
              <Switch checked={tp.enabled} onChange={(v) => set({ enabled: v })} label={tr('Protect the calls of this plan')} />
            </Setting>
            {tp.enabled && (
              <>
                <Setting label={tr('Threat policy')} help={tr('how an accumulated threat score turns into an action; none: the built-in policy, which records and never refuses')}>
                  <Select value={tp.threatPolicy} onChange={(v) => set({ threatPolicy: v })} options={options(c.threat_policies, tr('built-in (records only)'))} />
                  <ThreatPolicyNotes policy={(c.threat_policies || []).find((x) => x.id === tp.threatPolicy)} />
                </Setting>
                <Setting label={tr('Threat gate')} help={tr('refuses the callers already banned, before anything else runs')}>
                  <Switch checked={tp.gate} onChange={(v) => set({ gate: v })} />
                </Setting>
                <Setting label={tr('Threat response')} help={tr('turns the score of a call into the action of the policy')}>
                  <Switch checked={tp.response} onChange={(v) => set({ response: v })} />
                </Setting>
                <Setting label={tr('Web application firewall')} help={tr('SecLang rules, the OWASP core rule set by default')}>
                  <Switch checked={tp.waf} onChange={(v) => set({ waf: v })} />
                  {tp.waf && <Select value={tp.wafConfig} onChange={(v) => set({ wafConfig: v })} options={options(c.waf_configs, tr('default configuration'))} />}
                </Setting>
                <Setting label={tr('Bot guard')} help={tr('scores the automated clients and the AI crawlers')}>
                  <Switch checked={tp.bots} onChange={(v) => set({ bots: v })} />
                  {tp.bots && <Select value={tp.botPolicy} onChange={(v) => set({ botPolicy: v })} options={options(c.bot_policies, tr('default policy'))} />}
                </Setting>
                <Setting label={tr('IP reputation')} help={tr('monitor scores and reports, the threat response decides')}>
                  <Switch checked={tp.reputation} onChange={(v) => set({ reputation: v })} />
                  {tp.reputation && (
                    <Seg
                      value={tp.reputationMode}
                      onChange={(v) => set({ reputationMode: v })}
                      options={[
                        { value: 'block', label: tr('block') },
                        { value: 'monitor', label: tr('monitor') },
                      ]}
                    />
                  )}
                </Setting>
                <Setting label={tr('Fail2ban')} help={tr('bans the callers that keep failing')}>
                  <Switch checked={tp.fail2ban} onChange={(v) => set({ fail2ban: v })} />
                  {tp.fail2ban && <Switch checked={tp.fail2banDryRun} onChange={(v) => set({ fail2banDryRun: v })} label={tr('dry run: record the bans, do not apply them')} />}
                </Setting>
                <ModeSetting
                  label={tr('Sensitive data')}
                  help={tr('personal data and secrets in the responses')}
                  on={tp.sensitiveData}
                  mode={tp.sensitiveDataMode}
                  modes={['enforce', 'monitor']}
                  onChange={(on, mode) => set({ sensitiveData: on, sensitiveDataMode: mode })}
                />
                <ModeSetting
                  label={tr('Error leakage')}
                  help={tr('stack traces and internal errors in the responses')}
                  on={tp.errorLeakage}
                  mode={tp.errorLeakageMode}
                  modes={['mask', 'monitor']}
                  onChange={(on, mode) => set({ errorLeakage: on, errorLeakageMode: mode })}
                />
                <ModeSetting label={tr('Uploads')} help={tr('the files sent to the api')} on={tp.uploads} mode={tp.uploadsMode} modes={['enforce', 'monitor']} onChange={(on, mode) => set({ uploads: on, uploadsMode: mode })} />
                <Setting label={tr('Login guard')} help={tr('credential stuffing on the login paths of the api')}>
                  <Switch checked={tp.login} onChange={(v) => set({ login: v })} />
                  {tp.login && <TagsInput value={tp.loginPaths} onChange={(v) => set({ loginPaths: v })} placeholder={tr('a login path, e.g. /login')} />}
                </Setting>
                <Setting label={tr('API contract')} help={tr('the calls checked against a contract of the extension')}>
                  <Switch checked={tp.apiContract} onChange={(v) => set({ apiContract: v })} />
                  {tp.apiContract && (
                    <>
                      <Select value={tp.apiContractId} onChange={(v) => set({ apiContractId: v })} options={options(c.api_contracts, tr('choose a contract'))} />
                      <Seg
                        value={tp.apiContractMode}
                        onChange={(v) => set({ apiContractMode: v })}
                        options={[
                          { value: 'monitor', label: tr('monitor') },
                          { value: 'enforce', label: tr('enforce') },
                        ]}
                      />
                    </>
                  )}
                </Setting>
              </>
            )}
          </>
        )}
      </Loader>
    </div>
  );
}

function ModeSetting({ label, help, on, mode, modes, onChange }) {
  return (
    <Setting label={label} help={help}>
      <Switch checked={on} onChange={(v) => onChange(v, mode)} />
      {on && <Seg value={mode} onChange={(m) => onChange(on, m)} options={modes.map((m) => ({ value: m, label: tr(m) }))} />}
    </Setting>
  );
}

function ThreatPolicyNotes({ policy }) {
  if (!policy) return null;
  return (
    <>
      <div className="row gap-6">{policy.dry_run && <Badge kind="warning">{tr('dry run')}</Badge>}</div>
      {policy.dry_run && <span className="faint small">{tr('This policy records what it would do and refuses nothing.')}</span>}
      {policy.challenge && (
        <Callout kind="info">{tr('This policy can challenge a caller: a challenge is a page, for a person in a browser.')}</Callout>
      )}
    </>
  );
}
