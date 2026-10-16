import { tokens } from "../oidc/client";

/** Audience may be a string or array; render it stably. */
function formatAud(aud: string | string[]): string {
  return Array.isArray(aud) ? aud.join(", ") : aud;
}

/** Render an epoch-seconds timestamp as ISO-8601 UTC, falling back to the raw value. */
function formatEpoch(value: number): string {
  const d = new Date(value * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(value);
}

/** The core claims we surface with their own testids; everything else lands in the extra table. */
const CORE_CLAIMS = new Set(["sub", "iss", "aud", "exp", "iat", "nonce", "azp"]);

/** Stringify an unknown extra claim for display (objects/arrays as JSON, primitives as text). */
function formatExtra(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * `/profile`: display the DECODED ID-token claims of the current session. Only ID-token claims
 * are shown — the access token stays opaque and no raw token string is ever rendered (exposure
 * budget / OPEN-1). The route is behind the guard, so `session` is non-null when this renders;
 * a defensive fallback keeps it safe if reached directly.
 */
export default function Profile() {
  const session = tokens.get();
  if (!session) {
    return (
      <main>
        <h1>Profile</h1>
        <p role="status">Not signed in.</p>
        <a href="/">Back to start</a>
      </main>
    );
  }

  const claims = session.claims;
  const extras = Object.entries(claims).filter(([k]) => !CORE_CLAIMS.has(k));

  return (
    <main>
      <h1>Profile</h1>
      <p>Decoded ID-token claims for the current session.</p>
      <dl data-testid="profile-claims">
        <dt>sub</dt>
        <dd data-testid="profile-sub">{claims.sub}</dd>
        <dt>iss</dt>
        <dd data-testid="profile-iss">{claims.iss}</dd>
        <dt>aud</dt>
        <dd data-testid="profile-aud">{formatAud(claims.aud)}</dd>
        <dt>exp</dt>
        <dd data-testid="profile-exp">{formatEpoch(claims.exp)}</dd>
        <dt>iat</dt>
        <dd data-testid="profile-iat">{formatEpoch(claims.iat)}</dd>
        {claims.nonce !== undefined ? (
          <>
            <dt>nonce</dt>
            <dd data-testid="profile-nonce">{claims.nonce}</dd>
          </>
        ) : null}
        {claims.azp !== undefined ? (
          <>
            <dt>azp</dt>
            <dd data-testid="profile-azp">{claims.azp}</dd>
          </>
        ) : null}
      </dl>
      {extras.length > 0 ? (
        <dl data-testid="profile-extra">
          {extras.map(([key, value]) => (
            <ReadonlyClaim key={key} name={key} value={value} />
          ))}
        </dl>
      ) : null}
      <nav>
        <a href="/">Home</a>
      </nav>
    </main>
  );
}

/** One extra (non-core) claim row. */
function ReadonlyClaim({ name, value }: { name: string; value: unknown }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{formatExtra(value)}</dd>
    </>
  );
}