# be

Placeholder package. Real scaffold (NestJS + Fastify IdP) happens at task **B1.1**.
Dev port: `http://localhost:4000` (`ISSUER`). See `docs/agile/sso-idp/plan.md` §1.

## Dev seed (`fe-sso-test` client + `demo` resource)

Interim dev-only provisioning for the `fe-sso-test` SPA (Task 4, interim for B6.4; DEBT-077).
Builds (`nest build`) then run the CLI — idempotent, refuses `NODE_ENV=production`, creates no secret:

```sh
pnpm build && pnpm db:seed-dev
```
