// One metadata mechanism, one screen: typed fields render the same way whatever their scope.
import React from 'react';
import { Field, Input, NumberInput, Select, Switch, TextArea } from './ui.jsx';

export function MetadataForm({ fields = [], values = {}, onChange, disabled = false, emptyHint = null }) {
  if (!fields.length) return emptyHint;
  const set = (key, v) => {
    const next = { ...(values || {}) };
    if (v === null || v === undefined || v === '') delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <div className="col gap-16">
      {fields.map((f) => {
        const v = values?.[f.key];
        const label = `${f.label}${f.required ? ' *' : ''}`;
        let input;
        switch (f.type) {
          case 'boolean':
            input = <Switch checked={!!v} onChange={(x) => set(f.key, x)} disabled={disabled} label={f.label} />;
            break;
          case 'number':
            input = <NumberInput value={v ?? ''} onChange={(x) => set(f.key, x)} disabled={disabled} aria-label={f.label} />;
            break;
          case 'text':
            input = <TextArea value={v ?? ''} onChange={(x) => set(f.key, x)} rows={3} disabled={disabled} aria-label={f.label} />;
            break;
          case 'enum':
            input = (
              <Select
                value={v ?? ''}
                onChange={(x) => set(f.key, x)}
                disabled={disabled}
                aria-label={f.label}
                options={[{ value: '', label: '—' }, ...(f.options || []).map((o) => ({ value: o, label: o }))]}
              />
            );
            break;
          case 'date':
            input = <Input type="date" value={v ?? ''} onChange={(x) => set(f.key, x)} disabled={disabled} aria-label={f.label} />;
            break;
          default:
            input = <Input type={f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text'} value={v ?? ''} onChange={(x) => set(f.key, x)} disabled={disabled} aria-label={f.label} />;
        }
        return (
          <Field key={f.key} label={f.type === 'boolean' ? null : label} hint={f.help}>
            {input}
          </Field>
        );
      })}
    </div>
  );
}

export function MetadataView({ fields = [], values = {} }) {
  const shown = fields.filter((f) => values?.[f.key] !== undefined);
  const extra = Object.keys(values || {}).filter((k) => !fields.some((f) => f.key === k));
  if (!shown.length && !extra.length) return null;
  return (
    <dl className="kv">
      {shown.map((f) => (
        <React.Fragment key={f.key}>
          <dt>{f.label}</dt>
          <dd>{String(values[f.key])}</dd>
        </React.Fragment>
      ))}
      {extra.map((k) => (
        <React.Fragment key={k}>
          <dt className="mono">{k}</dt>
          <dd>{String(values[k])}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
