# IdP backend image (run 53b, B7.3). Build from the repo root:
#   docker build -f be/Dockerfile -t <tag> .
# Ignore rules: be/Dockerfile.dockerignore (allowlist). No secret is needed to build and none goes into
# a layer: configuration is the runtime env only, the signing key lives in Vault Transit (production
# refuses KEY_PROVIDER=local), see docs runbook-deploy.md section 9.
# Base pinned by index digest, same as fe-admin/Dockerfile; refresh with
# `docker buildx imagetools inspect node:<version>-bookworm-slim` (release >= 14 days old, same version
# as .nvmrc / engines). Keep bookworm (glibc): @node-rs/argon2 ships a gnu binary, not musl.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM ${NODE_IMAGE} AS build
# DEBT-398: fail closed if the build context holds anything secret-looking (an ignore rule was
# lost). First step, on a read-only bind mount of the context: nothing reaches a layer or the cache.
# Names only (never contents); src/modules/keys, src/routes/keys are code, so no bare `*/keys/*`.
RUN --mount=type=bind,target=/ctx sh -ec 'cd /ctx; \
  bad=$(find . \( -name ".env*" -o -name "*.pem" -o -name "*.key" -o -name "*.p12" -o -name "*.pfx" \
    -o -name ".npmrc" -o -path "./be/keys" -o -path "./be/keys/*" -o -path "*/.keys" -o -path "*/.keys/*" \) -print); \
  if [ -n "$bad" ]; then echo "secret-looking files in the build context (check the .dockerignore):" >&2; \
    echo "$bad" >&2; exit 1; fi'
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY be/package.json be/
RUN pnpm install --frozen-lockfile --filter @sso-idp/be...
COPY be/ be/
RUN pnpm -C be build
# Production deps only, then keep just what the runtime needs: compiled JS + views + public (no src/,
# test/, typings, source maps, build info).
RUN pnpm --filter @sso-idp/be deploy --prod /deploy \
 && mkdir /out \
 && cp -a /deploy/package.json /deploy/node_modules /out/ \
 && cp -a be/dist /out/dist \
 && find /out/dist \( -name '*.d.ts' -o -name '*.map' -o -name '*.tsbuildinfo' \) -delete

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=4000
WORKDIR /app
# Files owned by root: the runtime user cannot change the app (nor create /app/.env, which main.ts
# would load).
COPY --from=build /out /app
USER 1000:1000
EXPOSE 4000
# Liveness only (/health). Never /ready: a Redis or Mongo outage must not make the orchestrator
# restart every container.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
CMD ["node","dist/main.js"]
