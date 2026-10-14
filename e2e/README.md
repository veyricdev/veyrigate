# E2E — Playwright walking-skeleton (X1)

One Chromium scenario that drives the full OIDC login flow across the BE IdP and the
`fe-sso-test` SPA, proving a user can sign in and see their ID-token claims — with tokens never
leaking into the DOM, URL, or Web Storage.

## What it runs

`playwright.config.ts` starts and health-gates two servers before the suite:

- **BE (:4000)** — `pnpm -C be build && db:sync-indexes && db:seed-dev && start` (from `dist`, no
  watch). Ready only when `GET http://127.0.0.1:4000/ready` returns 200 (Mongo + Redis up).
- **FE (:5173)** — `pnpm -C fe-sso-test dev` (Vite, strictPort). Ready on `GET /`.

All BE/FE env is injected via `webServer.env` (`config/env.ts`) — the suite never reads the real
`be/.env`. It uses an isolated namespace so it never touches dev data:

- Mongo `mongodb://localhost:27017/sso-idp-e2e?directConnection=true`
- Redis `redis://localhost:6379/2`
- SMTP `smtp://localhost:1025` (Mailpit; no mail sent in X1)

No database is ever flushed or dropped.

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
`ADMIN_SEED_EMAIL`):

```bash
cp e2e/.env.example e2e/.env   # then set DEV_SEED_PASSWORD
```

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
