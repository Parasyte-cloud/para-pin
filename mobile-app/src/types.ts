// Shapes mirror what worker.js actually returns — see the Registry DO's
// POST /session handler and its `orgs.push(...)` shape. Keep in sync with
// index.html's equivalent client-side usage rather than any formal schema
// (the backend doesn't publish one).

export interface OrgSecurityPolicy {
  minTimeoutSec: number | null;
  requireStepUpForSensitive?: boolean;
}

// preventScreenshotAndroid: the one part of this that's a real OS-enforced
// control (FLAG_SECURE) — see useAvatarScreenCapture.ts for why there's no
// iOS equivalent field here at all, rather than one that would always be
// false/ignored. showViewerIdentityToOwner: privacy-preserving default is
// off, see worker.js's /org/avatar-policy comment for the reasoning.
export interface OrgAvatarPolicy {
  preventScreenshotAndroid?: boolean;
  showViewerIdentityToOwner?: boolean;
}

export interface OrgSummary {
  id: string | null;
  name: string;
  logoUrl?: string | null;
  allowEmailAuth?: boolean;
  emailDomain?: string | null;
  country?: string | null;
  customDomains?: string[];
  isAdmin?: boolean;
  securityPolicy?: OrgSecurityPolicy | null;
  avatarPolicy?: OrgAvatarPolicy | null;
}

export interface ChatSummary {
  id: string;
  type: 'dm' | 'group';
  name?: string | null;
  avatarUrl?: string | null;
  orgId?: string | null;
  memberIds?: string[];
  lastMessageAt?: number | null;
  unreadCount?: number;
  pinned?: boolean;
}

export interface SessionResponse {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  department: string | null;
  email: string | null;
  isAdmin: boolean;
  e2eePublicKey: string | null;
  mustChangePin: boolean;
  trustedDeviceCount: number;
  chats: ChatSummary[];
  // `lastMessage` was already coming back in this response (worker.js's
  // /session handler builds it per-chat via the ChatRoom DO's /summary,
  // worker.js:1972-1981) but this type only ever declared the two fields
  // the chat list actually used — the raw (still-encrypted) last message
  // was there at runtime the whole time, just never typed/read.
  summaries: Record<string, { unreadCount?: number; lastMessageAt?: number | null; lastMessage?: ChatMessage | null }>;
  pinnedChatIds: string[];
  orgs: OrgSummary[];
}

export interface MessageAttachment {
  url: string;
  width?: number;
  height?: number;
  mime?: string;
  nameCiphertext?: string;
  nameIv?: string;
  size?: number;
  kind?: string;
  duration?: number;
  fileIv?: string;
  // Client-only, populated after this device decrypts it — mirrors
  // index.html's `.name`/`_decryptedUrl` pattern. `_decryptedUri` is a
  // local `file://` path (expo-file-system cache dir) rather than a blob
  // URL, since RN has no equivalent to URL.createObjectURL; `null` means
  // decryption was attempted and failed, `undefined` means not attempted
  // (or not yet reached) — see src/state/messages.ts's decryptOneAttachment.
  name?: string;
  _decryptedUri?: string | null;
  _decrypting?: boolean;
}

export interface ReplyToRef {
  id: string;
  fromName?: string;
  text?: string;
}

// Mirrors what the ChatRoom DO actually sends/stores (see worker.js's
// POST /messages handler and its broadcast shape) plus the client-only
// fields index.html adds during decryption (text, _e2eeDone).
export interface ChatMessage {
  id: string;
  chatId?: string;
  fromUserId: string;
  ts: number;
  ciphertext?: string;
  iv?: string;
  alg?: 'dm' | 'group';
  attachment?: MessageAttachment | null;
  replyTo?: ReplyToRef | null;
  protected?: boolean;
  deleted?: boolean;
  edited?: boolean;
  type?: 'system' | 'message';
  system?: boolean;
  // emoji -> userIds who reacted with it (worker.js's ChatRoom /react
  // handler — one reaction per user per message, toggled). Plaintext,
  // never E2EE'd, same as the web app.
  reactions?: Record<string, string[]>;
  // Client-only:
  text?: string;
  _e2eeDone?: boolean;
  _pending?: boolean; // optimistic local echo before the server confirms
}

export interface ApiErrorBody {
  error: string;
  retryAfterMs?: number;
  methods?: { totp?: boolean; webauthn?: boolean };
}

export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: ApiErrorBody | null; networkError?: boolean };
