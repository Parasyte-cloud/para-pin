// Mirrors index.html's apiFetch() (index.html:3148) as closely as possible
// so behavior stays predictable to anyone who's worked on the web client:
// same '/api' prefix, same X-Para-Pin-Hash auth header, same
// {ok, status, body} result shape instead of throwing on non-2xx.

import Constants from 'expo-constants';
// Circular import with state/session.ts (it calls apiFetch, this reads its
// store) — safe here because both usages are inside function bodies that
// only run after both modules have finished evaluating, never at
// module-load time. Metro/ES modules resolve this via live bindings.
import { useSessionStore } from '../state/session';
import type { ApiErrorBody, ApiResult } from '../types';

// EAS build profiles set EXPO_PUBLIC_API_BASE_URL (see eas.json); falls
// back to the production host for local `expo start` dev too, since this
// app talks to chat.parasyte.cloud's real backend even in dev — there's no
// separate staging API to point at yet.
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ||
  'https://chat.parasyte.cloud';

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: string | FormData | Blob;
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiFetchOptions = {}
): Promise<ApiResult<T>> {
  const { headers: optHeaders, ...rest } = opts;
  const pinHash = useSessionStore.getState().pinHash;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(optHeaders as Record<string, string> | undefined),
  };
  // Only fill in from the stored session pinHash if the caller didn't
  // already set the header explicitly — submitPin/unlockWithPin do, with
  // their freshly computed hash, since the store doesn't have it yet
  // (submitPin is establishing a brand-new credential; unlockWithPin is
  // re-entering with a just-typed one). There used to be a `skipAuth` flag
  // here that just omitted the header entirely for those two calls instead
  // — worker.js's authHash() (worker.js:830) only ever reads this header
  // or a ?pinHash= query param, never the request body, so skipping the
  // header meant the server rejected every one of those calls with a 401
  // before the body's pinHash was ever looked at. Removed; explicit
  // per-call headers now, same as any other option in opts.
  if (pinHash && !headers['X-Para-Pin-Hash']) headers['X-Para-Pin-Hash'] = pinHash;

  let res: Response;
  try {
    res = await fetch(API_BASE_URL + '/api' + path, { ...rest, headers });
  } catch (e) {
    return { ok: false, status: 0, body: null, networkError: true };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No/invalid JSON body — leave body null, still report status/ok.
  }

  if (res.ok) {
    return { ok: true, status: res.status, body: body as T };
  }
  return { ok: false, status: res.status, body: body as ApiErrorBody | null };
}

// WebSocket URLs can't carry custom headers, so auth goes via query param
// on the socket path instead (matches worker.js:831's fallback and
// index.html:9887's `?pinHash=` pattern for the chat/notify/meeting sockets).
export function wsUrl(path: string, params: Record<string, string> = {}): string {
  const pinHash = useSessionStore.getState().pinHash;
  const base = API_BASE_URL.replace(/^http/, 'ws');
  const search = new URLSearchParams({ ...(pinHash ? { pinHash } : {}), ...params });
  return `${base}/api${path}?${search.toString()}`;
}
