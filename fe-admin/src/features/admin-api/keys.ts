import type { ListClientsParams } from "./inputs";

/** Query key factory (run 43 F3): invalidate `clients.all` to refresh every client query. */
export const adminKeys = {
  all: ["admin"] as const,
  clients: {
    all: ["admin", "clients"] as const,
    list: (params: ListClientsParams) => ["admin", "clients", "list", params] as const,
    detail: (clientId: string) => ["admin", "clients", "detail", clientId] as const,
  },
};
