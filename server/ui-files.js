// The files of the two faces — the console and the portal: read from dist/ on disk, or, in the
// compiled binary, from the files embedded in it (scripts/build-binary.js registers them).

import { join } from 'node:path';

const DIST = join(import.meta.dir, '..', 'dist');
let embedded = null;

// { 'backoffice/index.html': <path of the embedded file>, … }
export function embedUi(files) {
  embedded = files;
}

export const isEmbedded = () => !!embedded;

// a file of a face, or null when there is none
export async function uiFile(face, relPath) {
  if (embedded) {
    const path = embedded[`${face}/${relPath}`];
    return path ? Bun.file(path) : null;
  }
  const file = Bun.file(join(DIST, face, relPath));
  return (await file.exists()) ? file : null;
}
