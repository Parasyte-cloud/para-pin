// Per-chat message cache + decrypt-in-place, mirroring index.html's
// `messagesByChat` global and `decryptMessagesInPlace` (index.html:
// 10673-10725), including attachment (file/image/voice-note) decryption
// and the legacy pre-multi-device DM-key fallback. One real difference
// from web: there's no equivalent of `URL.createObjectURL` in React
// Native, so decrypted attachment bytes are written to a per-message file
// under expo-file-system's cache directory instead of an in-memory blob
// URL — see decryptOneAttachment below and MessageAttachment's
// `_decryptedUri` field in src/types.ts.

import { create } from 'zustand';
import { File, Paths } from 'expo-file-system';
import { apiFetch } from '../api/client';
import { ensureChatKey, ensureLegacyDmKey } from './e2ee';
import { decryptString, decryptBytes } from '../crypto/e2ee';
import type { ChatMessage, ChatSummary, MessageAttachment } from '../types';

function sortByTs(msgs: ChatMessage[]): ChatMessage[] {
  return [...msgs].sort((a, b) => a.ts - b.ts);
}

// Tries the chat's current wrap-based key first; only on failure (which,
// same as web, only ever happens for content encrypted before
// multi-device shipped) falls back to the legacy pairwise DM key. See
// ensureLegacyDmKey's own comment for why that fallback only actually
// succeeds if mobile happens to be an account's very first device.
async function decryptWithFallback<T>(chat: ChatSummary, primaryKey: Uint8Array, fn: (k: Uint8Array) => T): Promise<T> {
  try {
    return fn(primaryKey);
  } catch (e) {
    const legacy = await ensureLegacyDmKey(chat);
    if (!legacy) throw e;
    return fn(legacy);
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'audio/m4a': '.m4a',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/webm': '.weba',
  'application/pdf': '.pdf',
};

function extensionFor(name: string | undefined, mime: string | undefined): string {
  if (name && name.includes('.')) {
    const ext = name.slice(name.lastIndexOf('.'));
    if (ext.length > 1 && ext.length <= 8) return ext;
  }
  if (mime && MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
  return '.bin';
}

// One cache file per message id — stable across app restarts (re-decrypts
// are skipped if the file already exists, see decryptOneAttachment), and
// automatically eligible for the OS to reclaim under storage pressure
// since it lives under Paths.cache rather than Paths.document.
function attachmentCacheFile(messageId: string, attachment: MessageAttachment): File {
  const ext = extensionFor(attachment.name, attachment.mime);
  return new File(Paths.cache, 'attachments', `${messageId}${ext}`);
}

// Downloads the ciphertext, decrypts it, and writes plaintext bytes to a
// local cache file (index.html:10698-10712's fetch+decrypt+
// URL.createObjectURL, adapted for RN's filesystem instead of blob URLs).
// Mutates `attachment` in place; callers are responsible for triggering a
// re-render afterward (see decryptChat below).
async function decryptOneAttachment(chat: ChatSummary, messageId: string, attachment: MessageAttachment, key: Uint8Array) {
  if (!attachment.fileIv || attachment._decryptedUri || attachment._decrypting) return;

  const cacheFile = attachmentCacheFile(messageId, attachment);
  if (cacheFile.exists) {
    attachment._decryptedUri = cacheFile.uri;
    return;
  }

  attachment._decrypting = true;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const ciphertextBytes = new Uint8Array(await res.arrayBuffer());
    const plainBytes = await decryptWithFallback(chat, key, (k) => decryptBytes(k, attachment.fileIv!, ciphertextBytes));
    cacheFile.create({ intermediates: true, overwrite: true });
    cacheFile.write(plainBytes);
    attachment._decryptedUri = cacheFile.uri;
  } catch (e) {
    attachment._decryptedUri = null;
    console.warn('[e2ee] attachment decrypt failed', { chatId: chat.id, messageId, error: String(e) });
  } finally {
    attachment._decrypting = false;
  }
}

interface MessagesState {
  byChat: Record<string, ChatMessage[]>;
  loadHistory: (chat: ChatSummary) => Promise<void>;
  mergeMessages: (chatId: string, incoming: ChatMessage[]) => void;
  decryptChat: (chat: ChatSummary) => Promise<boolean>; // returns true if anything is still pending decryption
  applyDelete: (chatId: string, messageId: string) => void;
  applyEdit: (chatId: string, messageId: string, ciphertext: string, iv: string, knownText?: string) => void;
  applyReaction: (chatId: string, messageId: string, reactions: Record<string, string[]>) => void;
  addOptimistic: (chatId: string, message: ChatMessage) => void;
  removeOptimistic: (chatId: string, tempId: string) => void;
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  byChat: {},

  loadHistory: async (chat) => {
    const res = await apiFetch<{ messages?: ChatMessage[] }>(`/chats/${chat.id}/messages`);
    if (res.ok && res.body.messages) {
      get().mergeMessages(chat.id, res.body.messages);
    } else if (!(chat.id in get().byChat)) {
      set((state) => ({ byChat: { ...state.byChat, [chat.id]: [] } }));
    }
  },

  mergeMessages: (chatId, incoming) => {
    set((state) => {
      const existing = state.byChat[chatId] || [];
      const byId = new Map(existing.map((m) => [m.id, m]));
      for (const m of incoming) {
        const prev = byId.get(m.id);
        // Preserve already-decrypted text/flags if this is just a re-merge
        // of the same message (e.g. optimistic echo replaced by the real
        // server copy) rather than clobbering it back to ciphertext-only.
        byId.set(m.id, prev && prev._e2eeDone && !m._e2eeDone ? { ...m, text: prev.text, _e2eeDone: true } : m);
      }
      return { byChat: { ...state.byChat, [chatId]: sortByTs([...byId.values()]) } };
    });
  },

  decryptChat: async (chat) => {
    const msgs = get().byChat[chat.id] || [];
    let stillPending = false;
    const attachmentWaits: Promise<void>[] = [];

    for (const m of msgs) {
      if (m._e2eeDone || m.type === 'system' || m.system) continue;
      if (!m.ciphertext && !(m.attachment && m.attachment.fileIv)) {
        m._e2eeDone = true; // legacy plaintext or attachment-only message with nothing to decrypt
        continue;
      }
      const key = await ensureChatKey(chat);
      if (!key) {
        if (!m.text) m.text = '🔒 Waiting for encryption to finish setting up…';
        stillPending = true;
        continue;
      }
      if (m.ciphertext && m.iv) {
        try {
          m.text = await decryptWithFallback(chat, key, (k) => decryptString(k, m.iv!, m.ciphertext!));
        } catch (e) {
          m.text = "🔒 Couldn't decrypt this message on this device.";
          console.warn('[e2ee] decrypt failed', { chatId: chat.id, messageId: m.id, error: String(e) });
        }
      }
      if (m.attachment) {
        if (m.attachment.nameCiphertext && m.attachment.nameIv && !m.attachment.name) {
          try {
            m.attachment.name = await decryptWithFallback(chat, key, (k) =>
              decryptString(k, m.attachment!.nameIv!, m.attachment!.nameCiphertext!)
            );
          } catch {
            m.attachment.name = 'Attachment';
          }
        }
        if (m.attachment.fileIv && !m.attachment._decryptedUri && !m.attachment._decrypting) {
          const attachment = m.attachment;
          const messageId = m.id;
          attachmentWaits.push(
            decryptOneAttachment(chat, messageId, attachment, key).then(() => {
              // Attachment bytes decrypt off to the side of the main text
              // loop (can be slow for larger files) — push a state update
              // once it lands so the message list re-renders with the
              // image/file now available, same as index.html's renderConv()
              // call inside its own fire-and-forget attachment IIFE.
              set((state) => {
                const current = state.byChat[chat.id];
                if (!current) return state;
                return { byChat: { ...state.byChat, [chat.id]: [...current] } };
              });
            })
          );
        }
      }
      m._e2eeDone = true;
    }

    set((state) => ({ byChat: { ...state.byChat, [chat.id]: [...msgs] } }));
    // Deliberately not awaited by the caller (attachments can be slow) —
    // awaited here only so any synchronous errors are at least caught
    // above; UI updates for attachments arrive via the .then() above.
    Promise.all(attachmentWaits).catch(() => {});
    return stillPending;
  },

  applyDelete: (chatId, messageId) => {
    set((state) => {
      const msgs = state.byChat[chatId];
      if (!msgs) return state;
      const next = msgs.map((m) => (m.id === messageId ? { ...m, deleted: true, text: '' } : m));
      return { byChat: { ...state.byChat, [chatId]: next } };
    });
  },

  applyEdit: (chatId, messageId, ciphertext, iv, knownText) => {
    set((state) => {
      const msgs = state.byChat[chatId];
      if (!msgs) return state;
      // Local edit (I typed it — knownText passed): apply the plaintext
      // immediately, no need to round-trip through decryptChat. Remote
      // edit arriving over the socket (no knownText): this client doesn't
      // know the plaintext, so mark it pending — the caller is responsible
      // for triggering a decryptChat pass right after (see
      // useChatSocket.ts's 'edit' case), otherwise it would sit
      // undecrypted until the next unrelated re-render.
      const next = msgs.map((m) =>
        m.id === messageId
          ? knownText !== undefined
            ? { ...m, ciphertext, iv, edited: true, _e2eeDone: true, text: knownText }
            : { ...m, ciphertext, iv, edited: true, _e2eeDone: false, text: undefined }
          : m
      );
      return { byChat: { ...state.byChat, [chatId]: next } };
    });
  },

  applyReaction: (chatId, messageId, reactions) => {
    set((state) => {
      const msgs = state.byChat[chatId];
      if (!msgs) return state;
      const next = msgs.map((m) => (m.id === messageId ? { ...m, reactions } : m));
      return { byChat: { ...state.byChat, [chatId]: next } };
    });
  },

  addOptimistic: (chatId, message) => {
    set((state) => ({
      byChat: { ...state.byChat, [chatId]: sortByTs([...(state.byChat[chatId] || []), message]) },
    }));
  },

  removeOptimistic: (chatId, tempId) => {
    set((state) => {
      const msgs = state.byChat[chatId];
      if (!msgs) return state;
      return { byChat: { ...state.byChat, [chatId]: msgs.filter((m) => m.id !== tempId) } };
    });
  },
}));
