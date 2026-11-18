// Paged lists of the admin api: `?q=` searches, `?limit=` and `?offset=` page, the answer says the
// total so a client can show where it is. { items, total, limit, offset }.
export function pageParams(query, { defaultLimit = 50, max = 500 } = {}) {
  const limit = Math.min(Math.max(parseInt(query.get('limit'), 10) || defaultLimit, 1), max);
  const offset = Math.max(parseInt(query.get('offset'), 10) || 0, 0);
  const q = (query.get('q') || '').trim();
  return { limit, offset, q };
}

// the search pattern of a free text, for ilike (its wildcards escaped)
export const likePattern = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
