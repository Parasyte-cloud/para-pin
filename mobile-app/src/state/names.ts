// Small in-memory display-name cache for rendering "who sent this" in
// group chats, mirroring index.html's userNameCache/ensureNamesLoaded
// (index.html:4018-4033). Not a Zustand store — nothing needs to
// re-render reactively off this, callers just await resolveNames() before
// rendering.

import { apiFetch } from '../api/client';

const cache = new Map<string, string>();

export async function resolveNames(ids: string[]): Promise<Record<string, string>> {
  const needed = [...new Set(ids)].filter((id) => id && !cache.has(id));
  if (needed.length) {
    const res = await apiFetch<{ users?: Array<{ id: string; displayName?: string }> }>(
      `/users?ids=${encodeURIComponent(needed.join(','))}`
    );
    if (res.ok && res.body.users) {
      for (const u of res.body.users) cache.set(u.id, u.displayName || 'PArA PIN user');
    }
    for (const id of needed) if (!cache.has(id)) cache.set(id, 'PArA PIN user');
  }
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = cache.get(id) || 'PArA PIN user';
  return out;
}

export function getCachedName(userId: string): string | null {
  return cache.get(userId) || null;
}
