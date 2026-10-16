/**
 * Whether the dev/test-only demo resource (`GET /demo/me`, B6.5) is enabled for this process.
 *
 * This reads the RAW `NODE_ENV` (an allowlist), NOT the typed `app.nodeEnv`: `configuration.ts`
 * defaults an unset `NODE_ENV` to `development` via zod, so `env.NODE_ENV !== 'production'` would
 * WRONGLY enable the demo surface when `NODE_ENV` is unset (Q-24.2 / DEBT-098). An unset or any
 * non-`development`/`test` value — including `production` — therefore keeps the demo OFF
 * (fail-closed; never fail-open to the demo attack surface).
 *
 * Shared by `AppModule` (`ConditionalModule.registerWhen`) and `main.ts` (CORS preflight) so the
 * module wiring and the preflight path can never disagree about whether the demo is live.
 */
export function isDemoEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}
