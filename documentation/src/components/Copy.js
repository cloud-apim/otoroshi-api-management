// A value to type in a form, with a button that copies it: <Copy>shipments.oto.tools</Copy>
import React, { useState } from 'react';

export default function Copy({ children, value }) {
  const text = value ?? React.Children.toArray(children).join('');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no clipboard (an insecure origin): the value stays selectable
    }
  };
  return (
    <span className="copy-value">
      <code>{text}</code>
      <button type="button" onClick={copy} aria-label={copied ? 'Copied' : `Copy ${text}`} title={copied ? 'Copied' : 'Copy'}>
        {copied ? (
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        )}
      </button>
    </span>
  );
}
