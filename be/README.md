# be

Placeholder package. Real scaffold (NestJS + Fastify IdP) happens at task **B1.1**.
Dev port: `http://localhost:4000` (`ISSUER`). See `docs/agile/sso-idp/plan.md` §1.

`NODE_ENV` is **required** (`development` | `test` | `production`, no default — DEBT-098): if it is
unset the app (and `db:sync-indexes` / `db:seed-dev`) refuses to start, naming `NODE_ENV`. `be/.env.example`
sets `development`; Jest sets `test`; the E2E harness (`e2e/config/env.ts`) sets `test`.

## Dev seed (`fe-sso-test` client + `demo` resource)

Interim dev-only provisioning for the `fe-sso-test` SPA (Task 4, interim for B6.4; DEBT-077).
Builds (`nest build`) then run the CLI — idempotent, runs only with `NODE_ENV=development|test` (unset/production refused), creates no secret:

```sh
pnpm build && pnpm db:seed-dev
```

## Dev user seed (DEBT-076)

The same `pnpm db:seed-dev` also upserts **one dev login user** so the `fe-sso-test` SPA can run the
full `/authorize` → login → `/token` flow against a local IdP. Credentials come from env, read **only**
by `seed-dev.ts` (a dedicated zod schema), deliberately **not** part of the app `envSchema` — so app
boot and the integration-test harness never start requiring these variables:

```sh
# be/.env (git-ignored) — NOT in envSchema
DEV_SEED_EMAIL=dev@example.com   # must differ from ADMIN_SEED_EMAIL
DEV_SEED_PASSWORD=<8..128 chars>
```

Behaviour:

- **Dev-only / fail-closed**: runs only with `NODE_ENV=development|test` (unset, empty, `production` or any
  other value is refused) _before_ any DB connection and again
  _before_ any write. Never touches a production database.
- **Verified email + no lock**: sets `emailVerifiedAt` on insert (so the login gate passes); every run
  resets `failedLoginCount` to 0 and clears `lockedUntil`, so a prior failed/locked run never blocks the
  next login.
- **Membership, no role**: upserts a `UserTenant` (default tenant, `status: active`, `roles: []`). The
  dev user is a plain non-admin — deliberately **separate** from the admin seed (`ADMIN_SEED_*`); a
  collision with `ADMIN_SEED_EMAIL` is rejected so the dev user can never inherit admin roles.
- **Idempotent**: keyed by the normalized email; running twice converges to one user + one membership.
- **Missing/invalid env** → fails fast naming the variable, before connecting. The password is never
  logged (stdout prints only `seed-dev: upserted user <id> <email>`).
- **Note (dev-only)**: if the email already exists (e.g. registered by hand), the seed **overwrites**
  its password hash. Acceptable because the tool is dev-only and refuses production.
