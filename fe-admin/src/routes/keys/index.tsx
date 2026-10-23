import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PagePending } from "@/components/feedback/route-states";
import { ConfirmAction, outcomeOf, useActionNotice, type ActionOutcome } from "@/components/feedback/confirm-action";
import { useRotateSigningKey, useSigningKeys } from "@/features/admin-api/hooks";
import type { RotateKeyParams } from "@/features/admin-api/inputs";
import { AdminRequestError } from "@/features/admin-api/types";
import type { RotateKeyResult, SigningKey } from "@/server/admin-api/schemas";

/**
 * Signing keys of the IdP (run 49 A6.5): metadata only (kid, status, ISO times as text), normal and
 * emergency rotation. super_admin only: anyone else gets a fixed text and no server call (the BE
 * refuses reads too). A rotation is never re-sent: an unknown outcome re-reads the list and says
 * how to tell whether it was applied (compare the active `kid`).
 */
export const Route = createFileRoute("/keys/")({ component: KeysPage });

const PATH = "/keys";

const STATUS_TEXT: Record<SigningKey["status"], string> = {
  active: "Active — signs new tokens",
  retiring: "Retiring — verification only",
};

/** Active first, then the retiring keys by `retireAt` (soonest first). */
const ordered = (items: SigningKey[]) =>
  [...items].sort((a, b) =>
    a.status !== b.status ? (a.status === "active" ? -1 : 1) : (a.retireAt ?? "").localeCompare(b.retireAt ?? ""),
  );

function rotatedText(r: RotateKeyResult): string {
  if (r.mode === "emergency") {
    return `Emergency rotation done. New active key ${r.newKid}. Previous keys were removed from JWKS. Tell relying parties to refetch JWKS.`;
  }
  return `Rotated. New active key ${r.newKid}${r.oldKid ? `; ${r.oldKid} is now verification only` : ""}.`;
}

function uncertainText(kidBefore: string | undefined): string {
  const head = "The result is unknown and the request was not sent again. The key list has been reloaded";
  return kidBefore
    ? `${head}: if the active key is no longer ${kidBefore}, the rotation was applied — do not rotate again.`
    : `${head}.`;
}

const BY_CODE = { forbidden: "Only a super_admin can rotate signing keys." };

function KeysPage() {
  const { viewer } = Route.useRouteContext();
  const superAdmin = viewer.roles.includes("super_admin");
  return (
    <section aria-labelledby="keys-title" className="space-y-6">
      <h1 id="keys-title" className="text-2xl font-semibold">
        Signing keys
      </h1>
      {superAdmin ? (
        <Keys />
      ) : (
        // UX only (the BE enforces it): no request just to be refused.
        <p>Only a super_admin can view and rotate signing keys.</p>
      )}
    </section>
  );
}

function Keys() {
  const query = useSigningKeys();
  const rotate = useRotateSigningKey();
  const { notice, headingRef, announce } = useActionNotice();
  const activeKid = query.data?.items.find((k) => k.status === "active")?.kid;

  async function run(mode: RotateKeyParams["mode"]): Promise<ActionOutcome> {
    const kidBefore = activeKid; // the key shown when the admin confirmed
    try {
      return { done: rotatedText(await rotate.mutateAsync({ mode })) };
    } catch (err) {
      // Unknown outcome (it may have rotated): close, announce, never re-send (DEBT-339 pattern).
      if (!(err instanceof AdminRequestError) || err.uncertain) return { done: uncertainText(kidBefore) };
      return outcomeOf(err, uncertainText(kidBefore), BY_CODE);
    }
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Keys published in the IdP JWKS. Only metadata is shown; private keys never leave the IdP.
      </p>
      <section aria-labelledby="rotation-title" className="space-y-3">
        <h2 id="rotation-title" ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
          Rotation
        </h2>
        <p role="status" className="text-sm">
          {notice}
        </p>
        <div className="flex flex-wrap gap-2">
          <ConfirmAction
            trigger="Rotate key"
            title="Rotate the signing key?"
            confirmLabel="Rotate key"
            path={PATH}
            run={() => run("normal")}
            onDone={announce}
          >
            <p>
              A new key signs new tokens. The current key stays in JWKS for verification until the tokens it signed
              expire (access-token lifetime). Nobody is signed out.
            </p>
          </ConfirmAction>
          <ConfirmAction
            trigger="Emergency rotation…"
            title="Emergency rotation?"
            confirmLabel="Rotate now"
            destructive
            confirmText="EMERGENCY"
            path={PATH}
            run={() => run("emergency")}
            onDone={announce}
            warning={<EmergencyWarning />}
          >
            <p>
              Use this only when a signing key may be compromised. Every previous key (active and retiring) is removed from
              JWKS at once and its private key is deleted; a new key signs from now on.
            </p>
          </ConfirmAction>
        </div>
      </section>
      {query.isPending ? (
        <PagePending />
      ) : query.isError ? (
        <div role="alert" className="space-y-3">
          <p>{query.error instanceof AdminRequestError ? query.error.message : "The signing keys could not be loaded."}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : query.data.items.length === 0 ? (
        <p>No signing keys.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Signing keys</caption>
            <thead className="border-b">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Key ID</th>
                <th scope="col" className="py-2 pr-4 font-medium">Algorithm</th>
                <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                <th scope="col" className="py-2 pr-4 font-medium">Created</th>
                <th scope="col" className="py-2 font-medium">Retires at</th>
              </tr>
            </thead>
            <tbody>
              {ordered(query.data.items).map((k) => (
                <tr key={k.kid} className="border-b align-top">
                  <th scope="row" className="py-2 pr-4 font-mono font-normal break-all">
                    {k.kid}
                  </th>
                  <td className="py-2 pr-4">{k.alg}</td>
                  <td className="py-2 pr-4">{STATUS_TEXT[k.status]}</td>
                  <td className="py-2 pr-4 font-mono">{k.createdAt}</td>
                  <td className="py-2 font-mono">{k.retireAt ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** The real consequences of an emergency rotation (run 49 Q-49.1): nothing more, nothing less. */
function EmergencyWarning() {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Every access token and ID token issued before the rotation is rejected by the IdP at once (admin API,
          /userinfo, /introspect, resources verified by the IdP), including this console&apos;s.
        </li>
        <li>
          Relying parties that verify tokens with a cached JWKS may keep accepting old tokens until they refetch it: tell
          them to refetch JWKS.
        </li>
        <li>
          Refresh tokens and IdP sessions are not revoked: clients get new tokens with their refresh token and users stay
          signed in to the IdP. If sessions may be stolen, revoke them separately.
        </li>
        <li>
          A relying-party sign-out with an id_token_hint issued before the rotation does not return to the application
          (the IdP&apos;s default page is shown).
        </li>
        <li>There is no rollback.</li>
      </ul>
      <p>This console&apos;s session will be refreshed; you may be asked to sign in again.</p>
      <p>
        <Link to="/audit" search={{ action: "SIGNING_KEY_ROTATED" }} className="underline underline-offset-4">
          Past key rotations in the audit log
        </Link>
      </p>
    </div>
  );
}
