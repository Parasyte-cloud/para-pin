// Profile photo upload — deliberately separate from
// utils/attachmentUpload.ts despite the similar File.upload() mechanics,
// because the trust model is opposite: message attachments are end-to-end
// encrypted (only chat members can decrypt them), but a profile photo is
// shown to everyone who can see this user's name at all (chat lists,
// member rows, call screens), so it's uploaded PLAIN — same as
// index.html's profileSaveBtn handler (index.html:8535-8547), which POSTs
// the raw image blob with no encryption step at all. Reusing
// encryptAndUploadAttachment here would make profile photos silently
// undecryptable to anyone (avatarUrl is fetched directly as an <Image
// src>, there's no key to hand it).

import { File } from 'expo-file-system';
import { UploadType } from 'expo-file-system';
import { API_BASE_URL } from '../api/client';
import { useSessionStore } from '../state/session';

export class ProfilePhotoUploadError extends Error {}

export async function uploadProfilePhoto(localUri: string, mime: string): Promise<string> {
  const srcFile = new File(localUri);
  const pinHash = useSessionStore.getState().pinHash;
  let uploadRes;
  try {
    uploadRes = await srcFile.upload(`${API_BASE_URL}/api/upload`, {
      httpMethod: 'POST',
      uploadType: UploadType.BINARY_CONTENT,
      headers: {
        'content-type': mime || 'image/jpeg',
        'x-file-name': 'profile.jpg',
        ...(pinHash ? { 'X-Para-Pin-Hash': pinHash } : {}),
      },
    });
  } catch {
    throw new ProfilePhotoUploadError("Couldn't upload the photo. Check your connection and try again.");
  }

  let body: { url?: string; error?: string } = {};
  try {
    body = JSON.parse(uploadRes.body);
  } catch {
    // fall through to the status check below with an empty body
  }
  if (uploadRes.status < 200 || uploadRes.status >= 300 || !body.url) {
    throw new ProfilePhotoUploadError(body.error === 'too_large' ? 'That photo is too large.' : "Couldn't upload the photo. Try again.");
  }
  return body.url;
}
