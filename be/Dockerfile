# IdP backend image (run 53b, B7.3). Build from the repo root:
#   docker build -f be/Dockerfile -t <tag> .
# Ignore rules: be/Dockerfile.dockerignore (allowlist). No secret is needed to build and none goes into
# a layer: configuration is the runtime env only, the signing key lives in Vault Transit (production
# refuses KEY_PROVIDER=local), see docs runbook-deploy.md section 9.
# Base pinned by index digest, same as fe-admin/Dockerfile; refresh with
# `docker buildx imagetools inspect node:<version>-bookworm-slim` (release >= 14 days old, same version
# as .nvmrc / engines). Keep bookworm (glibc): @node-rs/argon2 ships a gnu binary, not musl.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

FROM ${NODE_IMAGE} AS build
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
