// A plugin configuration as a form, generated from the form description the gateway's catalog
// carries (`config_schema` / `config_flow`, what Otoroshi's own ui renders). The json stays the
// truth: the form edits the fields the description lists, keeps every other key as is, and never
// changes the type of a value already there (the descriptions are sometimes looser than the
// plugins: a field described as a string can hold a number).
import React, { useState } from 'react';
import { Badge, Field, Icon, Input, NumberInput, Select, Switch, TagsInput } from '../../../shared/ui.jsx';
import { CodeEditor } from '../../../shared/code-editor.jsx';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function humanize(key, label) {
  if (label && label !== key) return label;
  const s = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// the fields of a description, in the order of its flow, then the others
export function formFields(schema, flow) {
  const keys = Object.keys(schema || {}).filter((k) => isObject(schema[k]));
  const ordered = (flow || []).filter((k) => typeof k === 'string' && keys.includes(k));
  return [...new Set([...ordered, ...keys])];
}

function optionsOf(spec) {
  const raw = spec.possibleValues || spec.props?.possibleValues || spec.options || spec.props?.options;
  if (!Array.isArray(raw)) return null;
  return raw.map((o) => (isObject(o) ? { value: o.value, label: o.label ?? String(o.value) } : { value: o, label: String(o) }));
}

function kindOf(spec, value) {
  const t = spec.type;
  if (t === 'select' && optionsOf(spec)) return 'select';
  // a value already there decides over a looser description
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'number';
  if (t === 'bool' || t === 'boolean') return 'bool';
  if (t === 'number') return 'number';
  if (t === 'array' && spec.format === 'form' && isObject(spec.schema)) return Array.isArray(value) || value == null ? 'forms' : 'json';
  if (t === 'array' || t === 'array-select') return value == null || (Array.isArray(value) && value.every((x) => typeof x === 'string')) ? 'strings' : 'json';
  if (t === 'object') return value == null || (isObject(value) && Object.values(value).every((x) => typeof x === 'string')) ? 'map' : 'json';
  if (t === 'form' && isObject(spec.schema)) return value == null || isObject(value) ? 'form' : 'json';
  if (t === 'string' || t === 'select') return value == null || typeof value === 'string' ? 'string' : 'json';
  return 'json'; // code, json, any, and anything unknown
}

export function PluginForm({ schema, flow, value, onChange }) {
  const v = isObject(value) ? value : {};
  return (
    <div className="col gap-16">
      {formFields(schema, flow).map((k) => (
        <SchemaField key={k} name={k} spec={schema[k]} value={v[k]} onChange={(x) => onChange({ ...v, [k]: x })} />
      ))}
    </div>
  );
}

function SchemaField({ name, spec, value, onChange }) {
  const label = humanize(name, spec.label || spec.props?.label);
  const hint = spec.help || spec.props?.help || spec.props?.subTitle || null;
  const placeholder = spec.props?.placeholder || spec.placeholder || '';
  const kind = kindOf(spec, value);
  if (kind === 'bool')
    return (
      <div className="col gap-4">
        <Switch checked={!!value} onChange={onChange} label={label} />
        {hint && <div className="hint">{hint}</div>}
      </div>
    );
  if (kind === 'number')
    return (
      <Field label={label} hint={hint}>
        <div className="row">
          <div className="grow">
            <NumberInput value={value} onChange={onChange} placeholder={placeholder} aria-label={label} />
          </div>
          {spec.props?.suffix && <span className="muted small">{spec.props.suffix}</span>}
        </div>
      </Field>
    );
  if (kind === 'select') {
    const options = optionsOf(spec);
    const index = options.findIndex((o) => o.value === value);
    return (
      <Field label={label} hint={hint}>
        <Select
          value={index < 0 ? '' : String(index)}
          onChange={(i) => onChange(i === '' ? null : options[Number(i)].value)}
          options={[{ value: '', label: '—' }, ...options.map((o, i) => ({ value: String(i), label: o.label }))]}
          aria-label={label}
        />
      </Field>
    );
  }
  if (kind === 'string')
    return (
      <Field label={label} hint={spec.props?.optionsFrom ? hint || 'an id of an entity of the gateway' : hint}>
        <Input value={value ?? ''} onChange={(x) => onChange(x === '' && value == null ? null : x)} placeholder={placeholder} aria-label={label} />
      </Field>
    );
  if (kind === 'strings')
    return (
      <Field label={label} hint={hint}>
        <TagsInput value={value || []} onChange={onChange} placeholder={placeholder || 'add and press enter'} />
      </Field>
    );
  if (kind === 'map') return <MapField label={label} hint={hint} value={value} onChange={onChange} />;
  if (kind === 'form') return <FormGroup label={label} hint={hint} spec={spec} value={value} onChange={onChange} />;
  if (kind === 'forms') return <FormList label={label} hint={hint} spec={spec} value={value} onChange={onChange} />;
  return <JsonField label={label} hint={hint} value={value} onChange={onChange} />;
}

// a map of strings (headers, users…): ordered rows, an empty name is not written
function MapField({ label, hint, value, onChange }) {
  const [rows, setRows] = useState(() => Object.entries(isObject(value) ? value : {}));
  const write = (next) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([k]) => k.trim() !== '')));
  };
  return (
    <Field label={label} hint={hint}>
      <div className="col gap-6">
        {rows.map(([k, v], i) => (
          <div key={i} className="row">
            <div className="grow">
              <Input value={k} onChange={(x) => write(rows.map((r, j) => (j === i ? [x, r[1]] : r)))} placeholder="name" mono aria-label={`${label} name`} />
            </div>
            <div className="grow">
              <Input value={v} onChange={(x) => write(rows.map((r, j) => (j === i ? [r[0], x] : r)))} placeholder="value" mono aria-label={`${label} value`} />
            </div>
            <button type="button" className="btn ghost sm icon" onClick={() => write(rows.filter((_, j) => j !== i))} aria-label="remove">
              <Icon name="x" />
            </button>
          </div>
        ))}
        <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setRows([...rows, ['', '']])}>
          <Icon name="plus" /> entry
        </button>
      </div>
    </Field>
  );
}

function FormGroup({ label, hint, spec, value, onChange }) {
  const [open, setOpen] = useState(!spec.collapsed);
  const count = isObject(value) ? Object.values(value).filter((x) => x !== null && x !== undefined && x !== '' && !(Array.isArray(x) && !x.length)).length : 0;
  return (
    <div className="panel col gap-16">
      <button type="button" className="row plain-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'up' : 'down'} />
        <span className="bold small grow" style={{ textAlign: 'left' }}>
          {label}
        </span>
        {!open && count > 0 && <Badge>{count} set</Badge>}
      </button>
      {hint && <div className="hint">{hint}</div>}
      {open && <PluginForm schema={spec.schema} flow={spec.flow} value={value} onChange={onChange} />}
    </div>
  );
}

function FormList({ label, hint, spec, value, onChange }) {
  const items = Array.isArray(value) ? value : [];
  return (
    <Field label={label} hint={hint}>
      <div className="col gap-6">
        {items.map((item, i) => (
          <div key={i} className="panel col gap-16">
            <div className="row">
              <span className="bold small grow">#{i + 1}</span>
              <button type="button" className="btn ghost sm icon" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="remove">
                <Icon name="trash" />
              </button>
            </div>
            <PluginForm schema={spec.schema} flow={spec.flow} value={item} onChange={(x) => onChange(items.map((y, j) => (j === i ? x : y)))} />
          </div>
        ))}
        <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...items, {}])}>
          <Icon name="plus" /> {label.toLowerCase()}
        </button>
      </div>
    </Field>
  );
}

// free json (code, any, or a value the description does not match): its own small editor;
// a text value stays a text value
function JsonField({ label, hint, value, onChange }) {
  const isText = typeof value === 'string';
  const [text, setText] = useState(() => (isText ? value : value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [error, setError] = useState(null);
  const change = (t) => {
    setText(t);
    if (isText) return onChange(t);
    try {
      onChange(t.trim() ? JSON.parse(t) : null);
      setError(null);
    } catch (e) {
      setError('invalid json — the configuration keeps the last valid value');
    }
  };
  return (
    <Field label={label} hint={hint} error={error}>
      <CodeEditor value={text} onChange={change} language={isText ? 'plaintext' : 'json'} minHeight={60} maxHeight={240} ariaLabel={label} />
    </Field>
  );
}
