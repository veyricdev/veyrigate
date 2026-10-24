# Test Report — 2026-10-24 — run 53c (B7.3 phần 3: Redis Sentinel + Redis-down 503 + DEBT-394/395/397)

## Kết quả: PASS

Tổng số test tự chạy lại, tất cả xanh: be unit 519/519 (3 lần), `test:int` 1245/1245 (47 suite, gồm 18 test mới của tester), `test:vault` 23/23 (3 suite, gồm 1 test mới), `test:sentinel` 2/2, smoke BE 11/11 (2/3 lần, lần còn lại FAIL do flake của script, xem case 6), root `pnpm test` 519 + 1416 + 269, E2E 35/35. Mutation: 6 mutant, 5 bị test tester bắt (RED). Mutant còn lại (DEBT-397) bị smoke check 8 bắt trên image cũ. Không có lỗi sản phẩm. Mở 1 debt về script: DEBT-408.

Đối chiếu HEAD `7229b1b` + diff chưa commit. Tester không sửa code sản phẩm, config hay runbook. Tester chỉ thêm 2 file test:
- `be/test/b73c-tester.int-spec.ts`
- `be/test/b73c-tester.vault-spec.ts`

## Lệnh đã chạy + output thực tế

Log đầy đủ nằm ở scratchpad của phiên tester. Mọi lệnh chạy foreground, trừ `test:int` (chạy nền, có chờ kết quả).

1. **Kiểm tĩnh be**
   - `pnpm -C be typecheck` ⇒ exit 0.
   - `pnpm -C be lint` ⇒ exit 0.
   - Sau khi thêm file test mới, đã chạy lại `tsc --noEmit` và `eslint` ⇒ 0.
2. **Unit be (DEBT-400)**
   - `pnpm -C be test` lần 1 ⇒ `Test Suites: 36 passed`, `Tests: 519 passed, 519 total`.
   - Lần 2 ⇒ 519/519.
   - Lần 3 (trong root `pnpm test`) ⇒ 519/519.
   - Không tái hiện lỗi tải suite `ops-rules.spec`: 3/3 lần xanh.
3. **`pnpm -C be test:int`** (lock `vg:int-lock`; `vg-test-mongo`/`vg-test-redis` đang Up, không cần `docker start`)
   - ⇒ `Test Suites: 47 passed, 47 total`, `Tests: 1245 passed, 1245 total`, exit 0.
   - 1245 = 1227 của dev + 18 test mới của tester.
4. **`test:sentinel`**
   - Chưa dựng hạ tầng ⇒ exit 1, globalSetup báo "test:sentinel needs the throwaway Sentinel on 127.0.0.1:26390 … Start it:" kèm lệnh. Không skip.
   - `bash be/scripts/sentinel-test-env.sh up` ⇒ "sentinel test env up (master vg-b73c-redis-a, replica vg-b73c-redis-b)".
   - `pnpm -C be test:sentinel` ⇒ 2/2:
     - `√ stop the master ⇒ fast rejections during the switch, a write lands on the new master ≤ 15 s (3898 ms)`. Lần chạy ghi "failover: 2 attempts, write after 3202 ms; errors: Error | Command timed out".
     - `√ no Sentinel reachable ⇒ commands reject fast with a recognised outage error (no hang) (1007 ms)`.
   - `… down` ⇒ "sentinel test env removed". Sau đó không còn container hay network `vg-b73c-*`.
5. **`test:vault`**
   - Dựng Vault tạm `vg-b73-vault` (`hashicorp/vault:2.1.2@sha256:c2f6…bb55`, 127.0.0.1:18200). Root token sinh ngẫu nhiên, chỉ truyền qua env, không in ra.
   - ⇒ `Test Suites: 3 passed`, `Tests: 23 passed, 23 total`, exit 0. Gồm 22 test của run 53/53c và 1 test mới V-real.
   - Đã `docker rm -f vg-b73-vault`.
   - Log không chứa root token (grep đếm 0) và không chứa `hvs.` (0).
6. **Smoke BE**
   - Rebuild từ working tree: `docker build -f be/Dockerfile --target build -t veyrigate-be:smoke-run53b-53c-build .` rồi `docker build -f be/Dockerfile -t veyrigate-be:smoke-run53b-53c .` ⇒ 0.
   - `bash be/scripts/docker-smoke.sh veyrigate-be:smoke-run53b-53c veyrigate-be:smoke-run53b-53c-build`:
     - Lần 1: check 1–9 ok, `check 8: docker stop with Redis down => exit 0 in 2 s`, nhưng **`FAIL check 10: log does not name KEY_PROVIDER`**.
     - Lần 2 và lần 3: `docker-smoke: 11/11 passed`.
   - **Chẩn đoán lần 1**: chạy tay cùng env 2 lần (`--network none`). Cả 2 lần exit 1 và log có đúng dòng `KEY_PROVIDER: KEY_PROVIDER must be vault when NODE_ENV=production (local is dev-only)`. Sản phẩm đúng. Lỗi nằm ở script: `docker logs … | grep -q` chạy dưới `set -o pipefail`. `grep -q` thoát ngay khi khớp, `docker logs` (còn stack trace phía sau) nhận SIGPIPE, pipeline trả khác 0 và nhánh `|| fail 10` chạy. Dòng này không đổi ở 53c (có từ 53b). Ghi DEBT-408.
   - **Đối chứng DEBT-397**: chạy cùng script trên image trước sửa `veyrigate-be:smoke-run53b` ⇒ `FAIL check 8: exit code 137 after docker stop with Redis down (18 s)`. Như vậy check 8 phân biệt được bản sửa.
   - Mọi lần chạy đều tự dọn: không còn `vg-b73b-*`, `vg-be-smoke-*`, `vg-b73b-net`.
7. **Root**
   - `pnpm lint` ⇒ 0.
   - `pnpm -r run typecheck` ⇒ 0.
   - `pnpm test` ⇒ 0. be 519/519, fe-admin `Test Files 64 passed`, `Tests 1416 passed`, fe-sso-test `31 files`, `269 passed`.
8. **`pnpm audit --audit-level high`** ⇒ exit 0. "13 vulnerabilities found, Severity: 6 low | 7 moderate, 1 ignored: 1 high". Mục high bị ignore là ignore có sẵn từ trước.
9. **E2E**
   - Trước khi chạy: không có tiến trình LISTENING trên :4000/:5173/:3000, `E2E_REUSE` chưa đặt.
   - `pnpm -C e2e e2e` ⇒ `35 passed (3.9m)`, exit 0.
   - Sau khi chạy, các cổng trên lại trống.
10. **Grep secret** trên toàn bộ log của tester: `hvs.` 0 file; `BEGIN … PRIVATE KEY` 0; giá trị `DEV_SEED_PASSWORD` của `e2e/.env` 0; mật khẩu test và canary 0.
11. **`be/keys`**: sha256 trước và sau trùng khớp. `git status be/keys be/.env` sạch.

## Mutation (backup sha256, khôi phục byte-identical)

Mỗi mutant chỉ chạy các test tester liên quan (`jest -t`). Sau mỗi mutant đều khôi phục file và so sha256: cả 6 lần `identical`. `git diff` của `be/src` sau cùng giống như trước khi mutation.

| # | Mutant | Kết quả |
|---|---|---|
| M1 | `html-exception.filter.ts`: `Retry-After` = 6 | R1 refuse **RED** |
| M2 | `AdminTokenGuard` nuốt `KeyProviderUnavailableError` (⇒ 401) | V1 **RED** |
| M3 | `LogoutService`: hint không verify được ⇒ redirect tới `post_logout_redirect_uri` (open redirect) | V3 **RED** (2/2: registered + hostile) |
| M4 | `redis.service.ts` về bản HEAD (`quit()` thuần) | S1 **xanh**, không phân biệt được (xem ghi chú) |
| M5 | `token.controller` `unavailable = false` | R2 refuse **RED** |
| M6 | `/introspect` nuốt `KeyProviderUnavailableError` | V2 **RED** |

Ghi chú M4: khi chạy in-process, Redis bị refuse rất nhanh nên `quit()` reject ngay, rồi ioredis tự dừng reconnect. Lỗi DEBT-397 chỉ tái hiện được khi có chu kỳ reconnect chậm (DNS của container đã dừng). Chu kỳ này có trong `redis-fail-fast.int-spec.ts` của dev (`retryStrategy: () => 3000`) và trong smoke check 8. Smoke check 8 đã RED trên image cũ (case 6). S1 vì thế chỉ là regression guard, không phải bằng chứng phân biệt bản sửa.

## Test FAIL (nếu có)

Không có test sản phẩm FAIL.

- Smoke lần 1, check 10: kỳ vọng log nêu `KEY_PROVIDER`; thực tế script báo không nêu. Nguyên nhân là flake của script (pipefail + `grep -q` ⇒ SIGPIPE), không phải lỗi app (xem case 6). Ghi DEBT-408 🟢. Không chặn.

## Coverage acceptance criteria

- [x] **Plan B7.3**: "kill Redis ⇒ endpoint cần state trả lỗi rõ, không im lặng sai".
  - Dev: `redis-down.int-spec.ts`, 9 endpoint × refuse/blackhole, chạy lại trong case 3.
  - Tester R1 mở rộng thêm, ở cả 2 chế độ:
    - `GET /` có phiên;
    - **step-up** `GET /authorize?prompt=login&max_age=0`;
    - `POST /register`, `/forgot`, `/reset`, `/revoke`;
    - **admin API với admin token thật**: `GET /admin/tenants` và `POST /admin/clients` (`@RequireRecentAuth`).
  - Tất cả ⇒ 503, `Retry-After: 5`, `no-store`, **không có `Set-Cookie` nào** (chặt hơn dev, vốn chỉ kiểm cookie phiên), không `Location`, không token.
  - Các endpoint không cần Redis vẫn chạy: `/jwks.json`, discovery, `/health` 200; `POST /verify-email` (chỉ dùng Mongo, không rate-limit) vẫn 400.
- [x] **Task 1** (Sentinel env/client): `test:sentinel` 2/2 (failover thật, không có sentinel nào ⇒ lỗi nhanh). Fail-closed khi thiếu hạ tầng. C1 (tester): cả hai / không cái nào / sentinel sai định dạng / master sai / db sai ⇒ đều bị từ chối, nêu tên `REDIS_*`, không echo canary; env Sentinel hợp lệ thì qua. Unit `validation.schema.spec.ts` (dev) xanh.
- [x] **Task 2**: 503 `temporarily_unavailable` ở OAuth/HTML filter và `/token`/`/introspect`. Predicate được mutation dev 5/5 kiểm; tester M1/M5 RED. DEBT-394: V1/V2/V3 (mock provider) và V-real (Vault thật bị cắt).
- [x] **Task 3**:
  - DEBT-395: `b73-tester.vault-spec.ts › T8` ≤ 2 lần đọc (case 5).
  - DEBT-397:
    - smoke check 8 exit 0 trong 2 s, Redis vẫn chết (case 6). Đối chứng trên image cũ ra 137 sau 18 s.
    - S1 (tester): `app.close()` < 10 s ở cả refuse lẫn blackhole, sau đó 4 s không có kết nối lại.
    - `redis-fail-fast.int-spec.ts` (dev) xanh.
- [x] **Task 4**: `test:sentinel` opt-in, fail khi thiếu hạ tầng (case 4). Compose mẫu và runbook nằm ngoài phạm vi kiểm của tester (theo chỉ đạo).

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | anonymous (register/forgot/reset, authorize ẩn danh của dev), user có phiên, **admin** (tenant_admin, aud=admin) | R1, V1, V-real |
| Credential | hợp lệ, **sai định dạng** (`not-a-jwt`, `a.b.c`, rỗng) khi key down ⇒ 401 / `active:false` / admin 401; **giả mạo kid lạ** khi key down ⇒ 503, không bao giờ 200/`active` (khi key trở lại ⇒ 401) | V1, V2, V-real |
| Authorization | step-up `@RequireRecentAuth` và step-up IdP `prompt=login&max_age=0` khi Redis down ⇒ 503, không 403/302 | R1 |
| Input | `post_logout_redirect_uri` registered và hostile khi key down ⇒ chỉ `/login?loggedOut=1`. Control khi key up: URI registered được phản chiếu, hostile thì không | V3, V-real |
| State | **refresh khi Redis down**: 5 request đồng thời ⇒ đều 503. Sau khi phục hồi: rt ⇒ rt2 ⇒ rt3 200, family đúng 3 doc / 1 active, **0 `TOKEN_REUSE_DETECTED`**, AT mới qua `/userinfo` 200 (refuse + blackhole). **Partial failure**: Redis lỗi sau khi code đã bị tiêu ⇒ 503, không có family mới; thử lại ⇒ `invalid_grant` (đúng hành vi DEBT-404 mô tả, đã sửa ở tài liệu). Refund lỗi sau reserve ⇒ refresh 200, xoay 1 lần | R2, R3, R4 |
| Dependency | Redis refuse/blackhole; Sentinel failover và không có sentinel; Vault bị cắt thật + cache hết hạn (admin read + write, `/userinfo`, `/introspect` ⇒ 503; JWKS 5xx ở T5) | R1–R4, sentinel, V-real, T5 |
| Request chain | logout khi key down: cookie phiên bị xoá, `SessionService.get` ⇒ null, AT cũ ⇒ 401 (tombstone) sau khi key trở lại. Sau mọi outage: phiên, code, RT và admin token dùng lại được | V3, V-real, R1, R2 |
| Exposure | body 503 không chứa token; không `Set-Cookie`/`Location`; lỗi config không echo giá trị; log tester không có secret (case 10) | R1–R3, C1, grep |
| Shutdown | `app.close()` < 10 s, không reconnect; container exit 0 trong 2 s | S1, smoke 8 |

- Ma trận #28 ("infra ⇒ 5xx, never active") giữ đúng: R1/V1/V2/V-real đều kiểm `'active' in body === false` khi outage, và kiểm `active:false` chỉ xuất hiện với token thật sự sai.
- Fail-closed: không thấy endpoint nào trả 2xx, cookie hay token khi Redis/Vault down. Lỗi lạ vẫn 500 (unit của dev).

## Rủi ro còn lại (không chặn, đã có debt)

- DEBT-388/401: Vault chết khi ký ⇒ `/token` 500 sau khi đã tiêu code / xoay RT. T5 vẫn xanh, fail-closed.
- DEBT-402: `Connection is closed.` / `EXECABORT` vẫn ra 500.
- DEBT-405: compose mẫu chưa chạy thử.
- DEBT-408 (mới): flake check 10 của smoke script.
