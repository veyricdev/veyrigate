# E2E — Playwright walking-skeleton (X1)

One Chromium scenario that drives the full OIDC login flow across the BE IdP and the
`fe-sso-test` SPA, proving a user can sign in and see their ID-token claims — with tokens never
leaking into the DOM, URL, or Web Storage.

## What it runs

`playwright.config.ts` starts and health-gates two servers before the suite:

- **BE (:4000)** — `pnpm -C be build && node be/test/e2e/assert-dist-clean.mjs && db:sync-indexes &&
  db:seed-dev && seed:e2e-admin && start:e2e` (`start:e2e` = `ts-node test/e2e/e2e-main.ts`, no
  watch). Ready only when `GET http://127.0.0.1:4000/ready` returns 200 (Mongo + Redis up), within
  320 s: the chain takes ~69 s idle and ~104 s under a 28-thread CPU load (run 68, DEBT-464).
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

## X3 — cookie topology × browser matrix (`e2e:x3`, run 73)

A separate config (`playwright.x3.config.ts`, specs in `x3/`) so the default `e2e` run stays at its
size and speed. It checks the IdP session cookie (`__Host-idp_session`, `Secure`) across Chromium,
Firefox and WebKit, with one RP on the same site as the IdP and one on a different site:

| Name | Role | Upstream (http, loopback) |
| --- | --- | --- |
| `https://idp.alpha.localhost:8443` | IdP (`ISSUER`) | BE `127.0.0.1:4100` (`SESSION_COOKIE_SECURE=true`, `E2E_X3=1`) |
| `https://app.alpha.localhost:8443` | RP `x3-alpha`, same-site | fe-sso-test Vite `127.0.0.1:5273` |
| `https://app.beta.localhost:8443` | RP `x3-beta`, cross-site | fe-sso-test Vite `127.0.0.1:5274` |

- `*.localhost` resolves to loopback in all three browsers: no `hosts` change, no proxy flag.
- `x3/tls-proxy.mjs` (Node built-ins only) listens on **127.0.0.1:8443 only** and routes by `Host`.
  At start it generates a self-signed cert with **`openssl`** into `e2e/.x3-tls/` (git-ignored,
  2 days). The cert is never installed anywhere; browsers use `ignoreHTTPSErrors`. If `openssl` is
  missing (it ships with Git Bash) the proxy fails fast.
- Browsers: `pnpm -C e2e exec playwright install chromium firefox webkit` (revisions must match
  `@playwright/test`).
- Ports 4100/5273/5274/8443 must be free. **Never run it at the same time as `pnpm -C e2e e2e`**:
  both use the `sso-idp-e2e` DB and seed, and X3 re-points the `demo`/`other` resource identifiers to
  its https issuer (the default suite re-seeds them on its next run).
- Cases (× same-site/cross-site × 3 browsers): interactive login, SSO on a second RP, RP-initiated
  logout + cookie replay, cross-site POST without `_csrf`, Bearer fetch + credentialed fetch, cookie
  tossing from the sibling `app.alpha` (DEBT-008), `prompt=none` in an iframe (best-effort: result in
  the `x3-silent` annotation only, never fails).
- Cookie measurement: browser request headers for navigations/POST; for the credentialed fetch the
  proxy answers `https://idp.alpha.localhost:8443/__x3_echo` with the cookie **names** it received
  (a CORS-failed request exposes no `cookie` header to Playwright in Chromium/WebKit).
- Output: `test-results/x3-matrix.json` (cookie **names**, outcomes and browser versions only — never
  values or URLs with `code`). `trace`, video and screenshots are off.
- WebKit on Windows does not apply `SameSite` (DEBT-506), so its cells are recorded rather than
  asserted. It is not a stand-in for Safari.

```bash
pnpm -C e2e e2e:x3                      # all three browsers
pnpm -C e2e e2e:x3 --project chromium   # one browser
```

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
