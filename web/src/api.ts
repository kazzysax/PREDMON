import { API_URL } from './env';
import { PREVIEW, mockApi } from './mock';

let getToken: () => string | null = () => null;
export const setTokenGetter = (fn: () => string | null) => { getToken = fn; };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  if (PREVIEW) return mockApi(path, opts) as T;
  const token = getToken();
  const res = await fetch(API_URL + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json as T;
}
