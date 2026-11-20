// The content of a page of a declarative document can be a file beside the document, in a language:
// `content: { en: { file: docs/start.en.md } }`. Whoever holds the files reads them — the cli from
// the disk, a remote catalog from its source — from a path relative to the document that stays within
// its source, and inlines them before the document is applied. No dependency: the cli uses it too.

import { badRequest } from '../http/router.js';

export const MAX_PAGE_FILE = 1024 * 1024;

export async function inlinePageFiles(doc, read) {
  for (const page of doc?.spec?.pages || []) {
    for (const [lang, c] of Object.entries(page.content || {})) {
      if (!c || typeof c !== 'object' || !('file' in c)) continue;
      const file = String(c.file || '');
      if (!file || file.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(file) || file.split(/[\\/]/).includes('..'))
        throw badRequest(`page ${page.slug}: the file of its content in ${lang} is a path relative to the document, within its source (${file})`);
      const text = await read(file);
      if (Buffer.byteLength(text) > MAX_PAGE_FILE) throw badRequest(`page ${page.slug}: ${file} is larger than ${MAX_PAGE_FILE / 1024} KB`);
      page.content[lang] = text;
    }
  }
  return doc;
}

// A portal document names files too — its home, its pages, its templates, its style sheet, its
// script as text, its assets as bytes —, read the same way, from paths relative to the document
const ASSET_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', css: 'text/css' };
export const MAX_ASSET_FILE = 2 * 1024 * 1024;

function safe(file, what) {
  const f = String(file || '');
  if (!f || f.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(f) || f.split(/[\\/]/).includes('..')) throw badRequest(`${what}: a path relative to the document, within its source (${f})`);
  return f;
}
const isFile = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'file' in v;

export async function inlinePortalFiles(doc, { readText, readBytes }) {
  const spec = doc?.spec;
  if (!spec || typeof spec !== 'object') return doc;
  const text = async (v, what) => {
    if (!isFile(v)) return v;
    const t = await readText(safe(v.file, what));
    if (Buffer.byteLength(t) > MAX_PAGE_FILE) throw badRequest(`${what}: ${v.file} is larger than ${MAX_PAGE_FILE / 1024} KB`);
    return t;
  };
  const localized = async (o, what) => {
    if (!o || typeof o !== 'object' || isFile(o)) return text(o, what);
    for (const [lang, v] of Object.entries(o)) o[lang] = await text(v, `${what} (${lang})`);
    return o;
  };
  if (spec.home) {
    spec.home.markdown = await localized(spec.home.markdown, 'the home');
    for (const [i, b] of (spec.home.blocks || []).entries()) if (b?.content) b.content = await localized(b.content, `block #${i + 1} of the home`);
  }
  for (const p of spec.pages || []) if (p?.content) p.content = await localized(p.content, `page ${p.slug}`);
  for (const k of Object.keys(spec.templates || {})) spec.templates[k] = await localized(spec.templates[k], `the template ${k}`);
  if (spec.css) spec.css = await text(spec.css, 'the style sheet');
  if (spec.script) spec.script = await text(spec.script, 'the script');
  if (Array.isArray(spec.assets))
    for (const a of spec.assets) {
      if (!isFile(a)) continue;
      const bytes = Buffer.from(await readBytes(safe(a.file, `asset ${a.path}`)));
      if (bytes.length > MAX_ASSET_FILE) throw badRequest(`asset ${a.path}: ${a.file} is larger than ${MAX_ASSET_FILE / 1024 / 1024} MB`);
      const path = a.path || a.file;
      const type = ASSET_EXT[String(path).split('.').pop().toLowerCase()];
      if (!type) throw badRequest(`asset ${path}: an asset is an image, a font or a style sheet`);
      delete a.file;
      Object.assign(a, { path, contentType: type, data: bytes.toString('base64') });
    }
  return doc;
}
