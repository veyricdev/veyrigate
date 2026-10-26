# Test Report — 2026-10-26 (run 55, sweep debt bảo mật OAuth)

## Kết quả: PASS

- be unit 587/587 · `test:int` 50 suite **1306/1306** (dev 1285 + tester 21) · `test:vault` 5 suite **31/31** (dev 26 + tester 5) · root test 2 lần đều xanh (be 587 + fe-admin 1416 + fe-sso-test 269) · E2E **35/35** · mutation của tester **10/10 RED**, khôi phục byte-identical.
- Không có test FAIL. Không có test flaky trong 2 lượt root test (DEBT-400: không tái hiện).
- Debt mới: **DEBT-415 💭**, là ghi chú thiết kế, không chặn run.

Phạm vi: diff chưa commit so với HEAD `e94267b`. Preflight CodeGraph 1.6.2: `status` OK, `sync` OK (index build bằng v1.5.0, chưa re-index).

Tester thêm 2 file test mới, không sửa code sản phẩm hay test của dev:

- `be/test/run55-tester.int-spec.ts`: 21 test, chạy trên full app (`bootFullApp`), HTTP thật, CSRF thật, cookie phiên thật.
- `be/test/run55-tester.vault-spec.ts`: 5 test, chạy trên Vault thật và full app.

## Lệnh đã chạy + output thực tế

Tất cả chạy foreground bằng Git Bash. Log đầy đủ nằm ngoài repo, trong scratchpad của tester.

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C be test:int -- test/run55-tester.int-spec.ts` | Lượt đầu: 4 FAIL do kỳ vọng của tester sai (body `invalid_grant` có thêm `error_description` cố định). Sửa kỳ vọng ⇒ `Tests: 21 passed, 21 total`. Ca exposure lượt 1 FAIL vì `SESSION_REVOKED.targetId` = session ref; đây là thiết kế có từ trước, không thuộc run 55. Tester loại audit `SESSION_REVOKED` khỏi phần kiểm ref (vẫn kiểm JWT và session id ở mọi audit) ⇒ 21/21 |
| 2 | Mutation M1–M7 (+M4b) trên `authorize.service.ts`, `access-token-liveness.ts`, `token.controller.ts`, chạy spec của tester | Tất cả RED, xem bảng mutation. `sha256sum -c` sau mỗi lần khôi phục: 3 file OK |
| 3 | Vault tạm `vg-b73-vault` @127.0.0.1:18200, image `hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55`, token `openssl rand -hex 16` chỉ trong biến shell; `pnpm -C be test:vault -- test/run55-tester.vault-spec.ts` | `Tests: 5 passed, 5 total` |
| 4 | Mutation M8 (`listKeys` bỏ `asUnavailable`) + `test:vault` spec tester | `× V1 …` ⇒ `Tests: 1 failed, 4 passed`. Khôi phục: `vault-transit-key-provider.ts: OK` |
| 5 | `pnpm -C be test:vault` (đủ suite) | `Test Suites: 5 passed, 5 total` · `Tests: 31 passed, 31 total`. Token xuất hiện trong log: **0**. Sau đó `docker rm -f vg-b73-vault` (trap EXIT); `docker ps -a` không còn container |
| 6 | `pnpm -C be test` | `Test Suites: 37 passed` · `Tests: 587 passed, 587 total` |
| 7 | `pnpm -C be typecheck` / `lint` / `build` | typecheck OK · lint lượt 1 có 7 lỗi prettier **chỉ trong file test của tester** ⇒ `prettier --write` 2 file tester ⇒ lint OK · build OK |
| 8 | `pnpm -C be test:int` (đủ suite, lock `vg:int-lock` trống, `vg-test-*` đang chạy sẵn) | exit 0 · `Test Suites: 50 passed, 50 total` · `Tests: 1306 passed, 1306 total` |
| 9 | root `pnpm lint` | exit 0 |
| 10 | root `pnpm -r run typecheck` | exit 0 |
| 11 | root `pnpm test` lượt 1 | exit 0 · be `587 passed` · fe-admin `Test Files 64 passed` / `Tests 1416 passed` · fe-sso-test `Test Files 31 passed` / `Tests 269 passed` |
| 12 | root `pnpm test` lượt 2 | exit 0 · cùng số liệu, không có test FAIL |
| 13 | `pnpm audit --audit-level high` | exit 0 · `13 vulnerabilities found` · `Severity: 6 low \| 7 moderate` · `1 ignored: 1 high` (có sẵn) |
| 14 | `pnpm e2e` (`:4000/:5173/:3000` trống, `E2E_REUSE` unset) | exit 0 · `35 passed (4.0m)`. Các dòng warn `invalid_state` / `credentials` là của test âm sẵn có |
| 15 | Grep log của tester (`int-full`, `vault-r55`, `vault-m8`, `vault-full`, `root-*`, `audit`, `e2e`, `lint`) theo JWT `eyJ…\.…\.`, `hvs.`, `PRIVATE KEY` | 0 ở mọi log của run này. Hai file spec tester chỉ chứa các mẫu này dưới dạng regex trong assertion |

### Mutation (tester, độc lập với 12 mutation của dev)

| # | Mutation | Test RED |
|---|---|---|
| M1 | Bỏ so `sessionRef` trong `decideConsent` | T1, T2, T4, T5 |
| M2 | Dời kiểm `sessionRef` xuống sau nhánh deny | T2, T5 |
| M3 | `resume` nhánh `reauthAfter` không gọi `trustedClient` | 2 ca step-up |
| M4 | Liveness tắt check admin-capable | F2 `{public,none}` và `{confidential,none}` |
| M4b | Predicate chỉ xét `clientType` | F2 `{confidential,none}` |
| M5 | Refresh callback bỏ kiểm resource | F3 race thường + 2 biến thể admin |
| M6 | Refresh callback bỏ `adminTargetForbidden` | F3 admin `{confidential,none}` |
| M7 | `trustedClient` chỉ chạy ở nhánh approve | deny sau khi gỡ URI, deny sau khi disable client |
| M8 | `listKeys` không bọc `asUnavailable` | V1 (vault) |

## Test FAIL (nếu có)

Không có. Hai lần đỏ ở lượt đầu đều do kỳ vọng của tester sai; đã sửa test, không đụng sản phẩm:

- **Ca `invalid_grant`.** Kỳ vọng ban đầu thiếu `error_description` cố định. Nay assert đúng body opaque, giống hệt body của RT rác.
- **Ca exposure.** `SESSION_REVOKED.targetId` chứa session ref, là sha256 công khai và có từ trước run 55. Ca này nay chỉ loại audit `SESSION_REVOKED` khỏi phần kiểm ref.

## Coverage acceptance criteria

### F1: DEBT-123, consent transplant

Tất cả ca dưới đây trả 400 trang first-party: không có `Location`, body không có `victim-state`, `app.example.com` hay `code=`.

- [x] **Approve rồi deny** (T1). B dùng phiên B và CSRF hợp lệ của B, gửi `request_id` của A với approve, sau đó deny, sau đó approve lần nữa. Kết quả:
  - B nhận 400 cả 3 lần (double submit).
  - A gửi sau đó cũng 400 (context đã bị đốt).
  - 0 khoá `authz_code:*` mới, 0 `Consent` cho A và B, 0 audit consent.
- [x] **Deny trước** (T2). B deny ⇒ 400, không lộ `state`. A gửi sau ⇒ 400.
- [x] **Đồng thời** (T3, chạy 5 vòng). A approve song song với B approve:
  - B luôn 400.
  - Nếu A thắng thì A nhận 302 kèm code và `state`, đúng +1 code, consent chỉ thuộc về A.
  - Nếu A thua thì A nhận 400 và không có code.
  - B có 0 consent và 0 audit.
- [x] **Sau khi nạn nhân logout** (T4). A logout bằng `POST /logout` thật (CSRF thật, phiên bị xoá). Sau đó:
  - B gửi `request_id` của A ⇒ 400.
  - Chính A trong phiên mới (đăng nhập lại) gửi một context còn nguyên của phiên cũ ⇒ 400 và không có code. Ràng buộc là theo phiên, không theo user.
- [x] **Cùng user, 2 phiên sống** (T5). Phiên 2 deny màn hình của phiên 1 ⇒ 400, 0 audit.
- [x] **CSRF chặn trước** (T6). B gửi CSRF của A ⇒ 403 CSRF, context **không** bị đốt, A vẫn approve được (302 code). Kẻ tấn công không có CSRF hợp lệ thì không thể đốt màn của nạn nhân.
- [x] **Đối chứng.** Đúng phiên deny ⇒ 302 `access_denied` + `state` + `iss`. Đúng phiên approve ⇒ 302 code + `state` + `iss`, có 1 consent.

### F1: DEBT-130, URI bị gỡ hoặc client bị disable

- [x] **Approve/deny sau khi đổi client.** Gỡ `redirect_uri` hoặc disable client sau khi màn consent đã render:
  - deny ⇒ 400, không có `Location`, 0 audit denied;
  - approve ⇒ 400, 0 code.
- [x] **Step-up `prompt=login&max_age=0`, resume bằng phiên CŨ:**
  - URI còn ⇒ 302 `login_required` + `state` + `iss` (đối chứng);
  - URI đã gỡ ⇒ 400;
  - client bị disable ⇒ 400.
- [x] **Step-up, resume KHÔNG có phiên** (user đã đăng xuất):
  - URI còn ⇒ 302 `login_required`;
  - URI đã gỡ ⇒ 400.

### F2: DEBT-177

Chạy `describe.each` cho 2 shape `{public,none}` và `{confidential,none}`. Client ban đầu admin-capable, dùng login và `/token` thật để lấy AT `aud=admin` và AT `aud=api` của cùng client.

- [x] **Đối chứng khi client còn admin-capable:** `/userinfo` 200, `/introspect` `active:true`, `GET /admin/keys` 200.
- [x] **Sau khi hạ cấp, AT `aud=admin` bị coi là chết:**
  - `/userinfo` ⇒ 401, `WWW-Authenticate` chứa `invalid_token`, body không lộ lý do;
  - `/introspect` (RS confidential có `admin`) ⇒ đúng `{active:false}`;
  - `GET /admin/keys` ⇒ 401, không có `kid`/`kty`.
- [x] **AT `aud=api` của cùng client vẫn sống:** `/userinfo` 200, `/introspect` `active:true`. Không chặn nhầm.
- [x] **Khôi phục client về capable** ⇒ AT `aud=admin` sống lại. Không có trạng thái dính.

### F3: DEBT-216

Hook race: spy `RefreshTokenService.rotate`, chạy thay đổi ngay sau khi commit nguyên tử.

- [x] **Gỡ `api` trước khi refresh** (không race) ⇒ `invalid_grant` opaque, không có token. Replay ⇒ `invalid_grant`, 0 `TOKEN_REUSE_DETECTED`.
- [x] **Race: gỡ `api` ngay sau `rotate`:**
  - `invalid_grant`;
  - 2 doc của family đều có `revokedAt` + `familyRevokedAt`;
  - audit `resource_not_allowed`;
  - replay ⇒ `invalid_grant`. Thêm lại `api` rồi replay vẫn `invalid_grant`, 0 reuse.
- [x] **Đối chứng race:** gỡ resource **khác** ⇒ 200, RT mới refresh tiếp được 200.
- [x] **Biến thể admin, có replay** (đóng 💭 senior):
  - Race đổi client sang `{confidential,none}` hoặc gỡ `admin` ⇒ `invalid_grant`, `resource_not_allowed`.
  - Khôi phục client về capable (basic + `admin`), replay ⇒ `invalid_grant`, 0 reuse, family vẫn chết.

### F4: DEBT-410, Vault thật

- [x] **V1 — cửa sổ DEBT-410.** Spy `KeyRotationService.list` đẩy đồng hồ provider +31 s và gắn lỗi lên path metadata. Nghĩa là cache còn ấm lúc guard verify nhưng hết hạn khi tới `listKeys`.
  - network / 429 / 503 ⇒ 503 + `Retry-After: 5` + `no-store` + body outage chuẩn; không lộ `kid`, `kty`, `vault`, `transit`, addr hay tên mount.
  - 400 / 403 ⇒ 500 `server_error`, không có `Retry-After`.
  - Sau mỗi ca đều khôi phục được (200).
- [x] **V2 — Vault sập toàn bộ + cache hết hạn** ⇒ 503 từ guard (fail-closed), không bao giờ 200 hay 401.
- [x] **V3 — `POST /admin/keys/rotate`** khi lỗi network trên mọi path, network chỉ ở `rotate`, hoặc 503 chỉ ở `rotate`:
  - 500 `server_error`, không có `Retry-After`;
  - đúng 1 audit `SIGNING_KEY_ROTATED failure rotate_failed`;
  - `latest_version` của key Vault không đổi;
  - audit không chứa `eyJ` hay `hvs.`.
- [x] **Log:** mọi dòng log (Nest + pino) không chứa token Vault, root token, thư mục token hay JWT (assert ở `afterEach`).

### Run 54 không bị phá

- [x] `run54-tester.int-spec.ts`, `token-code-recheck.int-spec.ts`, `run54-tester.vault-spec.ts`, `b73*-tester.vault-spec.ts` đều xanh trong full int/vault. Tester không sửa kỳ vọng nào.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity | owner, user khác (B), cùng user ở phiên khác, anonymous (resume không phiên), super_admin | T1–T6, step-up, F2 |
| Credential | CSRF hợp lệ của B, CSRF của A trên phiên B, AT hợp lệ của client bị hạ cấp, RT bị replay | T1, T6, F2, F3 |
| Authorization | non-owner session, client mất admin-capable, client mất resource, RS introspect có quyền | T1–T5, F2, F3 |
| State | context đã bị đốt, context sống của phiên đã logout, family đã revoke rồi khôi phục cấu hình, cache key hết hạn | T1, T2, T4, F3 replay, V1 |
| Concurrency | A và B quyết cùng `request_id` song song (5 vòng); thay đổi admin xen giữa `rotate` và re-check | T3, F3 race |
| Dependency | Vault: network / 429 / 503 / 400 / 403, sập toàn phần, chỉ path `rotate` lỗi | V1–V3 |
| Request chain | render ⇒ logout (Set-Cookie clear) ⇒ request kế tiếp; `prompt=login&max_age=0` ⇒ resume bằng phiên cũ hoặc không phiên | T4, step-up |
| Exposure | body 400 (`state`/URI/code), `Location`, `WWW-Authenticate`/body 401, body 503/500, audit, log pino/Nest | mọi ca + exposure + `afterEach` vault |

Invariant ⇒ bằng chứng:

- **Chỉ phiên đã mở màn consent mới quyết được context đó**, kể cả nhánh deny, không lộ `state`: T1–T5, M1/M2 RED.
- **Không 302 tới URI không còn đăng ký hoặc client đã disable**, ở mọi nhánh consent và ở resume step-up: DEBT-130 ×4, step-up ×2, M3/M7 RED.
- **AT `aud=admin` chỉ live khi client hiện tại admin-capable**, còn aud thường không bị ảnh hưởng: F2 ×2, M4/M4b RED.
- **Refresh chỉ trả token khi resource còn được phép theo client đọc lại sau `rotate`**; retry không thành reuse: F3 ×5, M5/M6 RED.
- **Admin keys: outage ⇒ 503, lỗi cấu hình ⇒ 500, `rotate` luôn 500 + audit**: V1–V3, M8 RED.

## Ghi chú / debt

- **DEBT-415 💭** (mới, rút từ đọc code, không chặn run). Ca refresh "không race" (resource bị gỡ **trước** khi refresh) trả `invalid_grant` qua nhánh miss của `rotate`, và **không** revoke family. Hệ quả: nếu admin thêm lại resource sau đó, RT cũ dùng tiếp được. Đây là hành vi có từ trước (INV-14), khác với nhánh race (revoke family). Cần chốt chủ đích.
- 💭 senior "biến thể admin F3 thiếu replay" đã được phủ bởi test của tester (không cần debt).
- DEBT-414 (dev) giữ nguyên. Hành vi mới đã được T1–T5 khẳng định chặt: 400, không có `Location`.

## Dọn dẹp

- Container `vg-b73-vault` do tester tạo: đã `docker rm -f` (trap EXIT) cả 2 lần; `docker ps -a` không còn.
- Token Vault chỉ nằm trong biến shell, không ghi file, không in ra (0 lần xuất hiện trong log).
- Không kill, stop hay restart process/container nào khác. `vg-test-*` vẫn chạy sẵn, không đụng tới.
- File sản phẩm đã mutation được khôi phục byte-identical (sha256 OK).
- Không commit, không cài package, không sửa code sản phẩm hay config.
