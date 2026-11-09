# Test Report — 2026-11-09 (run 80, sweep 🟡 BE đợt 4)

## Kết quả: PASS (gate đủ, 0 test đỏ; +40 int tester, mutation 10/11 bắt được, 1 không áp dụng)

| Gate (tuần tự) | Kết quả |
|---|---|
| `pnpm -C be typecheck` + `lint` | exit 0 / exit 0 (sau khi thêm test) |
| `pnpm -C be test` | 43 suites, **794/794** |
| `pnpm -C be build` | exit 0 |
| `pnpm -C be test:int` FULL | **61 suites, 1611/1611** (617 s), exit 0 — 1571 của dev (1569 + 2 ca seed retry 1) + 40 ca tester (+1 suite `run80-tester`) |
| `vg-int-*` trên vg-test-mongo | **4 trước → 4 sau** (4 DB `vg-int-vault-v7-*` cũ, đã biết) |
| `pnpm -C fe-admin typecheck` / `lint` / `test` | exit 0 / exit 0 / 67 files **1578/1578** |
| Cổng 4000/5173/3000 trống ⇒ `pnpm -C e2e e2e` | **38 passed** (4.7 m), exit 0 — DEBT-527 không tái hiện |
| `pnpm -C e2e e2e:x3` | **42 passed** (9.4 m), exit 0 ⇒ cổng trống sau |

## Test thêm

### 1. `be/test/run80-tester.int-spec.ts` (mới, 37 ca, app thật `bootFullApp` qua HTTP)
- **T4 DEBT-325, ma trận** (`it.each` 4 route `@SuperAdminOnly()`: `GET /admin/keys`, `POST /admin/keys/rotate`, `POST /admin/resources`, `PATCH /admin/resources/api`):
  - tenant_admin `auth_time` cũ 6 phút và mới ⇒ cả hai 403 `{error:'forbidden'}`, body + `WWW-Authenticate` **giống từng byte** (không lộ step-up), không có `step_up`/`max_age`/`super_admin`, `Cache-Control: no-store`;
  - tenant_admin chỉ có `admin.read` trên route ghi ⇒ vẫn `insufficient_scope` (bước 6 vẫn chạy trước bước 8);
  - sau các lần bị từ chối: resources, kid JWKS và số audit giữ nguyên;
  - super_admin cũ ⇒ `step_up_required` (route ghi), 200 ở `GET /admin/keys` (không có `RequireRecentAuth`, như thiết kế); super_admin mới ⇒ 200/200/201/200.
  - tenant_admin vẫn đọc được `/admin/resources`, `/admin/resources/api`, `/admin/tenants`, `/admin/audit`, `/admin/me` (200).
  - Rà các route admin khác: `tenants`, `audit`, `users`, `clients` phân nhánh theo vai trò/dữ liệu ngay trong handler (tenant_admin thấy view thu hẹp), không route nào chỉ dành cho super_admin mà thiếu `@SuperAdminOnly()`. 4 route gọi `assertSuperAdmin` thì cả 4 đều đã gắn.
- **T3 DEBT-324/329/531**, qua `POST /admin/resources` với token super_admin:
  - 22 identifier bị từ chối: U+0000 (đầu/giữa), U+200B, U+FEFF, U+202E, U+00A0, U+2028, U+3000, tab/LF/CR giữa chuỗi, DEL, C1 U+0085, tab trong host, `javascript:`, `JAVASCRIPT:`, `mailto:`, `data:`, `file:`, `ftp:`, `ws:`, `blob:`. Mỗi ca ⇒ 400 `{error:'invalid_request', error_description: <câu cố định>}`, không echo giá trị, 0 document, 0 audit `ADMIN_RESOURCE_CREATED`.
  - 6 identifier được nhận: `HTTPS://R80T-UP.EXAMPLE.COM/`, `Https://…`, `http://localhost:3000/…`, `urn:`, `URN:`, `%20`/`%00` đã mã hoá. Mỗi ca ⇒ 201 và DB lưu đúng từng byte (không chuẩn hoá).
  - **Resource cũ** (chèn thẳng DB): `https://…/a b`, `ftp://…`, `https://…/z​`. `PATCH` scopes ⇒ 200 (3 audit). `/authorize` + `/token` với client được phép ⇒ 302 code, 200 AT, `aud` = đúng chuỗi lưu (runtime không đổi).
- **T2 DEBT-237**:
  - `GET /` với cookie phiên, `SessionService.get` ném `Error` chứa secret + email ⇒ 500 HTML. Body không có secret. Đúng 1 dòng pino có `HtmlExceptionFilter`, level ≥ 50, chứa `Error`. Không dòng log nào chứa secret, email hay session id.
  - `POST /login` lỗi 4xx (CSRF sai, 415) ⇒ 0 dòng `HtmlExceptionFilter`.
- **OpenAPI**: `GET /openapi/admin.json` từ app thật (vg-test-mongo, không cần DB dev) **deep-equal** snapshot sửa tay `fe-admin/openapi/admin.json`. Mô tả `CreateResourceDto.identifier` khớp chuỗi mới ⇒ snapshot đúng.

### 2. `be/test/session-reflection.int-spec.ts` (+3 ca, Redis + Mongo thật) — T1 DEBT-526
`it.each(['pre_revoke','sessions','sweep'])` cho `POST /logout` (scope=session), 2 trình duyệt/user. Lỗi mang `mongodb://u:r80-S3CRET@h boom`. Bước `sweep` dùng lời gọi `revokeForSession` thật lần 1, reject lần 2.

Kiểm cho cả 3 bước:
- 5xx, không `Location`, không clear cookie, body không có secret.
- Đúng 1 doc `SESSION_REVOKED` failure lưu trong Mongo: `revoke_failed`, `targetId = session.ref`, metadata đúng 2 khoá `{scope:'session', failedStep}`. JSON của doc không chứa session id A/B, csrf, AT/RT, secret, `boom`.
- 0 audit success.
- Phiên A còn sống khi lỗi ở `pre_revoke`/`sessions`, đã chết khi lỗi ở `sweep`. Phiên B không bị đụng.
- Retry ⇒ 302, phiên A chết, refresh của A ⇒ `invalid_grant`, còn đúng 1 family (của B) và refresh B vẫn 200.
- Sau retry vẫn đúng 1 failure audit; success audit = 1 (0 với `sweep`: retry rơi vào nhánh "không phiên").

## Mutation (backup → mutate → chạy → restore; sha256 khớp mọi lần)
| # | File / mutation | Kết quả |
|---|---|---|
| M1 | `tenant-context.ts` tắt kiểm super_admin (`&& false`) | 3 đỏ (rotate, POST, PATCH; `GET /admin/keys` vẫn 403 nhờ `assertSuperAdmin` lớp hai, đúng thiết kế) — `78c9f9b05830` khớp |
| M2 | `ui.controller.ts` thêm `sid: String(id)` vào metadata failure | 3 đỏ — `9f55eaff4358` khớp |
| M3 | `failedStep` cố định `pre_revoke` | 2 đỏ (sessions, sweep) — khớp |
| M4 | validator bỏ `\p{Cf}` | 3 đỏ (U+200B, FEFF, 202E) — `fa1afa164b11` khớp |
| M5 | bỏ allowlist scheme | 8 đỏ — khớp |
| M6 | `updateScopes` gọi `validateResourceIdentifier` (chặn resource cũ) | 1 đỏ (LEGACY) — `30a8aba77a32` khớp |
| M7 | filter `logger.error(errorForLog(e), String(e))` | xanh: tham số 2 (stack) không được ghi ra pino ⇒ mutation không có tác dụng thật, không phải lỗ hổng của test |
| M7c | filter log `errorForLog(e) + e.message` | 1 đỏ (T2) — `07c84cf3dd8b` khớp |
| M8 | filter `status >= 400` | 1 đỏ (4xx) — khớp |
| M9 | mô tả DTO `identifier` về chuỗi cũ | 1 đỏ (OpenAPI) — `07514747df73` khớp |

Mỗi lần chạy được lọc theo đúng spec (`pnpm test:int run80-tester` / `session-reflection`). Lần đầu M2/M3/M7b lỗi biên dịch TS (biến không dùng / `string|undefined`) ⇒ viết lại mutation, đã ghi ở trên.

## Test FAIL
(không có)

## Ghi nhận
- Nhánh format trên đường ghi (`validateResourceFormat`: không tuyệt đối / có fragment) vẫn echo giá trị trong `error_description` 400 (vd. `resource must be an absolute URI: abc`). Phạm vi fold chỉ đòi câu cố định cho 2 kiểm mới, senior cũng đã nêu. Input là của chính super_admin, trả về dạng JSON, không ghi log ⇒ không chặn ⇒ **DEBT-532**.
- Sự cố tester: một lần sửa `session-reflection.int-spec.ts` bằng Python ghi lỗi encoding (cp1252) làm file bị cắt về 0 byte. Đã khôi phục bằng `git show HEAD:…` (file vốn không có thay đổi chưa commit), 694 dòng, rồi sửa lại bằng UTF-8. `git diff` chỉ còn +87 dòng của tester.
- Không có tiến trình treo. Jest thoát sạch mọi lần. Không đụng PID 23008.

## Coverage acceptance criteria
- [x] T1 AC(1)(2)(3) — `ui.int-spec` (dev) + `session-reflection` DEBT-526 ×3 (store thật, audit lưu thật, retry); AC(4)(5) — `ui.int-spec` (dev).
- [x] T2 AC(1)(2)(3) — unit `html-exception.filter.spec` (dev) + `run80-tester` T2 ×2 (pino thật); AC(4) — `redis-down.int-spec` (dev).
- [x] T4 — `admin-keys`/`admin-api` int (dev) + unit guard + `run80-tester` ma trận 4 route × 4 actor.
- [x] T3 — unit validator + `admin-api` int + parity FE (dev) + `run80-tester` 22 từ chối / 6 nhận / legacy PATCH + `/authorize` + `/token`; DEBT-531 — `seed-dev`/`admin-target-risk` int (dev retry 1).
- [x] T5 — `federation.int-spec` F15 lỗi commit (dev); int full xanh.

## Coverage security invariants / risk matrix
- [x] Identity / Authorization: tenant_admin vs super_admin × auth_time cũ/mới; sai scope (`insufficient_scope` đi trước). Đã kiểm thứ tự lỗi không lộ thêm (403 giống từng byte).
- [x] Input: Cc/Cf/Z ở đầu, giữa, trong host; scheme nguy hiểm hoa/thường; chuỗi đã percent-encode được nhận và lưu nguyên.
- [x] State: resource cũ không hợp lệ vẫn sửa được và vẫn dùng ở runtime; retry logout sau lỗi ở từng bước.
- [x] Dependency: lỗi ở pre_revoke/sessions/sweep với Redis/Mongo thật; lỗi hạ tầng ⇒ 5xx, không giả thành công.
- [x] Request chain: logout lỗi ⇒ request kế tiếp (retry) 302 + refresh chết; `/authorize` → `/token` với resource cũ.
- [x] Exposure: response 400/403/5xx, audit lưu Mongo, log pino (secret/email/session id/token).
