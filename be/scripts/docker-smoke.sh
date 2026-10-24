#!/usr/bin/env bash
# Smoke test of a built IdP backend image (run 53b, B7.3):
#   bash be/scripts/docker-smoke.sh <image-tag> [<build-stage-tag>]
# The optional second tag is the same Dockerfile built with `--target build`: it is only scanned for
# env/key files (the build stage must not have seen them either).
# Used locally and by the CI job `be-image`. Creates only the network vg-b73b-net, the containers
# vg-b73b-mongo, vg-b73b-redis, vg-b73b-vault (throwaway dev Vault with TLS) and vg-be-smoke-ok,
# vg-be-smoke-noenv, vg-be-smoke-local (all removed on exit), publishes 127.0.0.1:4400 only, never
# touches the image itself or any other container. Secrets (Vault root token, Mongo password, CSRF
# secret, Vault app token) are generated per run, passed with `-e NAME` or stdin (never on a command
# line, never in a host file) and never printed. Vault container logs are never printed (dev mode logs
# its unseal key).
set -euo pipefail
# Git Bash on Windows: keep /app, /tmp, ... as container paths (only for docker, curl needs host paths).
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }

IMAGE="${1:?usage: docker-smoke.sh <image-tag> [<build-stage-tag>]}"
BUILD_IMAGE="${2:-}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="http://127.0.0.1:4400"
NET=vg-b73b-net
# Support images: release >= 14 days old, pinned by index digest (`docker buildx imagetools inspect`).
MONGO_IMAGE=mongo:7.0.43@sha256:1f995ad6fdb93244a1addab1b58f934a0bc2f5643c38e02f5e9d7f0c7d227a7b
REDIS_IMAGE=redis:7.4.10-bookworm@sha256:e9b2e45ecd47fbb69b877cf8d045d5cccaaaed52524b6e098b4abe8212994f73
VAULT_IMAGE=hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55
NAMES=(vg-be-smoke-ok vg-be-smoke-noenv vg-be-smoke-local vg-b73b-mongo vg-b73b-redis vg-b73b-vault)
TMP="$(mktemp -d)"
remove_all() {
  docker rm -f "${NAMES[@]}" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
cleanup() {
  remove_all
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FAIL check $1: $2" >&2
  exit 1
}
pass() { echo "ok   check $1: $2"; }
secret() { node -e "process.stdout.write(require('crypto').randomBytes(${1:-32}).toString('hex'))"; }
# GitHub Actions: hide a generated value in the job log (no-op elsewhere).
mask() { [ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$1"; }
# Vault CLI inside the Vault container, authenticated with the root token (setup only).
VAULT_CLI=(-e VAULT_TOKEN -e VAULT_ADDR=https://127.0.0.1:8200 -e VAULT_CACERT=/vault/file/vault-ca.pem)
vault_root() { VAULT_TOKEN="$VAULT_ROOT" docker exec -i "${VAULT_CLI[@]}" vg-b73b-vault vault "$@"; }

VAULT_ROOT="$(secret 16)"
MONGO_PASSWORD="$(secret 24)"
mask "$VAULT_ROOT"
mask "$MONGO_PASSWORD"
export VAULT_DEV_ROOT_TOKEN_ID="$VAULT_ROOT" MONGO_INITDB_ROOT_USERNAME=smoke MONGO_INITDB_ROOT_PASSWORD="$MONGO_PASSWORD"

# App env (fake, unreachable SMTP/issuer; .invalid never resolves).
export ISSUER=https://idp.example.invalid
export MONGO_URI="mongodb://smoke:${MONGO_PASSWORD}@vg-b73b-mongo:27017/sso-idp?authSource=admin"
export REDIS_URL=redis://vg-b73b-redis:6379/0
export ACCESS_TOKEN_TTL=900 REFRESH_TOKEN_TTL=2592000 SESSION_IDLE_TTL=28800 SESSION_ABSOLUTE_TTL=2592000
export SMTP_URL=smtp://127.0.0.1:1 ADMIN_SEED_EMAIL=admin@example.invalid
export RATE_LIMIT_WINDOW=60 RATE_LIMIT_MAX=100
export KEY_PROVIDER=vault VAULT_ADDR=https://vg-b73b-vault:8200 VAULT_TRANSIT_KEY=idp-signer
export VAULT_TOKEN_FILE=/tmp/vault/token NODE_EXTRA_CA_CERTS=/tmp/vault/ca.pem
CSRF_SECRET="$(secret)"
mask "$CSRF_SECRET"
export CSRF_SECRET
HARDEN=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges)
ENV_ARGS=(-e ISSUER -e MONGO_URI -e REDIS_URL -e ACCESS_TOKEN_TTL -e REFRESH_TOKEN_TTL -e SESSION_IDLE_TTL
  -e SESSION_ABSOLUTE_TTL -e SMTP_URL -e ADMIN_SEED_EMAIL -e RATE_LIMIT_WINDOW -e RATE_LIMIT_MAX
  -e KEY_PROVIDER -e VAULT_ADDR -e VAULT_TRANSIT_KEY -e VAULT_TOKEN_FILE -e NODE_EXTRA_CA_CERTS)

remove_all
docker network create "$NET" >/dev/null
docker run -d --name vg-b73b-mongo --network "$NET" -e MONGO_INITDB_ROOT_USERNAME -e MONGO_INITDB_ROOT_PASSWORD \
  "$MONGO_IMAGE" >/dev/null
docker run -d --name vg-b73b-redis --network "$NET" "$REDIS_IMAGE" >/dev/null
# Dev Vault with a generated TLS CA (production requires an https VAULT_ADDR); the certificate names the
# container hostname, so the app verifies it with only that CA added (NODE_EXTRA_CA_CERTS).
docker run -d --name vg-b73b-vault --hostname vg-b73b-vault --network "$NET" --cap-add=IPC_LOCK \
  -e VAULT_DEV_ROOT_TOKEN_ID "$VAULT_IMAGE" \
  server -dev -dev-tls -dev-listen-address=0.0.0.0:8200 -dev-tls-cert-dir=/vault/file >/dev/null

for _ in $(seq 1 30); do
  vault_root status >/dev/null 2>&1 && break
  sleep 1
done
vault_root status >/dev/null 2>&1 || fail 0 "Vault did not start within 30 s"
# Same setup as runbook-deploy section 8: non-exportable RSA key + least-privilege policy + app token.
vault_root secrets enable transit >/dev/null
vault_root write -f transit/keys/idp-signer type=rsa-2048 exportable=false allow_plaintext_backup=false >/dev/null
sed -e 's#<mount>#transit#g' -e 's#<key>#idp-signer#g' "$REPO/ops/vault/idp-signer.hcl" |
  vault_root policy write idp-signer - >/dev/null
APP_TOKEN="$(vault_root token create -policy=idp-signer -ttl=1h -field=token)"
[ -n "$APP_TOKEN" ] || fail 0 "no Vault app token"
mask "$APP_TOKEN"
vault_root read -format=json transit/keys/idp-signer >"$TMP/vault-key.json"
docker exec vg-b73b-vault cat /vault/file/vault-ca.pem >"$TMP/vault-ca.pem"

# The app runs the image command (`node dist/main.js`) as soon as the token file exists (Vault Agent
# sink in production). The token goes in through stdin into the container's tmpfs, never through env,
# argv or a host file. Checks 9 and 10 run the image's own CMD unchanged.
docker run -d --name vg-be-smoke-ok --network "$NET" "${HARDEN[@]}" -p 127.0.0.1:4400:4000 "${ENV_ARGS[@]}" -e CSRF_SECRET \
  --entrypoint sh "$IMAGE" -c 'until [ -s /tmp/vault/token ]; do sleep 0.2; done; exec node dist/main.js' >/dev/null
docker exec -i vg-be-smoke-ok sh -c 'umask 077; mkdir -p /tmp/vault; cat > /tmp/vault/ca.pem' <"$TMP/vault-ca.pem"
printf '%s' "$APP_TOKEN" |
  docker exec -i vg-be-smoke-ok sh -c 'umask 077; cat > /tmp/vault/token.tmp && mv /tmp/vault/token.tmp /tmp/vault/token'
unset APP_TOKEN

# 1. non-root
user="$(docker image inspect -f '{{.Config.User}}' "$IMAGE")"
[ "$user" = "1000:1000" ] || fail 1 "image user is '$user', expected 1000:1000"
uid="$(docker exec vg-be-smoke-ok id -u)"
[ "$uid" != "0" ] || fail 1 "container runs as root"
owner="$(docker exec vg-be-smoke-ok stat -c '%u' /app/dist/main.js)"
[ "$owner" = "0" ] || fail 1 "/app/dist/main.js owned by uid $owner, expected root"
pass 1 "user 1000:1000, uid $uid, app files owned by root"

# 2. healthy (image HEALTHCHECK on /health) within 90 s
status=""
for _ in $(seq 1 90); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' vg-be-smoke-ok 2>/dev/null || echo gone)"
  [ "$status" = "healthy" ] && break
  [ "$status" != "none" ] || break
  [ "$(docker inspect -f '{{.State.Running}}' vg-be-smoke-ok 2>/dev/null)" = "true" ] || break
  sleep 1
done
[ "$status" = "healthy" ] || { docker logs vg-be-smoke-ok 2>&1 | tail -n 20 | cut -c1-400 >&2; fail 2 "health status '$status'"; }
grep -qF "/health')" <<<"$(docker image inspect -f '{{json .Config.Healthcheck.Test}}' "$IMAGE")" ||
  fail 2 "HEALTHCHECK does not probe /health"
pass 2 "healthy (HEALTHCHECK on /health)"

# 3. /health 200
code="$(curl -sS -o "$TMP/b" -w '%{http_code}' "$BASE/health")"
[ "$code" = "200" ] && grep -q '"status":"ok"' "$TMP/b" || fail 3 "/health answered $code"
pass 3 "/health 200"

# 4. /ready 200 (Mongo with auth + Redis up)
code=""
for _ in $(seq 1 30); do
  code="$(curl -sS -o "$TMP/b" -w '%{http_code}' "$BASE/ready")"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] && grep -q '"status":"ok"' "$TMP/b" || fail 4 "/ready answered $code"
pass 4 "/ready 200 mongo up, redis up"

# 5. /jwks.json serves exactly the Vault Transit public key (kid = RFC 7638 thumbprint)
code="$(curl -sS -o "$TMP/jwks.json" -w '%{http_code}' "$BASE/jwks.json")"
[ "$code" = "200" ] || fail 5 "/jwks.json answered $code"
node -e '
  const fs = require("fs"), { createPublicKey, createHash } = require("crypto");
  const [vaultFile, jwksFile] = process.argv.slice(1);
  const v = JSON.parse(fs.readFileSync(vaultFile, "utf8")).data;
  const jwk = createPublicKey(v.keys[String(v.latest_version)].public_key).export({ format: "jwk" });
  const keys = JSON.parse(fs.readFileSync(jwksFile, "utf8")).keys;
  const kid = createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: "RSA", n: jwk.n })).digest("base64url");
  const ok = keys.length === 1 && keys[0].n === jwk.n && keys[0].e === jwk.e && keys[0].kid === kid &&
    keys[0].alg === "RS256" && keys[0].use === "sig" && !("d" in keys[0]);
  process.exit(ok ? 0 : 1);
' "$TMP/vault-key.json" "$TMP/jwks.json" || fail 5 "JWKS is not the Vault Transit key"
pass 5 "/jwks.json = Vault Transit key v1, kid = thumbprint, no private part"

# 6. no .env in the app dir (main.ts would load it), no env/key files anywhere in the image
docker exec vg-be-smoke-ok sh -c '[ ! -e /app/.env ]' || fail 6 "/app/.env exists"
# (npm's own empty /usr/local/lib/node_modules/npm/.npmrc comes with the base image)
scan='find / -xdev \( -path /proc -o -path /usr/local/lib/node_modules/npm/.npmrc \) -prune -o \( -name ".env*" -o -name "*.pem" -o -name "*.key" -o -name "*.p12" -o -name "*.pfx" -o -name ".npmrc" -o -path "*/be/keys" -o -name ".keys" \) -print 2>/dev/null; true'
found="$(docker run --rm --user 0:0 --entrypoint sh "$IMAGE" -c "$scan")"
[ -z "$found" ] || fail 6 "env/key files in the image: $(echo "$found" | head -n5 | tr '\n' ' ')"
if [ -n "$BUILD_IMAGE" ]; then
  found="$(docker run --rm --user 0:0 --entrypoint sh "$BUILD_IMAGE" -c "$scan")"
  [ -z "$found" ] || fail 6 "env/key files in the build stage: $(echo "$found" | head -n5 | tr '\n' ' ')"
fi
docker run --rm --entrypoint sh "$IMAGE" -c \
  'for p in /app/src /app/test /app/keys /app/node_modules/typescript /app/node_modules/jest /app/node_modules/ts-node /app/node_modules/@nestjs/cli /app/node_modules/@nestjs/testing; do [ ! -e "$p" ] || { echo "$p"; exit 1; }; done; [ -z "$(find /app/dist \( -name "*.map" -o -name "*.d.ts" \) | head -n1)" ]' ||
  fail 6 "sources/tests/dev deps/maps in the image"
if docker history --no-trunc "$IMAGE" | grep -qE 'SECRET=|PASSWORD=|TOKEN=|mongodb://|redis://'; then fail 6 "secret-like value in history"; fi
envs="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" | cut -d= -f1 | grep -v '^$' | sort | tr '\n' ' ')"
[ "$envs" = "NODE_ENV NODE_VERSION PATH PORT YARN_VERSION " ] || fail 6 "unexpected image env: $envs"
pass 6 "no /app/.env, no env/key files${BUILD_IMAGE:+ (runtime + build stage)}, no src/test/dev deps/maps, clean history and env"

# 7. Redis down => liveness stays 200, readiness 503 (a Redis outage must not restart the container)
docker stop -t 2 vg-b73b-redis >/dev/null
code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/health")"
[ "$code" = "200" ] || fail 7 "/health answered $code with Redis down"
code="$(curl -sS -o "$TMP/b" -w '%{http_code}' "$BASE/ready")"
[ "$code" = "503" ] && grep -q '"redis":"down"' "$TMP/b" || fail 7 "/ready answered $code with Redis down"
[ "$(docker inspect -f '{{.State.Running}}' vg-be-smoke-ok)" = "true" ] || fail 7 "app exited with Redis down"
pass 7 "Redis down => /health 200, /ready 503 redis down"

# Redis back before the stop check: with Redis down the shutdown hook `redis.quit()` waits on the
# reconnecting client and `docker stop` ends in SIGKILL (137) - DEBT-397, fixed with run 53c.
docker start vg-b73b-redis >/dev/null
for _ in $(seq 1 30); do
  [ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/ready")" = "200" ] && break
  sleep 1
done

# 8. docker stop => clean exit on SIGTERM (not killed)
docker stop -t 15 vg-be-smoke-ok >/dev/null
exit_code="$(docker inspect -f '{{.State.ExitCode}}' vg-be-smoke-ok)"
[ "$exit_code" = "0" ] || [ "$exit_code" = "143" ] || fail 8 "exit code $exit_code after docker stop"
pass 8 "docker stop => exit $exit_code"

# 9. a missing variable => exit != 0 within 20 s, log names it, never prints a value (canary)
CANARY="$(secret 20)"
mask "$CANARY"
METRICS_TOKEN="$CANARY" MONGO_URI="mongodb://smoke:${CANARY}@vg-b73b-mongo:27017/sso-idp?authSource=admin" \
  docker run -d --name vg-be-smoke-noenv --network "$NET" "${HARDEN[@]}" "${ENV_ARGS[@]}" -e METRICS_TOKEN \
  "$IMAGE" >/dev/null
exit_code="$(timeout 20 docker wait vg-be-smoke-noenv || echo timeout)"
[ "$exit_code" != "timeout" ] && [ "$exit_code" != "0" ] || fail 9 "missing CSRF_SECRET: exit '$exit_code'"
docker logs vg-be-smoke-noenv >"$TMP/log" 2>&1
grep -q CSRF_SECRET "$TMP/log" || fail 9 "log does not name CSRF_SECRET"
if grep -qF -- "$CANARY" "$TMP/log"; then fail 9 "log contains the canary value"; fi
pass 9 "missing CSRF_SECRET => exit $exit_code, named, canary absent"

# 10. production refuses the dev-only local key provider (PEM files on disk)
KEY_PROVIDER=local docker run -d --name vg-be-smoke-local --network "$NET" "${HARDEN[@]}" "${ENV_ARGS[@]}" \
  -e CSRF_SECRET -e KEY_LOCAL_DIR=/tmp/keys "$IMAGE" >/dev/null
exit_code="$(timeout 20 docker wait vg-be-smoke-local || echo timeout)"
[ "$exit_code" != "timeout" ] && [ "$exit_code" != "0" ] || fail 10 "KEY_PROVIDER=local: exit '$exit_code'"
docker logs vg-be-smoke-local 2>&1 | grep -q 'KEY_PROVIDER must be vault' || fail 10 "log does not name KEY_PROVIDER"
pass 10 "KEY_PROVIDER=local in production => exit $exit_code"

# 11. the whole log of the app run (boot, Vault, Redis outage, shutdown) holds none of the secrets
docker logs vg-be-smoke-ok >"$TMP/log" 2>&1
for value in "$MONGO_PASSWORD" "$CSRF_SECRET" "$VAULT_ROOT"; do
  if grep -qF -- "$value" "$TMP/log"; then fail 11 "app log contains a secret value"; fi
done
if grep -qE 'hvs\.|X-Vault-Token|/tmp/vault/token' "$TMP/log"; then fail 11 "app log mentions the Vault token or its file"; fi
pass 11 "app log: no Mongo password, CSRF secret, Vault token or token path"

echo "docker-smoke: 11/11 passed for $IMAGE"
