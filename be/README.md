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

## Bootstrap seed (`db:seed`, B6.4)

Seeds the admin bootstrap on top of the dev seed: tenant `default-tenant`, resource `admin`
(`${ISSUER}/admin/`, scopes `admin.read admin.write`), the `ADMIN_SEED_EMAIL` user as `super_admin` of
`default-tenant`, the confidential client `fe-admin` (`client_secret_basic`, redirect
`http://localhost:3000/auth/callback`, resource `admin`) and — via `seedDev` — `fe-sso-test` + `demo`/`other`.
Dev/test only (`NODE_ENV=development|test`; production is refused before connecting — DEBT-164).

```sh
# be/.env (git-ignored)
ADMIN_SEED_EMAIL=admin@example.com
ADMIN_SEED_PASSWORD=<12..128 chars>   # stricter than the user rule: this is a super_admin
# ADMIN_SEED_PASSWORD is read by `db:seed` only — the app does not need it (empty is fine to boot, DEBT-169)
pnpm build && pnpm db:sync-indexes && pnpm db:seed
```

- **Secret shown once**: when `fe-admin` has no active credential the CLI creates one and prints
  `fe-admin client_secret (shown once): <secret>` on stdout — the only place it appears (not logged,
  not audited, not written to a file). Re-runs print nothing and never rotate it.
- **Lost the secret while it is still active**: revoke every `fe-admin` credential, then re-run
  `pnpm db:seed` (prints a new one):
  `db.clientcredentials.updateMany({clientId:'fe-admin', revokedAt:null}, {$set:{revokedAt:new Date()}})`.
- **Resource `admin` re-point is refused (DEBT-137)**: if no `admin` resource carries `${ISSUER}/admin/`
  yet (absent, created via the API with another identifier, or an ISSUER change) and a client other than
  `fe-admin` already lists `admin` (or `fe-admin` itself while the old identifier is not an `/admin/`
  URI), the seed throws before any write: that client would become admin-capable without the admin-API
  checks. Remove the reference first. At runtime a public client never gets `aud=admin` (DEBT-172).
- **Re-run never resets the admin**: an existing admin user keeps its password and any lock
  (`$setOnInsert`); `fe-admin` is insert-only too (API edits / a disable survive).
- **Recovery when no super_admin is left (DEBT-142)**: re-running re-activates the admin membership in
  `default-tenant` and re-adds `super_admin`.
- Fails (and stops before creating `fe-admin`) if the admin identifier is already registered under another
  `resourceId`. Two concurrent runs could each create and print a secret — run it once, sequentially.

## Signing keys (`KEY_PROVIDER=local`, dev-only)

`LocalKeyProvider` keeps PEMs + `keys.json` in `KEY_LOCAL_DIR` and refuses `NODE_ENV=production`.
Rotations are serialised by an **in-process** mutex and the read paths (`/jwks.json`, verify, sign)
never write `keys.json` (DEBT-145). The mutex does not span processes: run **one** IdP process per
`KEY_LOCAL_DIR`. Multi-node needs the KMS/Vault provider (plan B7.3, DEBT-159).
