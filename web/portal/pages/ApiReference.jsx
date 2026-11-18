// Scalar renders the OpenAPI document and carries the try-it. It is bundled at a fixed version
// rather than loaded from a CDN, and its requests go through the portal proxy, which only talks to
// the hosts of this workspace's apis and never forwards the portal cookies.
import React, { useEffect, useMemo, useState } from 'react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { tryItProxyUrl } from '../context.jsx';

function useDark() {
  const read = () => document.documentElement.dataset.theme === 'dark';
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export default function ApiReference({ spec }) {
  const dark = useDark();
  const configuration = useMemo(
    () => ({
      content: spec,
      proxyUrl: tryItProxyUrl,
      hideClientButton: true,
      hideDarkModeToggle: true,
      forceDarkModeState: dark ? 'dark' : 'light',
      darkMode: dark,
      // no third-party font nor telemetry at runtime
      withDefaultFonts: false,
      telemetry: false,
      // no hosted AI agent: the portal never sends the spec to a third party
      agent: { disabled: true },
      showDeveloperTools: 'never',
      layout: 'modern',
      hideModels: false,
      defaultOpenAllTags: true,
      customCss: `.scalar-app { --scalar-font: var(--font); --scalar-font-code: var(--mono); }`,
    }),
    [spec, dark]
  );
  return (
    <div className="pt-scalar card">
      <ApiReferenceReact configuration={configuration} />
    </div>
  );
}
