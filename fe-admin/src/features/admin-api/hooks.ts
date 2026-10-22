import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getClient, listClients, updateClient } from "./clients";
import type { ListClientsParams, UpdateClientParams } from "./inputs";
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

/**
 * Client update. On success, or when the outcome is unknown (`uncertain`), every client query is
 * invalidated so the UI shows the real state. `step_up_required` is for the form to handle
 * (`startStepUp`), so the draft survives the round-trip.
 */
export function useUpdateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateClientParams) => unwrap(await updateClient({ data: input })),
    onSettled: (_data, error) => {
      if (!error || (error instanceof AdminRequestError && error.uncertain)) {
        return queryClient.invalidateQueries({ queryKey: adminKeys.clients.all });
      }
    },
  });
}
