// Sending half of mobile's attachment story — the receiving/decrypt half
// (state/messages.ts's decryptOneAttachment, MessageAttachments.tsx) has
// existed since Phase 2; this is what was missing. Mirrors index.html's
// sendMessage() attachment branch (index.html:11575-11611) field-for-field:
// same AES-256-GCM raw-byte encryption (crypto/e2ee.ts's encryptBytes,
// already shared with the receive path), same opaque
// application/octet-stream upload to POST /api/upload, same
// attachmentPayload shape sent to POST /chats/:id/messages. The one real
// difference is transport: web hands the browser a Blob/ArrayBuffer body
// directly; RN's fetch has no reliable raw-binary-body story across iOS/
// Android, so this writes the ciphertext to a throwaway cache file and
// uses expo-file-system's File.upload() (binary content, not multipart —
// same "opaque bytes" shape the server expects) instead of apiFetch.

import { File, Paths, UploadType } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { encryptBytes, encryptString } from '../crypto/e2ee';
import { API_BASE_URL } from '../api/client';
import { useSessionStore } from '../state/session';
import type { MessageAttachment } from '../types';

export interface PendingAttachment {
  kind: 'image' | 'voice';
  uri: string;
  mime: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number; // seconds
}

// Thrown with a message safe to show directly in the send-error banner.
export class AttachmentUploadError extends Error {}

export async function encryptAndUploadAttachment(
  key: Uint8Array,
  pending: PendingAttachment
): Promise<MessageAttachment> {
  const srcFile = new File(pending.uri);
  let rawBytes: Uint8Array;
  try {
    rawBytes = new Uint8Array(await srcFile.arrayBuffer());
  } catch (e) {
    throw new AttachmentUploadError("Couldn't read that file. Try again.");
  }

  const encBytes = encryptBytes(key, rawBytes);
  const encName = encryptString(key, pending.name || 'file');

  // Throwaway — deleted in the `finally` below regardless of outcome, same
  // lifetime as the ciphertext it holds (this device's own local cache
  // dir, never synced/backed up, gone the moment the upload settles).
  // Same File.create({intermediates, overwrite}) + .write() pattern as
  // the receiving side's decryptOneAttachment (state/messages.ts) —
  // `intermediates: true` creates the outgoing-attachments subdirectory
  // itself on first use, no separate mkdir step needed.
  const tmpFile = new File(Paths.cache, 'outgoing-attachments', `${Crypto.randomUUID()}.enc`);
  tmpFile.create({ intermediates: true, overwrite: true });
  tmpFile.write(encBytes.bytes);

  try {
    const pinHash = useSessionStore.getState().pinHash;
    const uploadRes = await tmpFile.upload(`${API_BASE_URL}/api/upload`, {
      httpMethod: 'POST',
      // BINARY_CONTENT, not MULTIPART — matches web's raw-body POST
      // exactly; worker.js's /api/upload reads `request.arrayBuffer()`
      // directly, it has no multipart parsing at all.
      uploadType: UploadType.BINARY_CONTENT,
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent((pending.name || 'file') + '.enc'),
        ...(pinHash ? { 'X-Para-Pin-Hash': pinHash } : {}),
      },
    });

    let body: { url?: string; error?: string } = {};
    try {
      body = JSON.parse(uploadRes.body);
    } catch {
      // fall through to the status-code check below with an empty body
    }
    if (uploadRes.status < 200 || uploadRes.status >= 300 || !body.url) {
      throw new AttachmentUploadError(
        body.error === 'too_large' ? 'That file is too large to send.' : "Couldn't upload the attachment. Try again."
      );
    }

    return {
      url: body.url,
      width: pending.width,
      height: pending.height,
      mime: pending.mime,
      nameCiphertext: encName.ciphertext,
      nameIv: encName.iv,
      size: pending.size,
      kind: pending.kind,
      duration: pending.duration,
      fileIv: encBytes.iv,
    };
  } catch (e) {
    if (e instanceof AttachmentUploadError) throw e;
    throw new AttachmentUploadError("Couldn't upload the attachment. Check your connection and try again.");
  } finally {
    try {
      tmpFile.delete();
    } catch {
      // best-effort cleanup only
    }
  }
}
