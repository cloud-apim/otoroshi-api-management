// Portal runtime: the workspace is resolved from the url by the server and injected as
// window.__APIM__; every call goes to <base>/front/api.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { client } from '../shared/lib.js';

export const runtime = window.__APIM__ || { workspace: 'default', base: '', exposure: 'path' };
export const api = client(`${runtime.base}/front/api`);
export const testProxyUrl = `${window.location.origin}${runtime.base}/front/api/test`;

const PortalCtx = createContext(null);

export function PortalProvider({ children }) {
  const [state, setState] = useState({ loading: true, error: null, portal: null, workspace: null, user: null });
  const reload = useCallback(async () => {
    try {
      const data = await api.get('/portal');
      setState({ loading: false, error: null, ...data });
      applyBrand(data.portal);
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

// the portal carries the visual identity of its organisation
function applyBrand(portal) {
  const root = document.documentElement;
  if (portal?.accentColor && /^#[0-9a-f]{3,8}$/i.test(portal.accentColor)) {
    root.style.setProperty('--brand', portal.accentColor);
    root.dataset.brand = 'on';
  } else {
    root.style.removeProperty('--brand');
    delete root.dataset.brand;
  }
  const title = portal?.title && typeof portal.title === 'object' ? portal.title[portal.defaultLanguage] || Object.values(portal.title)[0] : portal?.title;
  if (title) document.title = title;
}
