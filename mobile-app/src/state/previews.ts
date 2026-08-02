// Chat-list preview text — decrypts POST /session's per-chat
// `summaries[id].lastMessage` (worker.js:1972-1981, always returned, just
// never read on mobile before now — see the comment on
// SessionResponse['summaries'] in ../types.ts) the same way
// state/messages.ts decrypts full chat history, mirrors web's
// lastMsg()/previewText() (index.html:4054-4075).
//
// Small in-memory cache, same non-reactive-Map pattern as state/names.ts —
// callers re-render off a version bump they track themselves, this module
// has no state of its own to subscribe to.

import { ensureChatKey } from './e2ee';
import { decryptWithFallback } from './messages';
import { decryptString } from '../crypto/e2ee';
import type { ChatMessage, ChatSummary } from '../types';

// Keyed by `${chatId}:${lastMessage.id}` so a new last message naturally
// invalidates the old cached line without needing an explicit bust.
const cache = new Map<string, string>();
const inFlight = new Set<string>();

function rawPreview(m: ChatMessage, myUserId: string | null): string {
  if (m.type === 'system') return m.text || '';
  const prefix = m.fromUserId === myUserId ? 'You: ' : '';
  if (m.deleted) return prefix + 'Message deleted';
  // Same privacy rule as web (index.html:4064-4069): a protected message
  // never shows in a preview, visible without opening the chat at all,
  // even to whoever sent it.
  if (m.protected) return prefix + '🔒 Protected message';
  const att = m.attachment;
  if (att && !m.text) {
    const isImg = att.kind === 'image' || !att.kind;
    const isVoice = att.kind === 'voice';
    return prefix + (isImg ? '📷 Photo' : isVoice ? '🎙 Voice message' : att.kind === 'video' ? '📹 Video' : `📄 ${att.name || 'File'}`);
  }
  if (att) return prefix + (att.kind === 'image' || !att.kind ? '📷 ' : att.kind === 'voice' ? '🎤 ' : '📄 ') + (m.text || '');
  return prefix + (m.text || '');
}

export function getCachedPreview(chatId: string, lastMessageId: string | undefined): string | null {
  if (!lastMessageId) return null;
  return cache.get(`${chatId}:${lastMessageId}`) ?? null;
}

// Fire-and-forget from the caller's perspective (chat list calls this then
// re-reads via getCachedPreview once a version counter bumps), matching
// state/names.ts's resolveNames()/getCachedName() split.
export async function resolvePreview(
  chat: ChatSummary,
  lastMessage: ChatMessage | null | undefined,
  myUserId: string | null
): Promise<void> {
  if (!lastMessage) return;
  const key = `${chat.id}:${lastMessage.id}`;
  if (cache.has(key) || inFlight.has(key)) return;
  inFlight.add(key);
  try {
    if (lastMessage.type === 'system' || lastMessage.deleted || lastMessage.protected || !lastMessage.ciphertext) {
      cache.set(key, rawPreview(lastMessage, myUserId));
      return;
    }
    const chatKey = await ensureChatKey(chat);
    if (!chatKey) return; // not cached — retried next time the list calls resolvePreview (e.g. on refresh)
    const text = await decryptWithFallback(chat, chatKey, (k) => decryptString(k, lastMessage.iv!, lastMessage.ciphertext!));
    cache.set(key, rawPreview({ ...lastMessage, text }, myUserId));
  } catch {
    cache.set(key, "🔒 Couldn't decrypt this message on this device.");
  } finally {
    inFlight.delete(key);
  }
}
