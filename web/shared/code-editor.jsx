// The code editor of the console (json, yaml). Monaco is heavy: it is loaded on first use, in its
// own chunk, so the pages that do not edit code never download it.
import React, { Suspense, lazy } from 'react';
import { CopyButton } from './ui.jsx';

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

// a read-only view of a document (json by default): folding, search, copy
export function CodeView({ value, language, minHeight = 60, maxHeight = 560, ariaLabel }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return (
    <div className="copy code-view">
      <CodeEditor value={text} language={language || (typeof value === 'string' ? codeLanguage(text) : 'json')} readOnly minHeight={minHeight} maxHeight={maxHeight} ariaLabel={ariaLabel} />
      <div className="copy-btn">
        <CopyButton text={text} className="btn xs ghost" />
      </div>
    </div>
  );
}
