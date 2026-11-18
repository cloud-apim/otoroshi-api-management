import React, { createContext, useContext, useEffect, useState } from 'react';
import { client } from '../shared/lib.js';

// the console consumes the very admin api the CLI uses, through its session
export const api = client('/backoffice/api');

export const SessionCtx = createContext(null);
export function useSession() {
  return useContext(SessionCtx);
}

// workspace-scoped api helper
export function wsApi(ws) {
  const p = `/workspaces/${ws}`;
  return {
    get: (path) => api.get(`${p}${path}`),
    post: (path, body) => api.post(`${p}${path}`, body),
    put: (path, body) => api.put(`${p}${path}`, body),
    del: (path) => api.del(`${p}${path}`),
  };
}

export function useWs() {
  const s = useSession();
  return { ws: s.workspace, slug: s.workspace?.slug, wapi: wsApi(s.workspace?.slug), session: s };
}

// the typed metadata fields of a scope
export function useMetadataFields(scope) {
  const { wapi, slug } = useWs();
  const [fields, setFields] = useState([]);
  useEffect(() => {
    if (!slug) return;
    wapi.get(`/metadata-fields?scope=${scope}`).then(setFields).catch(() => setFields([]));
  }, [slug, scope]);
  return fields;
}
