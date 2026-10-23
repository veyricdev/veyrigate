import { useState, type ReactNode, type Ref } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmAction, outcomeOf, useActionNotice, type ActionOutcome } from "@/components/feedback/confirm-action";
import { useRevokeUserConsent, useRevokeUserFamily, useUserConsents, useUserFamilies } from "@/features/admin-api/hooks";
import { adminKeys } from "@/features/admin-api/keys";
import { AdminRequestError } from "@/features/admin-api/types";
import type { AdminFamily } from "@/server/admin-api/schemas";

const PAGE_SIZE = 20;

export const FAMILY_UNCERTAIN = "The outcome is unknown; the list was reloaded. Revoking again is safe.";
export const CONSENT_UNCERTAIN =
  'The outcome is unknown. If the consent no longer appears, its refresh tokens may not all be revoked: revoke the matching family below, or use "Revoke all sessions".';

interface Props {
  userId: string;
  path: string;
  /** The viewer's own account: a family may be this console's sign-in. */
  self: boolean;
  /** False after the user turned out `not_found` (DEBT-320). */
  writable: boolean;
}

const familyState = (f: AdminFamily) => (f.active ? "Active" : f.revokedAt ? `Revoked ${f.revokedAt}` : "Expired");

/** Cursor pages kept in this section's state (never in the URL). */
function usePager() {
  const [after, setAfter] = useState<string | undefined>(undefined);
  return { after, params: { limit: PAGE_SIZE, ...(after ? { after } : {}) }, setAfter };
}

function Pager({ label, after, next, setAfter }: { label: string; after?: string; next?: string | null; setAfter: (a?: string) => void }) {
  if (!after && !next) return null;
  return (
    <nav aria-label={`${label} pages`} className="flex gap-2">
      {after && (
        <Button type="button" variant="outline" onClick={() => setAfter(undefined)}>
          First page
        </Button>
      )}
      {next && (
        <Button type="button" variant="outline" onClick={() => setAfter(next)}>
          Next page
        </Button>
      )}
    </nav>
  );
}

function Section({ id, title, headingRef, notice, children }: { id: string; title: string; headingRef: Ref<HTMLHeadingElement>; notice: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        {title}
      </h2>
      <p role="status" className="text-sm">
        {notice}
      </p>
      {children}
    </section>
  );
}

function LoadState({ query, what }: { query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown }; what: string }) {
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading {what}…</p>;
  return (
    <div role="alert" className="space-y-2 text-sm">
      <p>{query.error instanceof AdminRequestError ? query.error.message : `The ${what} could not be loaded.`}</p>
      <Button variant="outline" onClick={() => void query.refetch()}>
        Try again
      </Button>
    </div>
  );
}

const cell = "py-1 pr-4";

/** Refresh token families of the user, for the clients of this tenant (run 47 F4). */
export function UserFamilies({ userId, path, self, writable }: Props) {
  const pager = usePager();
  const families = useUserFamilies(userId, pager.params);
  const revoke = useRevokeUserFamily();
  const queryClient = useQueryClient();
  const { notice, headingRef, announce } = useActionNotice();

  async function revokeFamily(familyId: string): Promise<ActionOutcome> {
    try {
      await revoke.mutateAsync({ userId, familyId });
      return { done: "Refresh token family revoked." };
    } catch (err) {
      if (err instanceof AdminRequestError && err.code === "not_found") {
        void queryClient.invalidateQueries({ queryKey: adminKeys.users.all });
        return { done: "This family is not visible in this tenant." };
      }
      // An unknown outcome closes the dialog (lock pattern, DEBT-339): the re-read may unmount the row.
      if (!(err instanceof AdminRequestError) || err.uncertain) return { done: FAMILY_UNCERTAIN };
      return outcomeOf(err, FAMILY_UNCERTAIN);
    }
  }

  return (
    <Section id="families-title" title="Refresh token families" headingRef={headingRef} notice={notice}>
      {families.data === undefined || families.isError ? (
        <LoadState query={families} what="refresh token families" />
      ) : families.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{pager.after ? "No more families." : "No refresh token family."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="Refresh token families" className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className={`${cell} font-medium`}>Client</th>
                <th scope="col" className={`${cell} font-medium`}>Resource</th>
                <th scope="col" className={`${cell} font-medium`}>Scope</th>
                <th scope="col" className={`${cell} font-medium`}>Created</th>
                <th scope="col" className={`${cell} font-medium`}>Last rotated</th>
                <th scope="col" className={`${cell} font-medium`}>Expires</th>
                <th scope="col" className={`${cell} font-medium`}>Status</th>
                <th scope="col" className="py-1 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {families.data.items.map((f) => (
                <tr key={f.familyId} className="border-t align-top">
                  <td className={`${cell} break-all`}>{f.clientId}</td>
                  <td className={`${cell} break-all`}>{f.resource}</td>
                  <td className={`${cell} break-all`}>{f.scope.join(" ") || "—"}</td>
                  <td className={cell}>{f.createdAt}</td>
                  <td className={cell}>{f.lastRotatedAt}</td>
                  <td className={cell}>{f.expiresAt}</td>
                  <td className={cell}>{familyState(f)}</td>
                  <td className="py-1 font-sans">
                    {writable && f.active && (
                      <ConfirmAction
                        trigger="Revoke"
                        triggerLabel={`Revoke family of ${f.clientId}`}
                        title="Revoke this refresh token family?"
                        confirmLabel="Revoke family"
                        destructive
                        path={path}
                        warning={
                          self && (
                            <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive">
                              One of these may be this console&apos;s own sign-in: revoking it signs you out when the console next
                              refreshes its token.
                            </p>
                          )
                        }
                        run={() => revokeFamily(f.familyId)}
                        onDone={announce}
                      >
                        <p>
                          Revokes this refresh token family: the application must sign the user in again. Access tokens already
                          issued stay valid until they expire.
                        </p>
                      </ConfirmAction>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager label="Families" after={pager.after} next={families.data?.nextCursor} setAfter={pager.setAfter} />
    </Section>
  );
}

/** Active consents of the user, for the clients of this tenant (run 47 F4). */
export function UserConsents({ userId, path, writable }: Omit<Props, "self">) {
  const pager = usePager();
  const consents = useUserConsents(userId, pager.params);
  const revoke = useRevokeUserConsent();
  const queryClient = useQueryClient();
  const { notice, headingRef, announce } = useActionNotice();

  async function revokeConsent(consentId: string): Promise<ActionOutcome> {
    try {
      await revoke.mutateAsync({ userId, consentId });
      return { done: "Consent revoked." };
    } catch (err) {
      if (err instanceof AdminRequestError && err.code === "not_found") {
        void queryClient.invalidateQueries({ queryKey: adminKeys.users.all });
        return { done: "This consent was already revoked." };
      }
      // Not idempotent (DEBT-151): an unknown outcome closes the dialog, the list is reloaded.
      if (!(err instanceof AdminRequestError) || err.uncertain) return { done: CONSENT_UNCERTAIN };
      return outcomeOf(err, CONSENT_UNCERTAIN);
    }
  }

  return (
    <Section id="consents-title" title="Consents" headingRef={headingRef} notice={notice}>
      {consents.data === undefined || consents.isError ? (
        <LoadState query={consents} what="consents" />
      ) : consents.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{pager.after ? "No more consents." : "No active consent."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="Consents" className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className={`${cell} font-medium`}>Client</th>
                <th scope="col" className={`${cell} font-medium`}>Resource</th>
                <th scope="col" className={`${cell} font-medium`}>Granted scopes</th>
                <th scope="col" className={`${cell} font-medium`}>Granted</th>
                <th scope="col" className={`${cell} font-medium`}>Updated</th>
                <th scope="col" className="py-1 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {consents.data.items.map((c) => (
                <tr key={c.id} className="border-t align-top">
                  <td className={`${cell} break-all`}>{c.clientId}</td>
                  <td className={`${cell} break-all`}>{c.resource}</td>
                  <td className={`${cell} break-all`}>{c.grantedScopes.join(" ") || "—"}</td>
                  <td className={cell}>{c.grantedAt}</td>
                  <td className={cell}>{c.updatedAt}</td>
                  <td className="py-1 font-sans">
                    {writable && (
                      <ConfirmAction
                        trigger="Revoke"
                        triggerLabel={`Revoke consent for ${c.clientId}`}
                        title="Revoke this consent?"
                        confirmLabel="Revoke consent"
                        destructive
                        path={path}
                        run={() => revokeConsent(c.id)}
                        onDone={announce}
                      >
                        <p>
                          The user will be asked for consent again. The refresh tokens of this client for this resource are
                          revoked.
                        </p>
                      </ConfirmAction>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager label="Consents" after={pager.after} next={consents.data?.nextCursor} setAfter={pager.setAfter} />
    </Section>
  );
}
