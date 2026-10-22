# E2E — Playwright walking-skeleton (X1)

One Chromium scenario that drives the full OIDC login flow across the BE IdP and the
`fe-sso-test` SPA, proving a user can sign in and see their ID-token claims — with tokens never
leaking into the DOM, URL, or Web Storage.

## What it runs

`playwright.config.ts` starts and health-gates two servers before the suite:

- **BE (:4000)** — `pnpm -C be build && db:sync-indexes && db:seed-dev && start` (from `dist`, no
  watch). Ready only when `GET http://127.0.0.1:4000/ready` returns 200 (Mongo + Redis up).
- **FE (:5173)** — `pnpm -C fe-sso-test dev` (Vite, strictPort). Ready on `GET /`.
- **fe-admin (:3000)** — `pnpm -C fe-admin dev` (admin BFF, strictPort), env from `feAdminEnv()`
  (sessions in Redis `/2` under `fea:*`). Ready on `GET /` (redirect to its login route).

All BE/FE env is injected via `webServer.env` (`config/env.ts`) — the suite never reads the real
`be/.env`. It uses an isolated namespace so it never touches dev data:

- Mongo `mongodb://localhost:27017/sso-idp-e2e?directConnection=true`
- Redis `redis://localhost:6379/2`
- SMTP `smtp://localhost:1025` (Mailpit; no mail sent in X1)

No database is ever flushed or dropped.

The BE signing keyset is isolated too: `KEY_LOCAL_DIR` points at `e2e/.keys` (git-ignored,
auto-created by `LocalKeyProvider.init()`), so the E2E run never writes to or prunes the dev
keyset in `be/keys`.

## Specs

- `login.spec.ts` — X1 walking skeleton (login → claims).
- `api-test.spec.ts` — T4 `/api-test`: A `/demo/me` 200, B wrong-aud probe (redirect chain) 401 with
  the same `sub` after the silent restore, C `/userinfo` 200.
- `fe-admin.spec.ts` — fe-admin BFF login as the E2E admin (email shown, cookie httpOnly, no JWT in
  Web Storage / HTML / `/_serverFn`), RP-initiated logout ends the IdP session; forged callback.
- `lab.spec.ts` — dev-only `/lab` smoke: `/authorize` tampering scenarios, forged `state`, and the
  refresh-token replay (last: it revokes the token family).

Shared helpers live in `tests/support/oidc.ts` (raw tokens of every `POST /token` 200 are captured
to assert they never reach the DOM, URL, or Web Storage).

## Prerequisites

The three shared dev containers must be running (do **not** `docker compose up` or stop them):

- `aegate-mongo` on `:27017`
- `aegate-redis` on `:6379`
- `veyrigate-mailpit-1` on `:1025`

Install the Chromium browser once (local):

```bash
pnpm -C e2e exec playwright install chromium
```

Provide the dev-user credential (must match what `db:seed-dev` upserts and differ from
`ADMIN_SEED_EMAIL`). `config/env.ts` loads `e2e/.env` automatically if present:

```bash
cp e2e/.env.example e2e/.env   # then set DEV_SEED_PASSWORD
```

`DEV_SEED_PASSWORD` is **required**: if it is missing/empty (and not set in the environment) the
suite fails fast with a clear error — there is no default password.

## Run

```bash
# From the repo root — Playwright builds/seeds/starts BE+FE automatically:
DEV_SEED_EMAIL=dev@example.com DEV_SEED_PASSWORD=<pw> pnpm -C e2e e2e
# or via the root alias:
pnpm e2e
```

Set `E2E_REUSE=1` to reuse BE/FE servers you already started yourself (then their env wins, not
`config/env.ts`).

## Manual demo (no Playwright)

```bash
# 1. Seed the dev client/resource/user on the E2E db:
MONGO_URI=mongodb://localhost:27017/sso-idp-e2e?directConnection=true \
  REDIS_URL=redis://localhost:6379/2 DEV_SEED_EMAIL=dev@example.com DEV_SEED_PASSWORD=<pw> \
  pnpm -C be db:seed-dev
# 2. Start BE + FE and open http://localhost:5173, click "Sign in".
```

> The `e2e` package script is deliberately named `e2e` (not `test`) so the root `pnpm test`
> (`pnpm -r run --if-present test`) never pulls Playwright or starts the webServers.
