#!/usr/bin/env bun
// The texts of the console, translated by web/shared/i18n.jsx — the English text is the key.
//
//   bun scripts/i18n.js wrap <files…>   puts the texts of JSX files in tr() / <Tr>: their text
//                                       children, the props that people read (title, label, help…),
//                                       the strings of those props and of toast(). The source is
//                                       edited in place, around each text, never reformatted.
//   bun scripts/i18n.js check           the texts missing from the dictionaries, the unused ones,
//                                       and the texts of the console left bare — fails on any
//   bun scripts/i18n.js missing         the missing texts, as JSON to fill
//
// Two dictionaries: web/shared/fr.json for the components both faces share, web/backoffice/fr.json
// for the console.

import { parse } from '@babel/parser';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SHARED = join(ROOT, 'web/shared');
const CONSOLE = join(ROOT, 'web/backoffice');
const DICTS = { shared: join(SHARED, 'fr.json'), console: join(CONSOLE, 'fr.json') };

// the props people read; the object keys that carry a text shown (options, confirm dialogs)
const PROPS = new Set(['title', 'placeholder', 'label', 'help', 'hint', 'sub', 'aria-label', 'ariaLabel', 'confirmLabel', 'addLabel', 'addTitle', 'addHelp', 'empty', 'alt', 'message']);
const OBJECT_KEYS = new Set(['label', 'title', 'message', 'confirmLabel', 'hint', 'help', 'placeholder', 'empty', 'sub']);
const CALLS = new Set(['toast']);
// their children are code, not text
const CODE = new Set(['code', 'pre', 'kbd', 'Code', 'CodeView', 'CodeEditor', 'JsonBlock']);
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range']);

const letters = (s) => /[A-Za-zÀ-ÿ]/.test(s);
const q = (s) => {
  const esc = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  return s.includes("'") && !s.includes('"') ? `"${esc}"` : `'${esc.replace(/'/g, "\\'")}'`;
};
const parseJsx = (src) => parse(src, { sourceType: 'module', plugins: ['jsx'] });

// what React renders of a JSX text (babel's cleanJSXElementLiteralChild)
function clean(value) {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  lines.forEach((l, i) => /[^ \t]/.test(l) && (lastNonEmpty = i));
  let out = '';
  lines.forEach((line, i) => {
    let l = line.replace(/\t/g, ' ');
    if (i !== 0) l = l.replace(/^[ ]+/, '');
    if (i !== lines.length - 1) l = l.replace(/[ ]+$/, '');
    if (l) out += i !== lastNonEmpty ? `${l} ` : l;
  });
  return out;
}

const nameOf = (el) => {
  const n = el.openingElement?.name;
  if (!n) return '';
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') return `${n.object.name}.${n.property.name}`;
  return '';
};

// an element shown beside a text, without one of its own: an icon
const decoration = (n) => n.type === 'JSXElement' && n.openingElement.selfClosing && !n.openingElement.attributes.some((a) => a.value?.type === 'StringLiteral' && PROPS.has(a.name?.name));

function splice(src, start, end, edits) {
  let out = '';
  let pos = start;
  for (const e of edits.filter((e) => e.start >= start && e.end <= end).sort((a, b) => a.start - b.start)) {
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + src.slice(pos, end);
}

function make(src) {
  const rewrite = (node, fn = visit) => {
    const edits = [];
    fn(node, edits);
    return splice(src, node.start, node.end, edits);
  };

  function generic(node, edits) {
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && visit(c, edits));
      else if (v && typeof v.type === 'string') visit(v, edits);
    }
  }

  // a value people read: its strings are texts
  function text(expr, edits) {
    if (!expr) return;
    if (expr.type === 'StringLiteral') {
      if (letters(expr.value)) edits.push({ start: expr.start, end: expr.end, text: `tr(${q(expr.value)})` });
      return;
    }
    if (expr.type === 'TemplateLiteral') {
      if (!expr.quasis.some((x) => letters(x.value.cooked))) return generic(expr, edits);
      const tpl = expr.quasis.map((x, i) => x.value.cooked + (i < expr.expressions.length ? `{${i}}` : '')).join('');
      const args = expr.expressions.map((e) => rewrite(e, text));
      edits.push({ start: expr.start, end: expr.end, text: args.length ? `tr(${q(tpl)}, [${args.join(', ')}])` : `tr(${q(tpl)})` });
      return;
    }
    if (expr.type === 'ConditionalExpression') {
      visit(expr.test, edits);
      text(expr.consequent, edits);
      text(expr.alternate, edits);
      return;
    }
    if (expr.type === 'LogicalExpression') {
      visit(expr.left, edits);
      text(expr.right, edits);
      return;
    }
    visit(expr, edits);
  }

  function children(list, edits) {
    const meaningful = list.filter((c) => !(c.type === 'JSXText' && !clean(c.value)) && !(c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXEmptyExpression'));
    const isSpace = (c) => c.type === 'JSXExpressionContainer' && c.expression.type === 'StringLiteral' && !letters(c.expression.value);
    const isText = (c) => (c.type === 'JSXText' && letters(clean(c.value))) || (c.type === 'JSXExpressionContainer' && c.expression.type === 'StringLiteral' && letters(c.expression.value));
    if (!meaningful.some(isText)) {
      for (const c of meaningful) c.type === 'JSXExpressionContainer' ? text(c.expression, edits) : visit(c, edits);
      return;
    }
    let from = 0;
    let to = meaningful.length;
    while (from < to && decoration(meaningful[from])) visit(meaningful[from++], edits);
    while (to > from && decoration(meaningful[to - 1])) visit(meaningful[--to], edits);
    const parts = meaningful.slice(from, to);
    let tpl = '';
    const args = [];
    for (const c of parts) {
      if (c.type === 'JSXText') tpl += clean(c.value);
      else if (isSpace(c) || isText(c)) tpl += c.expression.value;
      else {
        tpl += `{${args.length}}`;
        args.push(c.type === 'JSXExpressionContainer' ? rewrite(c.expression, text) : rewrite(c));
      }
    }
    const key = tpl.trim();
    // the whitespace around stays as written: what it renders does not change, nor the layout
    const first = parts[0];
    const last = parts[parts.length - 1];
    const lead = first.type === 'JSXText' ? first.value.match(/^\s*/)[0] : /^\s/.test(tpl) ? "{' '}" : '';
    const trail = last.type === 'JSXText' ? last.value.match(/\s*$/)[0] : /\s$/.test(tpl) ? "{' '}" : '';
    const start = parts[0].start;
    const end = parts[parts.length - 1].end;
    const body = args.length ? `<Tr text={${q(key)}} args={[${args.join(', ')}]} />` : `{tr(${q(key)})}`;
    edits.push({ start, end, text: `${lead}${body}${trail}` });
  }

  function visit(node, edits) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'JSXElement': {
        for (const a of node.openingElement.attributes) {
          if (a.type !== 'JSXAttribute') {
            visit(a, edits);
            continue;
          }
          const name = typeof a.name.name === 'string' ? a.name.name : '';
          if (PROPS.has(name) && a.value?.type === 'StringLiteral') {
            if (letters(a.value.value)) edits.push({ start: a.value.start, end: a.value.end, text: `{tr(${q(a.value.value)})}` });
          } else if (PROPS.has(name) && a.value?.type === 'JSXExpressionContainer') text(a.value.expression, edits);
          else if (a.value) visit(a.value, edits);
        }
        if (!CODE.has(nameOf(node))) children(node.children, edits);
        return;
      }
      case 'JSXFragment':
        children(node.children, edits);
        return;
      case 'CallExpression':
        if (node.callee.type === 'Identifier' && CALLS.has(node.callee.name) && node.arguments[0]) {
          text(node.arguments[0], edits);
          node.arguments.slice(1).forEach((a) => visit(a, edits));
          visit(node.callee, edits);
          return;
        }
        // already translated
        if (node.callee.type === 'Identifier' && node.callee.name === 'tr') return;
        return generic(node, edits);
      case 'ObjectProperty': {
        const key = node.key.type === 'Identifier' ? node.key.name : node.key.type === 'StringLiteral' ? node.key.value : '';
        if (!node.computed && OBJECT_KEYS.has(key)) return text(node.value, edits);
        return generic(node, edits);
      }
      case 'ImportDeclaration':
        return;
      default:
        return generic(node, edits);
    }
  }
  return { visit };
}

function wrapFile(file) {
  const src = readFileSync(file, 'utf8');
  if (file.endsWith('i18n.jsx')) return false;
  const ast = parseJsx(src);
  const edits = [];
  make(src).visit(ast.program, edits);
  if (!edits.length) return false;
  let out = splice(src, 0, src.length, edits);
  const uses = ['tr', 'Tr'].filter((n) => edits.some((e) => (n === 'tr' ? /\btr\(/ : /<Tr\b/).test(e.text)));
  if (!/from '[./]*\/?(shared\/)?i18n\.jsx'/.test(src)) {
    let path = relative(dirname(file), join(SHARED, 'i18n.jsx'));
    if (!path.startsWith('.')) path = `./${path}`;
    const imports = ast.program.body.filter((n) => n.type === 'ImportDeclaration');
    const at = imports.length ? imports[imports.length - 1].end : 0;
    const line = `import { ${uses.join(', ')} } from '${path}';`;
    // offsets moved: find the end of the last import in the new source
    const shift = edits.filter((e) => e.end <= at).reduce((d, e) => d + e.text.length - (e.end - e.start), 0);
    out = imports.length ? `${out.slice(0, at + shift)}\n${line}${out.slice(at + shift)}` : `${line}\n${out}`;
  }
  writeFileSync(file, out);
  return edits.length;
}

// ---------------------------------------------------------------- check

function files(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.jsx?$/.test(f) && !f.includes('monaco-setup')) out.push(p);
  }
  return out;
}

function keysOf(file) {
  const src = readFileSync(file, 'utf8');
  const keys = new Set();
  const bare = [];
  const walk = (n, inCode = false) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'tr' && n.arguments[0]?.type === 'StringLiteral') keys.add(n.arguments[0].value);
    if (n.type === 'JSXElement' && nameOf(n) === 'Tr') {
      const a = n.openingElement.attributes.find((x) => x.name?.name === 'text');
      const v = a?.value?.type === 'StringLiteral' ? a.value.value : a?.value?.expression?.type === 'StringLiteral' ? a.value.expression.value : null;
      if (v) keys.add(v);
    }
    const code = inCode || (n.type === 'JSXElement' && CODE.has(nameOf(n)));
    if (n.type === 'JSXText' && !inCode && letters(clean(n.value))) bare.push(`${relative(ROOT, file)}:${n.loc.start.line} ${clean(n.value).trim().slice(0, 60)}`);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'extra') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, code));
      else if (v && typeof v.type === 'string') walk(v, code);
    }
  };
  walk(parseJsx(src).program);
  return { keys, bare };
}

function survey() {
  const scope = { shared: files(SHARED), console: files(CONSOLE) };
  const out = {};
  for (const [name, list] of Object.entries(scope)) {
    const keys = new Set();
    const bare = [];
    for (const f of list) {
      const r = keysOf(f);
      r.keys.forEach((k) => keys.add(k));
      bare.push(...r.bare);
    }
    const dict = existsSync(DICTS[name]) ? JSON.parse(readFileSync(DICTS[name], 'utf8')) : {};
    out[name] = { keys, bare, dict };
  }
  // a text of the console found in the shared dictionary needs nothing more
  for (const k of out.console.keys) if (out.shared.dict[k] !== undefined) out.console.keys.delete(k);
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'wrap') {
  for (const f of rest) {
    const n = wrapFile(f);
    if (n) console.log(`${relative(ROOT, f)}: ${n} texts`);
  }
} else if (cmd === 'check' || cmd === 'missing') {
  const s = survey();
  let failed = false;
  const missing = {};
  for (const [name, { keys, bare, dict }] of Object.entries(s)) {
    const miss = [...keys].filter((k) => !dict[k]);
    const unused = Object.keys(dict).filter((k) => !keys.has(k) && !(name === 'shared' && s.console.keys.has(k)));
    if (cmd === 'missing') {
      missing[name] = Object.fromEntries(miss.map((k) => [k, '']));
      continue;
    }
    console.log(`${name}: ${keys.size} texts, ${miss.length} without French, ${bare.length} left bare (${unused.length} more translated at run time)`);
    miss.slice(0, 20).forEach((k) => console.log(`  missing: ${k}`));
    // the values shown as such (statuses, roles) are translated at run time: unused here, not missing
    if (rest.includes('--verbose')) unused.forEach((k) => console.log(`  unused: ${k}`));
    bare.slice(0, 40).forEach((b) => console.log(`  bare: ${b}`));
    if (miss.length || bare.length) failed = true;
  }
  if (cmd === 'missing') console.log(JSON.stringify(missing, null, 2));
  process.exit(failed ? 1 : 0);
} else {
  console.log('usage: bun scripts/i18n.js wrap <files…> | check | missing');
  process.exit(2);
}
