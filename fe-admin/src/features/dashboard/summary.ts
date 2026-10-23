import type { AuditEvent } from "@/server/admin-api/schemas";

/** The page size each dashboard count reads (the BE maximum): one page, never a cursor loop. */
export const COUNT_LIMIT = 100;

/**
 * Count text of one list page (the BE has no count, DEBT-356): exact only when it is the last page,
 * otherwise "100+" (never an exact-looking number while more pages exist).
 */
export const countText = (page: { items: unknown[]; nextCursor: string | null }) =>
  page.nextCursor === null ? String(page.items.length) : `${COUNT_LIMIT}+`;

/**
 * Security events read for the dashboard, one request each (the BE filters one action at a time).
 * Not `AUTH_ACCOUNT_LOCKED`: it carries no tenant (DEBT-140), so it is never in a tenant's audit.
 */
export const SECURITY_ACTIONS = ["TOKEN_REUSE_DETECTED", "SIGNING_KEY_ROTATED", "ADMIN_USER_LOCKED"] as const;
export const RECENT_LIMIT = 10;

/** Newest first across actions (ties: `eventId`, descending), at most {@link RECENT_LIMIT}. */
export const mergeRecent = (pages: AuditEvent[][]) =>
  pages
    .flat()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.eventId.localeCompare(a.eventId))
    .slice(0, RECENT_LIMIT);
