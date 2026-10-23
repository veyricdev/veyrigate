import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient, getClient, listClients, listResources, updateClient } from "./clients";
import { listAudit } from "./audit";
import { getBackendHealth } from "./health";
import type {
  AuditListParams,
  CreateClientParams,
  CreateResourceParams,
  ListClientsParams,
  PageParams,
  RevokeSecretParams,
  UpdateClientParams,
  UpdateResourceParams,
  RevokeConsentParams,
  RevokeFamilyParams,
  RotateKeyParams,
  UserListParams,
} from "./inputs";
import { adminKeys } from "./keys";
import { createResource, getResource, listResourcePage, updateResource } from "./resources";
import { listSecrets, revokeSecret } from "./secrets";
import { listSigningKeys, rotateSigningKey } from "./signing-keys";
import type { AdminUser } from "@/server/admin-api/schemas";
import { AdminRequestError, unwrap, type AdminResult } from "./types";
import {
  getUser,
  listUserConsents,
  listUserFamilies,
  listUsers,
  lockUser,
  revokeUserConsent,
  revokeUserFamily,
  revokeUserSessions,
  unlockUser,
} from "./users";

export function useClients(params: ListClientsParams) {
  return useQuery({
    queryKey: adminKeys.clients.list(params),
    queryFn: async () => unwrap(await listClients({ data: params })),
  });
}

export function useClient(clientId: string) {
  return useQuery({
    queryKey: adminKeys.clients.detail(clientId),
    queryFn: async () => unwrap(await getClient({ data: clientId })),
  });
}

export function useResources() {
  return useQuery({
    queryKey: adminKeys.resources.options,
    queryFn: async () => unwrap(await listResources()),
  });
}

/**
 * Refresh every query under `queryKey` when a write succeeded or its outcome is unknown: an
 * `uncertain` error, or a throw that is not an {@link AdminRequestError} (network / BFF failure,
 * DEBT-315/318). A known refusal (400/403/404/409, step-up) changed nothing: no refetch.
 */
function useInvalidateOn(queryKey: readonly unknown[]) {
  const queryClient = useQueryClient();
  return (error: Error | null) => {
    if (!error || !(error instanceof AdminRequestError) || error.uncertain) {
      return queryClient.invalidateQueries({ queryKey });
    }
  };
}

const useInvalidateClients = () => useInvalidateOn(adminKeys.clients.all);

/**
 * Client update. On success, or when the outcome is unknown (`uncertain`), every client query is
 * invalidated so the UI shows the real state. `step_up_required` is for the form to handle
 * (`startStepUp`), so the draft survives the round-trip.
 */
export function useUpdateClient() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: async (input: UpdateClientParams) => unwrap(await updateClient({ data: input })),
    onSettled: (_data, error) => invalidate(error),
  });
}

/** Client creation: same invalidation as {@link useUpdateClient}; never retried (not idempotent). */
export function useCreateClient() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: async (input: CreateClientParams) => unwrap(await createClient({ data: input })),
    onSettled: (_data, error) => invalidate(error),
  });
}

/** Secret versions of a confidential client (metadata only: the cache never holds a secret). */
export function useSecrets(clientId: string) {
  return useQuery({
    queryKey: adminKeys.clients.secrets(clientId),
    queryFn: async () => unwrap(await listSecrets({ data: clientId })),
  });
}

/** Revoke one secret version; the list is re-read on success or when the outcome is unknown. */
export function useRevokeSecret() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: async (input: RevokeSecretParams) => unwrap(await revokeSecret({ data: input })),
    onSettled: (_data, error) => invalidate(error),
  });
}

/** One page of resources (cursor `after`). */
export function useResourcePage(params: PageParams) {
  return useQuery({
    queryKey: adminKeys.resources.list(params),
    queryFn: async () => unwrap(await listResourcePage({ data: params })),
  });
}

export function useResource(resourceId: string) {
  return useQuery({
    queryKey: adminKeys.resources.detail(resourceId),
    queryFn: async () => unwrap(await getResource({ data: resourceId })),
  });
}

const useInvalidateResources = () => useInvalidateOn(adminKeys.resources.all);

/** Resource creation; never retried (not idempotent). Refreshes every resource query (and the client form's options). */
export function useCreateResource() {
  const invalidate = useInvalidateResources();
  return useMutation({
    mutationFn: async (input: CreateResourceParams) => unwrap(await createResource({ data: input })),
    onSettled: (_data, error) => invalidate(error),
  });
}

/** Resource scopes update; same invalidation as {@link useCreateResource}. */
export function useUpdateResource() {
  const invalidate = useInvalidateResources();
  return useMutation({
    mutationFn: async (input: UpdateResourceParams) => unwrap(await updateResource({ data: input })),
    onSettled: (_data, error) => invalidate(error),
  });
}

/** One page of the tenant's users (`email` filter: in the POST body and the in-memory key only). */
export function useUsers(params: UserListParams) {
  return useQuery({
    queryKey: adminKeys.users.list(params),
    queryFn: async () => unwrap(await listUsers({ data: params })),
  });
}

export function useUser(userId: string) {
  return useQuery({
    queryKey: adminKeys.users.detail(userId),
    queryFn: async () => unwrap(await getUser({ data: userId })),
  });
}

export function useUserFamilies(userId: string, params: PageParams) {
  return useQuery({
    queryKey: adminKeys.users.families(userId, params),
    queryFn: async () => unwrap(await listUserFamilies({ data: { userId, ...params } })),
  });
}

export function useUserConsents(userId: string, params: PageParams) {
  return useQuery({
    queryKey: adminKeys.users.consents(userId, params),
    queryFn: async () => unwrap(await listUserConsents({ data: { userId, ...params } })),
  });
}

/**
 * Any user write refreshes every user query (detail, families, consents, lists): a lock also
 * revokes the families, a consent revoke its families. Never retried (`retry: 0` default).
 */
function useUserWrite<I, T>(fn: (o: { data: I }) => Promise<AdminResult<T>>) {
  const invalidate = useInvalidateOn(adminKeys.users.all);
  return useMutation({
    mutationFn: async (input: I) => unwrap(await fn({ data: input })),
    onSettled: (_data, error) => invalidate(error),
  });
}

export const useLockUser = () => useUserWrite<string, AdminUser>(lockUser);
export const useUnlockUser = () => useUserWrite<string, AdminUser>(unlockUser);
export const useRevokeUserSessions = () => useUserWrite<string, void>(revokeUserSessions);
export const useRevokeUserFamily = () => useUserWrite<RevokeFamilyParams, void>(revokeUserFamily);
export const useRevokeUserConsent = () => useUserWrite<RevokeConsentParams, void>(revokeUserConsent);

/** One page of the tenant's audit events (filters from the URL search params). */
export function useAuditEvents(params: AuditListParams) {
  return useQuery({
    queryKey: adminKeys.audit.list(params),
    queryFn: async () => unwrap(await listAudit({ data: params })),
  });
}

/**
 * Signing keys (super_admin only: the BE refuses anyone else). Gate by mounting the caller only for
 * a super_admin (`/keys`, dashboard), so nobody else ever sends the request.
 */
export function useSigningKeys() {
  return useQuery({
    queryKey: adminKeys.signingKeys.list,
    queryFn: async () => unwrap(await listSigningKeys()),
  });
}

/** IdP readiness for the dashboard: read once, never retried (the BFF already waited up to 3 s). */
export function useBackendHealth() {
  return useQuery({
    queryKey: adminKeys.health,
    queryFn: async () => unwrap(await getBackendHealth()),
    retry: false,
  });
}

/** Key rotation; never retried (not idempotent). The list is re-read on success or an unknown outcome. */
export function useRotateSigningKey() {
  const invalidate = useInvalidateOn(adminKeys.signingKeys.list);
  return useMutation({
    mutationFn: async (input: RotateKeyParams) => unwrap(await rotateSigningKey({ data: input })),
    onSettled: (_data, error) => invalidate(error),
  });
}
