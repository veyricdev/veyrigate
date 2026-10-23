import type { AuditListParams, ListClientsParams, PageParams, UserListParams } from "./inputs";

/** Query key factory (run 43 F3): invalidate `clients.all` to refresh every client query. */
export const adminKeys = {
  all: ["admin"] as const,
  clients: {
    all: ["admin", "clients"] as const,
    list: (params: ListClientsParams) => ["admin", "clients", "list", params] as const,
    detail: (clientId: string) => ["admin", "clients", "detail", clientId] as const,
    secrets: (clientId: string) => ["admin", "clients", "secrets", clientId] as const,
  },
  /** Invalidate `resources.all` after a resource write: it also refreshes the client form's options. */
  resources: {
    all: ["admin", "resources"] as const,
    options: ["admin", "resources", "options"] as const,
    list: (params: PageParams) => ["admin", "resources", "list", params] as const,
    detail: (resourceId: string) => ["admin", "resources", "detail", resourceId] as const,
  },
  /** Invalidate `users.all` after any user write (a lock also revokes the families). */
  users: {
    all: ["admin", "users"] as const,
    list: (params: UserListParams) => ["admin", "users", "list", params] as const,
    detail: (userId: string) => ["admin", "users", "detail", userId] as const,
    families: (userId: string, params: PageParams) => ["admin", "users", "families", userId, params] as const,
    consents: (userId: string, params: PageParams) => ["admin", "users", "consents", userId, params] as const,
  },
  /** Read-only. */
  audit: {
    list: (params: AuditListParams) => ["admin", "audit", "list", params] as const,
  },
  /** Signing keys (super_admin only; never paged). */
  signingKeys: {
    list: ["admin", "signing-keys"] as const,
  },
};
