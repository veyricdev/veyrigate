#!/usr/bin/env bash
# Throwaway Redis Sentinel for `pnpm -C be test:sentinel` (run 53c, B7.3):
#   bash be/scripts/sentinel-test-env.sh up     # start (idempotent: recreates the same names)
#   bash be/scripts/sentinel-test-env.sh down   # remove
# Creates ONLY the network vg-b73c-net and the containers vg-b73c-redis-a (master, 127.0.0.1:16390),
# vg-b73c-redis-b (replica, 127.0.0.1:16391), vg-b73c-sentinel (127.0.0.1:26390), master group `idp`,
# quorum 1, down-after 1 s. Hostnames are announced (the test maps them to 127.0.0.1 with `natMap`).
# No password (local test only); never touches any other container, network or volume.
set -euo pipefail
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }
# >= 14 days old, pinned by index digest (Docker Hub tag_last_pushed 2026-08-05; 7.4.11 re-pushed 2026-10-21).
IMAGE=redis:7.4.10-bookworm@sha256:e9b2e45ecd47fbb69b877cf8d045d5cccaaaed52524b6e098b4abe8212994f73
NET=vg-b73c-net
NAMES=(vg-b73c-sentinel vg-b73c-redis-b vg-b73c-redis-a)

down() {
  docker rm -f "${NAMES[@]}" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

case "${1:-}" in
  up)
    down
    docker network create "$NET" >/dev/null
    docker run -d --name vg-b73c-redis-a --hostname vg-b73c-redis-a --network "$NET" \
      -p 127.0.0.1:16390:6379 "$IMAGE" redis-server --save '' --appendonly no \
      --replica-announce-ip vg-b73c-redis-a >/dev/null
    docker run -d --name vg-b73c-redis-b --hostname vg-b73c-redis-b --network "$NET" \
      -p 127.0.0.1:16391:6379 "$IMAGE" redis-server --save '' --appendonly no \
      --replica-announce-ip vg-b73c-redis-b --replicaof vg-b73c-redis-a 6379 >/dev/null
    # Fixed /etc/hosts entries: a STOPPED container drops out of Docker DNS and the lookup can stall
    # long enough to put Sentinel into TILT mode (observed run 53c), which freezes the failover.
    ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$1"; }
    HOSTS=(--add-host "vg-b73c-redis-a:$(ip vg-b73c-redis-a)" --add-host "vg-b73c-redis-b:$(ip vg-b73c-redis-b)")
    # Sentinel rewrites its config file: generate it inside the container (no host file).
    docker run -d --name vg-b73c-sentinel --hostname vg-b73c-sentinel --network "$NET" "${HOSTS[@]}" \
      -p 127.0.0.1:26390:26379 --entrypoint sh "$IMAGE" -c '
        printf "%s\n" "port 26379" "sentinel resolve-hostnames yes" "sentinel announce-hostnames yes" \
          "sentinel monitor idp vg-b73c-redis-a 6379 1" "sentinel down-after-milliseconds idp 1000" \
          "sentinel failover-timeout idp 5000" > /tmp/sentinel.conf
        exec redis-sentinel /tmp/sentinel.conf' >/dev/null
    for _ in $(seq 1 30); do
      if docker exec vg-b73c-sentinel redis-cli -p 26379 sentinel replicas idp 2>/dev/null | grep -q vg-b73c-redis-b; then
        echo "sentinel test env up (master vg-b73c-redis-a, replica vg-b73c-redis-b)"
        exit 0
      fi
      sleep 1
    done
    echo "sentinel did not see the replica within 30 s" >&2
    exit 1
    ;;
  down)
    down
    echo "sentinel test env removed"
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
