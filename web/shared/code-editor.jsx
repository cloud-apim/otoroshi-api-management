// The code editor of the console (json, yaml). Monaco is heavy: it is loaded on first use, in its
// own chunk, so the pages that do not edit code never download it.
import React, { Suspense, lazy } from 'react';

const MonacoEditor = lazy(() => import('./monaco-editor.jsx'));

export function CodeEditor(props) {
  const { minHeight = 120 } = props;
  return (
    <Suspense fallback={<div className="code-editor loading" style={{ height: minHeight }} aria-busy="true" />}>
      <MonacoEditor {...props} />
    </Suspense>
  );
}

// json when it looks like json, yaml otherwise
export const codeLanguage = (text) => (/^\s*[[{]/.test(text || '') ? 'json' : 'yaml');
