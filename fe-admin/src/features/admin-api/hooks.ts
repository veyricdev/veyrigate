import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient, getClient, listClients, listResources, updateClient } from "./clients";
import type {
  CreateClientParams,
  CreateResourceParams,
  ListClientsParams,
  PageParams,
  RevokeSecretParams,
  UpdateClientParams,
  UpdateResourceParams,
} from "./inputs";
import { adminKeys } from "./keys";
import { createResource, getResource, listResourcePage, updateResource } from "./resources";
import { listSecrets, revokeSecret } from "./secrets";
import { AdminRequestError, unwrap } from "./types";

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
