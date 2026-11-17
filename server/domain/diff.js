// A structural diff between two JSON documents. Arrays of objects carrying an `id` are matched by
// id, so that reordering or editing one plan reads as one change, not as N.

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    if (before === undefined) out.push({ op: 'add', path, after });
    else if (after === undefined) out.push({ op: 'remove', path, before });
    else out.push({ op: 'change', path, before, after });
  }
  return out;
}
