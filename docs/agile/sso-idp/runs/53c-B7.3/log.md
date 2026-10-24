# Log — run 53c

- orchestrator: mở run từ "Kế hoạch 53c" (tech-lead fold run 53), gộp DEBT-394/395/397; không gọi lại tech-lead.

## backend-dev — 2026-10-24 — bảng lỗi Redis quan sát thật (trước khi viết `isRedisUnavailable`)

- Nguồn: `be/test/redis-down.int-spec.ts` (app thật, proxy TCP in-process → `vg-test-redis`; spy ghi lỗi tới `OAuthExceptionFilter`/`HtmlExceptionFilter`/`renderError` token+introspect). Trước sửa: cả 9 endpoint × 2 chế độ ⇒ **500** (fail-closed, không cookie phiên, không token, introspect không `active`), thiếu `Retry-After`.

| Chế độ proxy | Lỗi (class \| name \| message) | Endpoint gặp |
|---|---|---|
| refuse (ECONNREFUSED) | `MaxRetriesPerRequestError` (ioredis, name getter = tên class) | `GET /authorize` (có/không phiên), `POST /authorize/consent`, `GET /userinfo` |
| refuse | `Error` \| `Command timed out` (ioredis `Command.setTimeout`, `new Error`) | `POST /login`, `/token` code + refresh, `/introspect`, `POST /logout` |
| blackhole (nhận TCP, không trả lời) | `Error` \| `Command timed out` | mọi endpoint trừ consent |
| blackhole | `MaxRetriesPerRequestError` | `POST /authorize/consent` (socket cũ bị đóng ⇒ đếm retry) |
| — | Không quan sát: `Connection is closed.` (chỉ khi client `end`), `EXECABORT`, `All sentinels are unreachable…` (sự kiện `error`, không phải lỗi lệnh) | ⇒ KHÔNG đưa vào predicate (vẫn 500 fail-closed); kiểm lại ở `test:sentinel` |

- Predicate dự kiến: `err.name === 'MaxRetriesPerRequestError'` HOẶC (`err.constructor === Error` và `message === 'Command timed out'`) — khớp chính xác, không regex rộng.
- **Bổ sung từ `test:sentinel`** (failover thật + không sentinel nào tới được): chỉ thấy đúng 2 dạng trên (`MaxRetriesPerRequestError`, `Command timed out`) ⇒ bảng không đổi.

## backend-dev — 2026-10-24 — Task 1–4 xong (đề nghị → senior-reviewer)

- **Trust boundary**: tài sản = phiên/code/RT/tombstone (Redis), key ký (Vault). Không fail-open: lỗi chỉ đổi 500 ⇒ 503 (`temporarily_unavailable`, `Retry-After: 5`, `no-store`), không cookie phiên, không token, `/introspect` không `active` (ma trận #28 "infra ⇒ 5xx, never active" — 503 vẫn là 5xx; `active:false` chỉ cho token thật sự inactive; lỗi lạ vẫn 500). Request lỗi không tiêu code/RT/phiên (test bật lại proxy ⇒ cùng code/RT/phiên dùng được, không reuse). Logout vẫn bỏ qua `id_token_hint` khi Vault chết (chỉ chọn redirect mặc định, không cấp quyền).
- **T1**: `REDIS_SENTINELS`/`_MASTER`/`_SENTINEL_PASSWORD`/`REDIS_USERNAME|PASSWORD|DB` (zod: đúng 1 chế độ, credential chỉ ở Sentinel, lỗi chỉ nêu tên biến); `buildRedisOptions` cùng bound fail-fast 2 chế độ; WARN production+standalone. Cluster N/A (DEBT-013/073).
- **T2**: `common/errors/dependency-unavailable.ts` (`isRedisUnavailable` khớp chính xác bảng trên, `KeyProviderUnavailableError`); OAuth/Html filter, `/token` + `/introspect` renderError ⇒ 503. DEBT-394: `TokenVerifier` bọc lỗi lấy key; userinfo/introspect/admin guard/demo rethrow. Kill test `be/test/redis-down.int-spec.ts` (proxy `be/test/redis-proxy.ts`, refuse + blackhole, 9 endpoint) + case DEBT-394.
- **T3**: DEBT-395 `refresh(false)` (unit: 10 sign 500 ⇒ 1 read, RED trước = 10; T8 ⇒ ≤ 2). DEBT-397: quit chỉ khi `ready`, cap 1 s, luôn `disconnect()`; repro Docker trước sửa: stop 18 s ⇒ 137 (quit "Command timed out" rồi client reconnect mãi). Smoke check 8 = stop khi Redis vẫn chết ⇒ 0 (<10 s), bỏ bước bật lại Redis.
- **T4**: `test:sentinel` + `be/test/sentinel-preflight.mjs` (fail kèm lệnh) + `be/scripts/sentinel-test-env.sh` (`redis:7.4.10-bookworm@sha256:e9b2e45e…4f73`, Hub push 2026-08-05; 7.4.11 push 2026-10-21 < 14 ngày). Docker DNS chậm với container đã stop đẩy Sentinel vào TILT ⇒ `--add-host` cố định. CI step. `ops/compose/prod.example.yml` + `vault-agent.hcl` (chỉ viết, parse YAML OK, không chạy), runbook-deploy §8/§9/§10, runbook-ops §5, ma trận #28.
- **Verify**: be typecheck/lint/build 0; unit 519/519 (1/4 lần: suite `ops-rules.spec` lỗi tải, chạy lại 3× xanh ⇒ DEBT-400); `test:int` 1227/1227 (46 suite); `test:vault` 22/22 (Vault tạm `vg-b73-vault`, đã xoá); `test:sentinel` 2/2 (failover: write sau 5,3 s); smoke BE ảnh mới 11/11 (ảnh cũ `smoke-run53b`: check 8 FAIL 137/17 s); root lint 0, `-r typecheck` 0, `pnpm test` 0 (519/1416/269); audit high 0 (1 ignore sẵn); E2E 35/35. Grep `hvs.`/PEM/mật khẩu test trên log: 0. `be/keys` không đổi.
- **Mutation (khôi phục sha256 khớp)**: predicate luôn false ⇒ kill test 2 RED; `isEnded` nuốt lỗi (fail-open) ⇒ `/userinfo` 200 ⇒ RED; userinfo bỏ rethrow ⇒ DEBT-394 RED; shutdown về `quit()` thuần ⇒ int RED ("Command timed out") + smoke ảnh cũ RED; bỏ cap 1 s ⇒ int "stalled" RED (8011 ms).
- **Docker**: dọn `vg-b73c-*`, `vg-b73c-net`, `vg-b73b-*`, `vg-be-smoke-*`, `vg-b73-vault`; giữ image `veyrigate-be:smoke-run53b-53c[-build]`. Không prune/compose/push. Mở DEBT-400…402.

## senior-reviewer — 2026-10-24 — PASS (0 🔴, 5 🟡 ⇒ DEBT-403…407)

- Tự chạy: be typecheck 0, lint 0, unit 519/519. Không chạy int/sentinel/vault/E2E, không dựng container.
- Invariant: 503 chỉ thay 500 (không 2xx/cookie/token, `no-store`, `Retry-After`); predicate khớp chính xác, bắt nhầm vẫn fail-closed; introspect không `active` (#28 giữ); DEBT-394 token hỏng vẫn 401, không đường chấp nhận token khi Vault down; logout bỏ hint ⇒ `DEFAULT_REDIRECT` trước khi xét `post_logout_redirect_uri` (không open redirect); DEBT-395/397 đúng, shutdown sau `dispose()` ⇒ không mất ghi dở; config Sentinel cấm cả hai/không cái nào, lỗi chỉ tên biến, `natMap` chỉ test.
- 🟡: tài liệu hứa `NOREPLICAS` ⇒ 503 (thực tế 500) (403); "không tiêu code/RT ⇒ chỉ cần thử lại" nói quá (timeout ≠ chưa chạy) (404); compose mẫu `cap_drop ALL`/`read_only` không `user:` ⇒ redis/vault-agent khả năng không khởi động (405); comment `env_file` tránh `docker inspect` sai (406); DEBT-392 chưa cập nhật đích/trùng DEBT-402 (407). Ponytail -8 dòng.
- → tester.

## backend-dev docs fix — 2026-10-24 — DEBT-403…407 + nit REDISCLI_AUTH (không chạm `be/src`/`be/test`/script)

- DEBT-403: runbook-ops §5.3, runbook-deploy §10, comment compose: `NOREPLICAS` ⇒ **500** không `Retry-After` (không 503). Chọn **2 replica** + `min-replicas-to-write 1` (thêm `redis-replica-1/2`); đánh đổi `0` ghi rõ, không chọn.
- DEBT-404: "thường không tiêu; `Command timed out` có thể đã chạy ⇒ `/token` thử lại nhận `invalid_grant` ⇒ bắt đầu lại luồng" (ops §5.5, deploy §10).
- DEBT-405: `user: '999:999'` redis/sentinel (tmpfs `uid=999`), vault-agent `user: '100:1000'` + `SKIP_SETCAP`/`SKIP_CHOWN`, bỏ `IPC_LOCK` (theo entrypoint chính thức docker-library/redis 7.4 + hashicorp/vault). `docker compose config --quiet` trên bản sao ở scratchpad (`secrets/be.env` rỗng) ⇒ exit 0; trong repo exit 1 chỉ vì thiếu `secrets/be.env` (cố ý). Không up/pull/run ⇒ giữ mở.
- DEBT-406: comment compose + runbook-deploy §10 "Secret": `env_file` vẫn lộ qua `docker inspect`; dùng secret file/Vault Agent.
- DEBT-407: DEBT-392 đích X6 + trạng thái 53c; TLS bỏ khỏi DEBT-402. Nit: runbook-ops §5.1 dùng `REDISCLI_AUTH` thay `-a`.

## tester — 2026-10-24 — PASS (xem `test-report.md`)

- Chạy lại độc lập: be typecheck/lint 0; unit 519/519 ×3 (DEBT-400 không tái hiện); `test:int` 1245/1245 (47 suite; +18 tester); `test:vault` 23/23 (Vault tạm `vg-b73-vault`, đã xoá; +1 tester); `test:sentinel` 2/2 (thiếu hạ tầng ⇒ fail kèm lệnh); smoke BE ảnh rebuild từ working tree 11/11 ×2 (1 lần FAIL check 10 do flake script pipefail+`grep -q` ⇒ DEBT-408 🟢; app đúng, chạy tay 2/2); ảnh cũ `smoke-run53b` ⇒ check 8 FAIL 137/18 s (đối chứng DEBT-397); root lint/typecheck 0, `pnpm test` 519/1416/269; audit high 0 (1 ignore sẵn); E2E 35/35 (cổng trống, không `E2E_REUSE`).
- Test rủi ro mới `be/test/b73c-tester.int-spec.ts` (R1 step-up + admin token + register/forgot/reset/revoke 503 strict: không `Set-Cookie` nào, không `Location`; R2 refresh đồng thời khi Redis down ⇒ family nguyên, 0 reuse alarm; R3 partial failure sau consume ⇒ 503 + không family, retry `invalid_grant`; R4 refund lỗi ⇒ 200; V1–V3 key down: admin 503, token hỏng 401/`active:false`, kid lạ ⇒ 503, logout registered/hostile ⇒ chỉ `/login?loggedOut=1`; S1 `app.close()` <10 s không reconnect; C1 config Sentinel không echo canary) + `be/test/b73c-tester.vault-spec.ts` (V-real: Vault thật bị cắt + cache hết ⇒ admin read/write, userinfo, introspect 503; malformed 401; logout không open redirect; phục hồi).
- Mutation 6 (sha256 khôi phục identical): M1 Retry-After, M2 admin guard nuốt lỗi key, M3 logout open redirect, M5 `/token` unavailable=false, M6 introspect nuốt lỗi key ⇒ RED; M4 (`quit()` thuần) S1 không phân biệt (in-process không tái hiện) — smoke check 8 trên ảnh cũ bắt được.
- Grep secret log: `hvs.`/PEM/`DEV_SEED_PASSWORD`/mật khẩu test/canary 0. `be/keys` sha256 không đổi. Docker: dọn `vg-b73c-*`/`vg-b73c-net`, `vg-b73b-*`/`vg-b73b-net`, `vg-be-smoke-*`, `vg-b73-vault`; giữ image `veyrigate-be:smoke-run53b-53c[-build]` (rebuild). Không prune/compose/push; không đụng `aegate-*`/`vg-test-*`/`funny_pascal`. Mở DEBT-408.
