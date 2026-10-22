import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient, getClient, listClients, listResources, updateClient } from "./clients";
import type { CreateClientParams, ListClientsParams, UpdateClientParams } from "./inputs";
import { adminKeys } from "./keys";
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
    queryKey: adminKeys.resources,
    queryFn: async () => unwrap(await listResources()),
  });
}

/** Refresh every client query when the write succeeded or its outcome is unknown (`uncertain`). */
function useInvalidateClients() {
  const queryClient = useQueryClient();
  return (error: Error | null) => {
    if (!error || (error instanceof AdminRequestError && error.uncertain)) {
      return queryClient.invalidateQueries({ queryKey: adminKeys.clients.all });
    }
  };
}

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
