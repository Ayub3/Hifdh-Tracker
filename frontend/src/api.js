const WORKSPACE_KEY = 'hifdh-anonymous-workspace-key-v1';

export function getWorkspaceKey() {
  let key;
  try {
    key = localStorage.getItem(WORKSPACE_KEY);
    if (!/^[0-9a-f]{64}$/.test(key || '')) {
      key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(WORKSPACE_KEY, key);
    }
  } catch {
    throw new Error('Allow browser storage to open your workspace.');
  }
  return key;
}

export function createApi(baseUrl, fetcher = (...args) => fetch(...args)) {
  return async function api(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('X-Workspace-Key', getWorkspaceKey());
    if (options.body) headers.set('Content-Type', 'application/json');
    let response;
    try {
      response = await fetcher(`${baseUrl.replace(/\/$/, '')}${path}`, { ...options, headers, cache: 'no-store' });
    } catch {
      throw new Error('Could not reach the API. Check your connection and try again.');
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(typeof data?.detail === 'string' ? data.detail : 'The request failed. Check your details and try again.');
    }
    if (data === null) throw new Error('The API returned an unexpected response. Check the API URL.');
    return data;
  };
}

export const api = createApi(import.meta.env?.VITE_API_URL || 'http://localhost:8000');

export async function listAll(path, { signal } = {}) {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const page = await api(`${path}?limit=100&offset=${offset}`, { signal });
    items.push(...page);
    if (page.length < 100) return items;
  }
}
