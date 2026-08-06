# PArA Enterprise OS — Phased Roadmap

This is a sequencing document, not a spec. It grounds the "Enterprise OS" vision in what's actually built in this codebase today, and lays out what to build next and in what order, reusing the patterns that already work (Registry DO storage, `ORG_PERMISSIONS`, `appendAuditLog`, the `admin-console-overlay` UI shell, `pushToAllTargets`) instead of inventing new ones per module. Each phase below is buildable on top of the last; nothing here requires a rewrite of what exists.

## What's already real (the foundation)

- **Identity & RBAC**: org creation, admin bootstrapping, `ORG_PERMISSIONS` (`manage_workspace`, `manage_members`, `manage_hr`, `manage_crm`, `start_meetings`, `create_channels`, `moderate_messages`), per-user permission overrides, platform-level admin console separate from customer orgs.
- **HR**: employee records, leave (ledger-based, never mutated in place), org chart, compensation history, configurable leave entitlements, public holiday calendars, CSV export, an "Ask HR" assistant on Workers AI.
- **CRM** (just shipped): Companies, Contacts, Pipeline — same storage pattern as HR, `manage_crm`-gated writes, audit-logged.
- **Messaging, calls, meetings**: E2EE (P-256 ECDH + AES-256-GCM), 1:1 and group calls, meetings, cross-device key sync.
- **Admin console (PArA Ops)**: analytics, orgs, users, retention/legal-hold, API keys, webhooks, status page — platform-internal, not given to customer orgs.
- **Notifications**: unified push fan-out (Web Push / APNs / FCM) triggered from a handful of call sites (new message, call, meeting invite).
- **Branding**: custom domains per org, hostname-based routing.
- **Billing & email**: Paystack activation, Resend transactional email (onboarding, verification, magic link, admin welcome).

Everything below extends this, it doesn't replace it.

## Phase 1 — Deepen CRM (cheapest, highest leverage right now)

CRM just landed with no consumers of the data it's collecting yet. Before building new modules, make the one that exists pull its weight:

- **Activity timeline on Companies/Contacts**: an append-only `crmActivity:${orgId}:${dealId or contactId}` ledger, written whenever a call, chat, or meeting touches a linked contact. Reuses the ledger pattern HR's leave history already established.
- **CRM notifications**: deal assigned, stage moved to negotiation/won/lost — routed through the existing `pushToAllTargets` pipeline, same call-site shape as the message/call notifications.
- **Lightweight reporting**: pipeline value by stage, win rate — computable client-side from data the UI already fetches, no new backend needed.

This phase is mostly wiring, not new architecture, and it's what makes CRM feel like part of one system instead of an isolated tab.

## Phase 2 — Projects & Tasks

The next module, not Finance or Legal, because it maps almost 1:1 onto the CRM/HR pattern already proven twice: `projectIds:${orgId}`, `project:${orgId}:${id}`, `taskIds:${orgId}:${projectId}`, task records with assignee/status/dueDate. New permission: `manage_projects`. UI: another `admin-console-overlay` tab set (Board / List / My Tasks), same shell as `crmOverlay`/`hrOverlay`. Integration point: a task can reference a CRM deal or contact ID, so "close this deal" work shows up in both places without a second source of truth.

## Phase 3 — Help Desk

Support tickets tied to a CRM contact/company so support history shows up on the customer record instead of living in a separate silo. `ticketIds:${orgId}`, `ticket:${orgId}:${id}` with status/priority/assignee, comment thread as an append-only ledger (same shape as leave history / CRM activity). New permission: `manage_helpdesk`. This is the first module where it's worth asking org admins directly whether they'd actually use it before building it — unlike CRM/Projects, it's not obviously useful to every workspace size.

## Phase 4 — Knowledge base

Simple wiki-style pages (title, markdown body, org-scoped), stored directly in Registry DO storage rather than standing up a new document engine — at the scale a single org's internal docs run at, that's plenty. Read open to all members, edit gated behind a `manage_knowledge` permission. Integration: link a knowledge page from a project, ticket, or HR policy field rather than duplicating content.

## Phase 5 — Finance & Legal: integrate, don't rebuild

These are the two modules I'd explicitly push furthest out and recommend *not* building as in-house ledgers/e-sign from scratch. Financial record-keeping and legally-binding e-signatures carry real compliance and liability weight (accounting standards, tax jurisdictions, e-signature law varies by country) that a homegrown implementation doesn't get for free just by being well-coded. The realistic path here is integration — Stripe/QuickBooks-style APIs for finance, a real e-sign provider (DocuSign, etc.) for contracts — with PArA as the system that surfaces and links that data next to the relevant CRM company or project, not the system of record for it.

## Phase 6 — Company-wide AI assistant

Comes last on purpose: its value is proportional to how much real module data exists to answer questions about. The pattern already exists — "Ask HR" runs on `env.AI` (Workers AI) today. Extending it across HR + CRM + Projects + Help Desk means the same assistant pattern, but every piece of context injected into a prompt has to pass the same `hasOrgPermission` check that would gate a direct API call for that data — the assistant should never be able to see or repeat something the asking user couldn't already see themselves. Building this before Phases 1–4 exist would mean an assistant with almost nothing real to say.

## Phase 7 — Unify the notification engine

Today notifications are ad hoc — each feature calls `pushToAllTargets` directly from its own code path. That's fine at 3 notification sources (message, call, meeting invite); it won't be fine at 8 once CRM, Projects, and Help Desk are all sending pushes too. Before that happens: a single `notify(orgId, userId, {type, title, body, data})` wrapper, a per-user `notificationPrefs:${orgId}:${userId}` record so people can mute "deal won" pings without muting "leave approved" ones, and an in-app notification center (bell icon, same `admin-console-overlay` shell) backed by an append-only per-user ledger. This is infrastructure, not a feature — do it once enough modules exist to justify it, not before.

## Sequencing rationale

Phases 1–4 are ordered by how cheaply each one reuses what's already proven (Registry DO + `ORG_PERMISSIONS` + `admin-console-overlay` + audit log) — each one is genuinely less risky to build than the last because the pattern's already been validated twice by the time Projects gets built, three times by Help Desk. Finance and Legal are pushed out not because they're unimportant but because they're the two places where "build it in-house" is the wrong call regardless of engineering time available. The AI assistant and notification engine are both cross-cutting, so they're sequenced after there's enough module data and enough notification sources, respectively, for either to be worth the effort.

## What this isn't

Not a timeline in days or weeks — that depends on how much of this gets built end-to-end vs. reviewed step by step, which is a real conversation to have per phase, not something to guess at here. And not a substitute for checking with actual org customers which of Phases 3–5 in particular they'd pay for before they get built — Help Desk, Knowledge, and Finance/Legal integration are the three most likely to be over-built relative to real demand if that step gets skipped.
