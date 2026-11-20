// Portal runtime: the workspace is resolved from the url by the server and injected as
// window.__APIM__; every call goes to <base>/front/api.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { client } from '../shared/lib.js';
import { applyDesign } from './design.jsx';
import { pickLang } from './i18n.jsx';

export const runtime = window.__APIM__ || { workspace: 'default', base: '', exposure: 'path' };
export const api = client(`${runtime.base}/front/api`);
export const testProxyUrl = `${window.location.origin}${runtime.base}/front/api/test`;

const PortalCtx = createContext(null);

// a preview of the draft of the design: the link of the console carries a token, kept for the
// navigation within the portal (this tab only)
function previewToken() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('preview');
    if (fromUrl) sessionStorage.setItem('apim.portal.preview', fromUrl);
    return fromUrl || sessionStorage.getItem('apim.portal.preview') || null;
  } catch {
    return null;
  }
}
export const preview = previewToken();

export function PortalProvider({ children }) {
  const [state, setState] = useState({ loading: true, error: null, portal: null, workspace: null, user: null });
  const reload = useCallback(async () => {
    try {
      const data = await api.get(`/portal${preview ? `?preview=${encodeURIComponent(preview)}` : ''}`);
      setState({ loading: false, error: null, ...data });
      applyDesign(data.design, { preview: data.design?.preview ? preview : null });
      const title = pickLang(data.design?.texts?.title, document.documentElement.lang, data.portal?.defaultLanguage);
      if (title) document.title = title;
      return data;
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error }));
      return null;
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  const signOut = useCallback(async () => {
    await api.post('/auth/logout').catch(() => null);
    await reload();
  }, [reload]);
  return <PortalCtx.Provider value={{ ...state, reload, signOut }}>{children}</PortalCtx.Provider>;
}

export function usePortal() {
  return useContext(PortalCtx);
}

