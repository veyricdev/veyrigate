#!/usr/bin/env bash
# Smoke test of a built fe-admin image (run 52, A9): `bash fe-admin/scripts/docker-smoke.sh <image-tag>`.
# Used locally and by the CI job `fe-admin-image`. Creates only the containers vg-fea-smoke-ok,
# vg-fea-smoke-noenv and vg-fea-smoke-http (removed on exit), publishes 127.0.0.1:3300, never touches
# the image itself or any other container. Fake https URLs (.invalid) and a Redis URL pointing into the
# container itself: nothing outside is reached. Secrets are generated per run, passed with `-e NAME`
# (value from this shell's env, never on a command line) and never printed.
set -euo pipefail
# Git Bash on Windows: keep /app, /tmp, ... as container paths (only for docker, curl needs host paths).
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }

IMAGE="${1:?usage: docker-smoke.sh <image-tag>}"
BASE="http://127.0.0.1:3300"
NAMES=(vg-fea-smoke-ok vg-fea-smoke-noenv vg-fea-smoke-http)
TMP="$(mktemp -d)"
cleanup() {
  docker rm -f "${NAMES[@]}" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FAIL check $1: $2" >&2
  exit 1
}
pass() { echo "ok   check $1: $2"; }
secret() { node -e "process.stdout.write(require('crypto').randomBytes(${1:-32}).toString('base64url'))"; }
header() { grep -i "^$2:" "$1" | head -n1 | cut -d' ' -f2- | tr -d '\r'; }

export OIDC_ISSUER=https://idp.example.invalid
export ADMIN_API_BASE_URL=https://idp.example.invalid
export ADMIN_API_RESOURCE=https://idp.example.invalid/admin/
export APP_URL=https://admin.example.invalid
export OIDC_CLIENT_ID=fe-admin
export SESSION_REDIS_URL=redis://127.0.0.1:1/0
OIDC_CLIENT_SECRET="$(secret)"
SESSION_SECRET="$(secret)"
export OIDC_CLIENT_SECRET SESSION_SECRET
HARDEN=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges)
ENV_ARGS=(-e OIDC_ISSUER -e ADMIN_API_BASE_URL -e ADMIN_API_RESOURCE -e OIDC_CLIENT_ID -e SESSION_REDIS_URL -e OIDC_CLIENT_SECRET)

docker rm -f "${NAMES[@]}" >/dev/null 2>&1 || true
docker run -d --name vg-fea-smoke-ok "${HARDEN[@]}" -p 127.0.0.1:3300:3000 \
  "${ENV_ARGS[@]}" -e APP_URL -e SESSION_SECRET "$IMAGE" >/dev/null

# 1. non-root
user="$(docker image inspect -f '{{.Config.User}}' "$IMAGE")"
[ "$user" = "1000:1000" ] || fail 1 "image user is '$user', expected 1000:1000"
uid="$(docker exec vg-fea-smoke-ok id -u)"
[ "$uid" != "0" ] || fail 1 "container runs as root"
pass 1 "user 1000:1000, uid $uid"

# 2. healthy within 60 s
status=""
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' vg-fea-smoke-ok 2>/dev/null || echo gone)"
  [ "$status" = "healthy" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' vg-fea-smoke-ok 2>/dev/null)" = "true" ] || break
  sleep 1
done
[ "$status" = "healthy" ] || fail 2 "health status '$status' after 60 s"
pass 2 "healthy"

# 3. /healthz
code="$(curl -sS -o "$TMP/b" -D "$TMP/h" -w '%{http_code}' "$BASE/healthz")"
[ "$code" = "200" ] && [ "$(cat "$TMP/b")" = "ok" ] || fail 3 "/healthz answered $code"
[ -n "$(header "$TMP/h" content-security-policy)" ] || fail 3 "no CSP"
[ "$(header "$TMP/h" x-content-type-options)" = "nosniff" ] || fail 3 "no nosniff"
[ "$(header "$TMP/h" cache-control)" = "no-store" ] || fail 3 "not no-store"
pass 3 "/healthz 200 ok + CSP, nosniff, no-store"

# 4. root guard without a cookie => login redirect
code="$(curl -sS -o /dev/null -D "$TMP/h" -w '%{http_code}' "$BASE/")"
location="$(header "$TMP/h" location)"
[[ "$code" =~ ^3 ]] || fail 4 "/ answered $code"
[[ "$location" == /auth/login\?returnTo=* || "$location" == https://admin.example.invalid/auth/login* ]] ||
  fail 4 "unexpected Location '$location'"
pass 4 "/ => $code Location $location"

# 5. a hashed client asset: served with nosniff + immutable cache
asset="$(docker exec vg-fea-smoke-ok ls /app/dist/client/assets | grep '\.js$' | head -n1)"
[ -n "$asset" ] || fail 5 "no .js asset in the image"
code="$(curl -sS -o /dev/null -D "$TMP/h" -w '%{http_code}' "$BASE/assets/$asset")"
[ "$code" = "200" ] || fail 5 "/assets/$asset answered $code"
[[ "$(header "$TMP/h" content-type)" == text/javascript* ]] || fail 5 "content-type '$(header "$TMP/h" content-type)'"
[ "$(header "$TMP/h" x-content-type-options)" = "nosniff" ] || fail 5 "asset without nosniff"
[[ "$(header "$TMP/h" cache-control)" == *immutable* ]] || fail 5 "asset cache-control not immutable"
pass 5 "/assets/$asset 200 text/javascript, nosniff, immutable"

# 6. unknown asset => the app's 404 with the A7 headers
code="$(curl -sS -o /dev/null -D "$TMP/h" -w '%{http_code}' "$BASE/assets/khong-ton-tai.js")"
[ "$code" = "404" ] || fail 6 "missing asset answered $code"
[ -n "$(header "$TMP/h" content-security-policy)" ] || fail 6 "404 without CSP"
pass 6 "missing asset 404 + CSP"

# 7. traversal: never the server bundle or package.json
for path in '/assets/..%2f..%2fserver%2fserver.js' '/assets/%2e%2e/%2e%2e/server/server.js' \
  '/server/server.js' '/assets/../../package.json'; do
  code="$(curl -sS --path-as-is -o "$TMP/b" -w '%{http_code}' "$BASE$path")"
  if [ "$code" = "200" ] && grep -qE 'createServerEntry|serverEnv|"dependencies"' "$TMP/b"; then
    fail 7 "$path leaked a server file"
  fi
  echo "     $path => $code"
done
pass 7 "no traversal"

# 8. /auth/login with the IdP / Redis unreachable => generic 503, nothing leaked
code="$(curl -sS -o "$TMP/b" -D "$TMP/h" -w '%{http_code}' "$BASE/auth/login")"
[ "$code" = "503" ] || fail 8 "/auth/login answered $code"
[ -n "$(header "$TMP/h" content-security-policy)" ] || fail 8 "503 without CSP"
[ "$(header "$TMP/h" cache-control)" = "no-store" ] || fail 8 "503 not no-store"
for leak in example.invalid ECONN ENOTFOUND '    at ' "$OIDC_CLIENT_SECRET" "$SESSION_SECRET"; do
  if grep -qF -- "$leak" "$TMP/b"; then fail 8 "503 body leaks a detail"; fi
done
pass 8 "/auth/login 503, CSP, no-store, no detail"

# 9. oversized server-function body => 413 before the router
head -c 70000 /dev/zero | tr '\0' 'a' >"$TMP/big"
code="$(curl -sS -o /dev/null -D "$TMP/h" -w '%{http_code}' -X POST -H 'Sec-Fetch-Site: same-origin' \
  -H 'content-type: application/json' --data-binary "@$TMP/big" "$BASE/_serverFn/x")"
[ "$code" = "413" ] || fail 9 "70 000-byte POST answered $code"
[ "$(header "$TMP/h" x-content-type-options)" = "nosniff" ] || fail 9 "413 without nosniff"
pass 9 "70 000-byte POST 413 + nosniff"

# 10. graceful stop on SIGTERM (not killed)
docker stop -t 10 vg-fea-smoke-ok >/dev/null
exit_code="$(docker inspect -f '{{.State.ExitCode}}' vg-fea-smoke-ok)"
[ "$exit_code" = "0" ] || [ "$exit_code" = "143" ] || fail 10 "exit code $exit_code after docker stop"
pass 10 "docker stop => exit $exit_code"

# 11. a missing variable => exit != 0, log names it, never prints a value (canary)
CANARY="$(secret 30)"
CANARY="${CANARY:0:40}"
OIDC_CLIENT_SECRET="$CANARY" docker run -d --name vg-fea-smoke-noenv "${HARDEN[@]}" "${ENV_ARGS[@]}" -e APP_URL \
  "$IMAGE" >/dev/null
exit_code="$(timeout 20 docker wait vg-fea-smoke-noenv || echo timeout)"
[ "$exit_code" != "timeout" ] && [ "$exit_code" != "0" ] || fail 11 "missing SESSION_SECRET: exit '$exit_code'"
docker logs vg-fea-smoke-noenv >"$TMP/log" 2>&1
grep -q SESSION_SECRET "$TMP/log" || fail 11 "log does not name SESSION_SECRET"
if grep -qF -- "$CANARY" "$TMP/log"; then fail 11 "log contains the canary value"; fi
pass 11 "missing SESSION_SECRET => exit $exit_code, named, canary absent"

# 12. production refuses an http APP_URL
APP_URL=http://admin.example.invalid docker run -d --name vg-fea-smoke-http "${HARDEN[@]}" "${ENV_ARGS[@]}" \
  -e APP_URL -e SESSION_SECRET "$IMAGE" >/dev/null
exit_code="$(timeout 20 docker wait vg-fea-smoke-http || echo timeout)"
[ "$exit_code" != "timeout" ] && [ "$exit_code" != "0" ] || fail 12 "http APP_URL: exit '$exit_code'"
docker logs vg-fea-smoke-http 2>&1 | grep -q APP_URL || fail 12 "log does not name APP_URL"
pass 12 "http APP_URL => exit $exit_code"

# 13. image hygiene: no env/key files, no sources/tests/dev deps, no secret in history/env
# (as root, so no directory is skipped for lack of permission; the scan only reads)
found="$(docker run --rm --user 0:0 --entrypoint sh "$IMAGE" -c 'find / -xdev \( -name ".env*" -o -name "*.pem" \) 2>/dev/null; true')"
[ -z "$found" ] || fail 13 "env/key files in the image"
docker run --rm --entrypoint sh "$IMAGE" -c \
  'for p in /app/src /app/test /app/node_modules/vitest /app/node_modules/happy-dom /app/node_modules/typescript /app/node_modules/@testing-library; do [ ! -e "$p" ] || { echo "$p"; exit 1; }; done' ||
  fail 13 "sources/tests/dev deps in the image"
if docker history --no-trunc "$IMAGE" | grep -qE 'SECRET=|PASSWORD=|redis://'; then fail 13 "secret-like value in history"; fi
envs="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" | cut -d= -f1 | grep -v '^$' | sort | tr '\n' ' ')"
[ "$envs" = "HOST NODE_ENV NODE_VERSION PATH PORT YARN_VERSION " ] || fail 13 "unexpected image env: $envs"
pass 13 "no .env/.pem, no src/test/dev deps, clean history and env"

echo "docker-smoke: 13/13 passed for $IMAGE"
