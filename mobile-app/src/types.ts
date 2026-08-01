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

export interface ApiErrorBody {
  error: string;
  retryAfterMs?: number;
  methods?: { totp?: boolean; webauthn?: boolean };
}

export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: ApiErrorBody | null; networkError?: boolean };
