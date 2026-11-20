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
