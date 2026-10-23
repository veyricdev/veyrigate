import type { ListClientsParams, PageParams } from "./inputs";

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
};
