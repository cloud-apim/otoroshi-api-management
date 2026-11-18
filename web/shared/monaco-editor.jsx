// Monaco, the editor of Otoroshi's own ui — bundled with the console, never fetched from a cdn,
// and themed from the css tokens so it follows the light / dark theme of the page.
import React, { useEffect, useRef } from 'react';
import * as monaco from './monaco-setup.js';
import EditorWorker from '@monaco/editor/editor.worker.js?worker';
import JsonWorker from '@monaco/language/json/json.worker.js?worker';

globalThis.MonacoEnvironment = {
  getWorker: (_, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
};

// Monaco only takes #rrggbb / #rrggbbaa, and the css minifier shortens the tokens (#ffffff → #fff)
function longHex(value) {
  const v = value.trim();
  if (/^#[0-9a-f]{3,4}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return v;
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = '#000000';
  probe.fillStyle = v;
  return longHex(probe.fillStyle.startsWith('#') ? probe.fillStyle : '#000000');
}
const css = (name) => longHex(getComputedStyle(document.documentElement).getPropertyValue(name) || '#000000');
const fg = (name) => css(name).slice(1, 7);
const mono = () => getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();

function applyTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  monaco.editor.defineTheme('apim', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'delimiter', foreground: fg('--ink') },
      { token: 'string.key.json', foreground: fg('--accent-text') },
      { token: 'string.value.json', foreground: fg('--positive-text') },
      { token: 'number', foreground: fg('--warning-text') },
      { token: 'keyword', foreground: fg('--negative-text') },
      { token: 'type', foreground: fg('--accent-text') },
      { token: 'string', foreground: fg('--positive-text') },
      // markdown: headings and list marks are keywords there, not errors
      { token: 'keyword.md', foreground: fg('--accent-text'), fontStyle: 'bold' },
      { token: 'strong.md', fontStyle: 'bold' },
      { token: 'emphasis.md', fontStyle: 'italic' },
      { token: 'string.link.md', foreground: fg('--accent-text') },
      { token: 'variable.md', foreground: fg('--warning-text') },
      { token: 'variable.source.md', foreground: fg('--warning-text') },
    ],
    colors: {
      'editor.background': css('--surface'),
      'editor.foreground': css('--ink'),
      'editorGutter.background': css('--surface'),
      'editorLineNumber.foreground': css('--faint'),
      'editorLineNumber.activeForeground': css('--muted'),
      'editor.lineHighlightBackground': css('--hover'),
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': css('--accent-border'),
      'editor.inactiveSelectionBackground': css('--accent-subtle'),
      'editorIndentGuide.background1': css('--border'),
      'editorIndentGuide.activeBackground1': css('--border-strong'),
      'editorWidget.background': css('--surface-2'),
      'editorWidget.border': css('--border-strong'),
      'editorHoverWidget.background': css('--surface-2'),
      'editorHoverWidget.border': css('--border-strong'),
      'scrollbarSlider.background': css('--selected'),
      'scrollbarSlider.hoverBackground': css('--border-strong'),
      // brackets in the text color: the console's palette has no rainbow
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`editorBracketHighlight.foreground${n}`, css('--ink')])),
      'editorBracketHighlight.unexpectedBracket.foreground': css('--negative-text'),
      focusBorder: '#00000000',
    },
  });
  monaco.editor.setTheme('apim');
}

export default function MonacoEditor({ value, onChange, language = 'json', readOnly = false, minHeight = 120, maxHeight = 480, wordWrap = 'off', placeholder, ariaLabel }) {
  const host = useRef(null);
  const editorRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    applyTheme();
    const editor = monaco.editor.create(host.current, {
      value: value ?? '',
      language,
      readOnly,
      theme: 'apim',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: mono(),
      fontSize: 12.5,
      lineHeight: 19,
      tabSize: 2,
      lineNumbersMinChars: 3,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      stickyScroll: { enabled: false },
      guides: { bracketPairs: false },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
      padding: { top: 8, bottom: 8 },
      fixedOverflowWidgets: true,
      formatOnPaste: true,
      wordWrap,
      placeholder,
      ariaLabel,
    });
    editorRef.current = editor;
    const changes = editor.onDidChangeModelContent(() => onChangeRef.current?.(editor.getValue()));
    // grows with its content, between minHeight and maxHeight
    let height = 0;
    const fit = () => {
      const next = Math.min(maxHeight, Math.max(minHeight, editor.getContentHeight()));
      if (next === height) return;
      height = next;
      host.current.style.height = `${next}px`;
      editor.layout();
    };
    const sizes = editor.onDidContentSizeChange(fit);
    fit();
    const themes = new MutationObserver(applyTheme);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      changes.dispose();
      sizes.dispose();
      themes.disconnect();
      editor.getModel()?.dispose();
      editor.dispose();
    };
  }, []);

  // a value changed from outside (reset to the default configuration, another plugin picked…)
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && (value ?? '') !== editor.getValue()) editor.setValue(value ?? '');
  }, [value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({ readOnly });
    monaco.editor.setModelLanguage(editor.getModel(), language);
  }, [readOnly, language]);

  return <div ref={host} className="code-editor" style={{ height: minHeight }} />;
}
