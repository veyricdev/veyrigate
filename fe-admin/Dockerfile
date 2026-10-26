# fe-admin BFF image (run 52, A9). Build from the repo root:
#   docker build -f fe-admin/Dockerfile -t <tag> .
# Ignore rules: fe-admin/Dockerfile.dockerignore (allowlist). No secret is needed to build and none
# goes into a layer: configuration is the runtime env only (see docs runbook-deploy.md section 7).
# Base pinned by index digest; refresh with `docker buildx imagetools inspect node:<version>-bookworm-slim`
# (release >= 14 days old, same version as .nvmrc / engines).
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

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
COPY fe-admin/package.json fe-admin/
RUN pnpm install --frozen-lockfile --filter @sso-idp/fe-admin...
COPY fe-admin/ fe-admin/
RUN pnpm -C fe-admin build && pnpm -C fe-admin check:bundle
# Production deps only, then keep just what the runtime needs (no src/, test/, config files).
RUN pnpm --filter @sso-idp/fe-admin deploy --prod /deploy \
 && mkdir /out \
 && cp -a /deploy/package.json /deploy/node_modules /out/ \
 && cp -a fe-admin/dist fe-admin/serve.mjs /out/

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
# Files owned by root: the runtime user cannot change the app.
COPY --from=build /out /app
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
CMD ["node","serve.mjs"]
