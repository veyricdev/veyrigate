import { useEffect, useState } from "react";
import { tokens } from "../oidc/client";

/** Fixed token type for a Bearer session (Q-24.3: `Session` has no `token_type` field). */
const TOKEN_TYPE = "Bearer";

/** Format a remaining-millis countdown as `mm:ss`, clamped at zero. */
function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Render an epoch-seconds timestamp as ISO-8601 UTC. */
function formatEpoch(value: number): string {
  const d = new Date(value * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(value);
}

/** Audience may be a string or array; render it stably. */
function formatAud(aud: string | string[]): string {
  return Array.isArray(aud) ? aud.join(", ") : aud;
}

/**
 * `/tokens`: show session token METADATA only (Q-24.3). We render which tokens are present
 * (access / ID / refresh), a live countdown to `accessTokenExpiresAt`, and the DECODED ID-token
 * claims. We NEVER render a raw token string and NEVER decode the access-token payload (it is
 * opaque to the RP). Behind the route guard.
 */
export default function Tokens() {
  const session = tokens.get();
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second to drive the countdown. Only runs while signed in.
  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [session]);

  if (!session) {
    return (
      <main>
        <h1>Tokens</h1>
        <p role="status">Not signed in.</p>
        <a href="/">Back to start</a>
      </main>
    );
  }

  const remainingMs = session.accessTokenExpiresAt - now;
  const expired = remainingMs <= 0;

  return (
    <main>
      <h1>Tokens</h1>
      <p>Session token metadata (no raw token values are shown).</p>
      <dl data-testid="token-metadata">
        <dt>access token</dt>
        <dd data-testid="meta-has-access">present</dd>
        <dt>ID token</dt>
        <dd data-testid="meta-has-id">present</dd>
        <dt>refresh token</dt>
        <dd data-testid="meta-has-refresh">{session.refreshToken ? "present" : "absent"}</dd>
        <dt>token type</dt>
        <dd data-testid="meta-token-type">{TOKEN_TYPE}</dd>
        <dt>access token expires at</dt>
        <dd data-testid="meta-expires-at">{formatEpoch(Math.floor(session.accessTokenExpiresAt / 1000))}</dd>
        <dt>expires in</dt>
        <dd data-testid="meta-countdown" aria-live="polite">
          {expired ? "expired" : formatCountdown(remainingMs)}
        </dd>
      </dl>
      <h2>Decoded ID-token claims</h2>
      <dl data-testid="token-id-claims">
        <dt>sub</dt>
        <dd data-testid="token-claim-sub">{session.claims.sub}</dd>
        <dt>iss</dt>
        <dd data-testid="token-claim-iss">{session.claims.iss}</dd>
        <dt>aud</dt>
        <dd data-testid="token-claim-aud">{formatAud(session.claims.aud)}</dd>
        <dt>exp</dt>
        <dd data-testid="token-claim-exp">{formatEpoch(session.claims.exp)}</dd>
      </dl>
      <nav>
        <a href="/">Home</a>
      </nav>
    </main>
  );
}