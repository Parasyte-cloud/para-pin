// Shapes mirror what worker.js actually returns — see the Registry DO's
// POST /session handler and its `orgs.push(...)` shape. Keep in sync with
// index.html's equivalent client-side usage rather than any formal schema
// (the backend doesn't publish one).

export interface OrgSummary {
  id: string | null;
  name: string;
  logoUrl?: string | null;
  allowEmailAuth?: boolean;
  emailDomain?: string | null;
  country?: string | null;
  customDomains?: string[];
  isAdmin?: boolean;
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
  summaries: Record<string, { unreadCount?: number; lastMessageAt?: number | null }>;
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
