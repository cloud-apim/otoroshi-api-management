// A structural diff between two JSON documents. Arrays of objects carrying an `id` are matched by
// id, so that reordering or editing one plan reads as one change, not as N.

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function byId(arr) {
  return arr.every((x) => isObj(x) && typeof x.id === 'string');
}

export function diff(before, after, path = '', out = []) {
  if (before === after) return out;
  if (Array.isArray(before) && Array.isArray(after) && byId(before) && byId(after)) {
    const b = new Map(before.map((x) => [x.id, x]));
    const a = new Map(after.map((x) => [x.id, x]));
    for (const [id, v] of b) {
      const label = `${path}[${v.name ? `${v.name}` : id}]`;
      if (!a.has(id)) out.push({ op: 'remove', path: label, before: v });
      else diff(v, a.get(id), label, out);
    }
    for (const [id, v] of a) {
      if (!b.has(id)) out.push({ op: 'add', path: `${path}[${v.name ? `${v.name}` : id}]`, after: v });
    }
    return out;
  }
  // arrays of the same length without ids: compare element by element, so that one changed field
  // in a plugin list reads as one change rather than the whole list
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length && before.some((x) => isObj(x))) {
    before.forEach((b, i) => diff(b, after[i], `${path}[${i}]`, out));
    return out;
  }
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in after)) out.push({ op: 'remove', path: p, before: before[k] });
      else if (!(k in before)) out.push({ op: 'add', path: p, after: after[k] });
      else diff(before[k], after[k], p, out);
    }
    return out;
  }
  // postgres jsonb does not keep key order: compare a canonical form
  if (stable(before) !== stable(after)) {
    if (before === undefined) out.push({ op: 'add', path, after });
    else if (after === undefined) out.push({ op: 'remove', path, before });
    else out.push({ op: 'change', path, before, after });
  }
  return out;
}
