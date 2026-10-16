# Senior Review — 2026-10-16

## Kết luận: REJECT

Lý do duy nhất: 1 🔴 [BE] — `POST /authorize/consent` tiêu thụ được context "đòi re-auth" (`reauthAfter`) và cấp code bằng phiên cũ, tức là con đường thứ hai bỏ qua đúng lỗ hổng mà fold Task 2 yêu cầu đóng. Đã tái hiện bằng int-test tạm (file probe đã xoá). Phần còn lại (Task 1, 3, 4 và phần lớn Task 2) tốt, có thể giữ nguyên.

## Tổng quan

- Task 1 (admin guard) làm sạch: thứ tự bearer → verify → `aud === adminResourceIdentifier(issuer)` → bắt buộc `sid` → liveness → scope → membership active + vai trò của `client.tenantId` đúng fold. Tenant lấy từ client phát hành (tra server-side), không đọc request. Lỗi mờ (401 `invalid_token` chung cho mọi lỗi token; 403 `forbidden` không phân biệt non-member và member không có vai trò). Lỗi hạ tầng propagate ra 5xx, có test. Brand `TenantContext` vẫn không export. Dùng lại client mà liveness đã nạp (một lần tra, một snapshot), hợp lý.
- Step-up guard: cửa sổ, độ lệch +30s, kiểm số nguyên, clock inject được, 403 `step_up_required` không kèm header RFC 9470 (đúng D3). Refresh không mang `auth_time` nên bị từ chối (fail-closed).
- Đã sửa `GET /login` khi có phiên sống; `resume()` kiểm `reauthAfter`; `max_age=0` luôn bắt re-auth. Test có cả bypass gọi thẳng `request_id` lẫn trường hợp không có phiên.
- Task 3: `NODE_ENV` bắt buộc, seed-dev chuyển sang allowlist, E2E `e2e/config/env.ts` set `test`. Task 4 gọn, có spy đếm số lần gọi.
- Đã verify: `pnpm -C be typecheck` sạch; `pnpm -C be test` 22 suites, 220/220.

## 🔴 Blocker

- [ ] **[BE] Bảo mật / INV-26: re-auth bị bỏ qua qua `POST /authorize/consent`.** Vị trí: `be/src/modules/oauth/authorize/authorize.service.ts:267` (`decideConsent`) và `:332` (`issueCodeFromContext`).
  - **Vấn đề**: `decideConsent` `consume()` bất kỳ `AuthorizeRequestContext` nào theo `request_id`. Nó không phân biệt context "login_required" (có `reauthAfter`) với context "consent_required", và không kiểm `reauthAfter`. Code sinh ra lấy `authTime` của phiên cũ.
  - **Tái hiện** (int-test probe trên `vg-test-*`, đã xoá):
    1. Có phiên sống, gọi `/authorize?…&prompt=login&max_age=0`, nhận 302 `/login?returnTo=/authorize?request_id=X`.
    2. `GET /login?returnTo=…` với cookie cũ trả về form có `_csrf` (CSRF identity = cookie phiên).
    3. `POST /authorize/consent {_csrf, request_id: X, approve: "true"}` với cookie cũ.
    4. Kết quả: **302 `…/callback?code=…&state=rp-state`**. Code được cấp mà không đăng nhập lại.
  - **Vì sao chặn**: đây đúng là lớp lỗi fold Task 2 bắt sửa ("gọi thẳng `/authorize?request_id=X` không đăng nhập lại vẫn được code", vi phạm OIDC Core §3.1.2.1 `prompt=login`/`max_age`). Run này mới chỉ đóng một trong hai cửa tiêu thụ context. Ai giữ cookie phiên (XSS ở first-party, cookie bị đánh cắp, máy dùng chung) sẽ qua được yêu cầu "đăng nhập lại" của RP. Với admin, guard `auth_time ≤ 5'` vẫn chặn nếu phiên cũ hơn 5'. Tuy vậy RP nào dựa vào `max_age`/`prompt=login` cho thao tác nhạy cảm của chính nó (nhất là A5/fe-admin khi phiên dưới 5') đều bị vô hiệu. Acceptance (b) và (e) của Task 2 chưa phủ cửa này.
  - **Đề xuất (tối thiểu)**: trong `decideConsent`, sau `consume`, nếu `ctx.reauthAfter !== undefined` thì xử lý như `resume`: ném `AuthorizeRedirectError('login_required')` (gắn `redirectUri`/`state` từ ctx), không ghi consent, không cấp code. Context đã bị consume nên không lặp. Cân nhắc làm triệt để hơn: thêm `kind: 'login' | 'consent'` vào context. Khi đó `decideConsent` chỉ nhận `consent`, `resume` chỉ nhận `login`, đóng luôn cả lớp type-confusion giữa hai luồng.
  - **Test cần thêm**: int-test "reauth context + `POST /authorize/consent` approve ⇒ `error=login_required`, không có code, không ghi consent". Mutation: bỏ check thì test phải RED.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả |
|---|---|
| Tenant không lấy từ input (INV-24) | OK. `tenantId = client.tenantId` tra server-side. Test bỏ qua query/body/`X-Tenant-Id`. |
| Thứ tự kiểm / không tạo oracle | OK. Mọi lỗi token đều ra 401 chung. Scope lỗi (403) được kiểm trước membership, nhưng chỉ lộ thông tin cho người đã có token admin hợp lệ, không lộ tenant khác. Không phân biệt non-member với member thiếu vai trò. |
| Fail-closed khi DB/Redis lỗi | OK. Không có try/catch nuốt lỗi trong guard. Test Mongo (client, membership) và Redis (tombstone) đều ra 5xx. `GET /login` khi peek lỗi rơi về hành vi cũ (302 `/`). Không mở rộng quyền vì `resume` vẫn kiểm. |
| Identity: thiếu / sai / hết hạn / bị thu hồi | OK. Thiếu `sid` ⇒ 401. Sau logout (tombstone) ⇒ 401. ID token ⇒ 401. `aud=demo` ⇒ 401. Client bỏ resource ⇒ 401. |
| Step-up: resume trực tiếp | OK qua `/authorize?request_id`. **FAIL qua `POST /authorize/consent`** (🔴). |
| Step-up: refresh token | OK. Không có `auth_time` ⇒ 403. |
| Step-up: lệch đồng hồ / `auth_time` tương lai | OK. Cho phép +30s, từ +31s là 403. Biên đúng 5' được test. |
| `/login` open-redirect / vòng lặp | OK. `safeReturnTo` không đổi, `requestIdFromReturnTo` khớp chính xác. Context single-use nên không lặp. Form chỉ hiện khi context có `reauthAfter`. |
| `/admin/*` không CORS | OK. `CORS_PREFLIGHT_PATHS` là allowlist tĩnh, không chứa `/admin`. Mọi response admin đều `no-store`. |
| Exposure | OK. `/admin/me` chỉ trả `{sub, tenantId, roles}`, không có `sid`/token. Log peek không ghi request_id. |
| `NODE_ENV` bắt buộc không phá dev/test/E2E | OK. `.env.example` = development, Jest = test, `e2e/config/env.ts` = `test`. Không có workflow CI BE trong repo. |

## 🟡 Nên sửa

- **[BE]** `authorize.service.ts:208` đặt `reauthAfter = Date.now()`, còn `session.authTime` lấy từ clock của `SessionService` (`this.now()`, inject được). Hệ quả:
  - (a) Chạy nhiều node: nếu node phục vụ `POST /login` có đồng hồ chậm hơn node phục vụ `/authorize` nhiều hơn thời gian người dùng gõ mật khẩu, user hợp lệ nhận `login_required`. Lỗi này là fail-closed nhưng gây khó chịu.
  - (b) Trong test, hai nguồn clock lệch nhau.
  - Cân nhắc: so sánh thêm một dấu không phụ thuộc đồng hồ, ví dụ lưu `staleSessionRef` (ref phiên lúc tạo context) và yêu cầu `session.ref !== staleSessionRef`; hoặc cho `AuthorizeService` dùng chung clock. Đã ghi DEBT-121.
- **[BE]** Sau khi sửa 🔴, nên thêm phân loại `kind` cho context (xem đề xuất ở trên). Làm vậy thì `consent` không ăn được context login và `resume` không ăn được context consent. Nếu không làm trong lượt sửa 🔴 thì ghi DEBT-122.

## 💭 Nit

- `tenant-context.ts` (StepUpGuard): `typeof authTime !== 'number' || !Number.isInteger(authTime)` thừa vế đầu. `Number.isInteger` đã trả false với mọi giá trị không phải number.
- `demo.enabled.ts`: comment bị xuống dòng lẻ ("…when `NODE_ENV` is unset (Q-24.2). An unset or any" rồi mới sang dòng mới). Nên reflow.

## ✂️ Ponytail

- `be/src/modules/identity/tenant-context/tenant-context.ts:L246`: shrink: `typeof authTime !== 'number' || !Number.isInteger(authTime)`. Thay bằng `!Number.isInteger(authTime)` (TS cần cast `authTime as number` ở 2 so sánh sau, hoặc khai báo `authTime` là `number | undefined`).
- `be/src/modules/identity/user-tenant.service.ts:L49`: shrink: `activeRoles` gần như lặp `isActiveMember` (cùng filter `{userId, tenantId, status:'active'}`). Có thể cho `isActiveMember` dùng lại: `return (await this.activeRoles(u, t)) !== null`.
- `be/src/modules/ui/ui.controller.ts:L141`: shrink: `reauthRequested` và `loginFormActionOrigin` mỗi hàm peek một lần. Nên peek một lần và dùng chung (đã có DEBT-120).

net: -8 lines possible.

---

# Senior Review — Lượt 2 — 2026-10-16

## Kết luận: PASS

🔴 của lượt 1 đã đóng. Bản sửa chọn phương án triệt để (`kind` trên context) chứ không chỉ vá `reauthAfter`, nên đóng luôn lớp nhầm lẫn context giữa hai cửa. Không thấy hồi quy ở phần đã PASS lượt 1.

## Tổng quan

- `AuthorizeRequestContext.kind: 'login' | 'consent'` là trường bắt buộc. `createContext` nhận `kind` làm tham số đầu tiên. Chỉ có 2 nơi tạo context, và kind được gán đúng ở cả hai: nhánh `!hasSession` là `'login'` (kèm `reauthAfter` khi cần re-auth), nhánh cần consent là `'consent'`. Nhánh consent chỉ chạy khi `reauthRequired` sai, nên không thể có context consent mang `reauthAfter`.
- `resume` kiểm `ctx.kind !== 'login'` và trả `null` (trang 400 first-party). Bước này chạy sau `consume`, nên context đi nhầm cửa vẫn bị tiêu thụ (single-use).
- `decideConsent` kiểm `ctx.kind !== 'consent'` **trước** nhánh deny/approve và ném `AuthorizeRedirectError('login_required')` về `redirectUri`/`state` của ctx. Khi đó không ghi consent, không audit, không cấp code.
- Đã rà lại các nơi tiêu thụ theo `request_id`: chỉ có `consume` ở 2 cửa trên. `peek` ở `/login` chỉ đọc.

## Đã kiểm lại (chạy thật)

| Kịch bản | Kết quả |
|---|---|
| Repro lượt 1: `prompt=login&max_age=0` với phiên sống, rồi `GET /login` lấy `_csrf`, rồi `POST /authorize/consent approve=true` | 302 `error=login_required`, `state` khớp, không có `code`, spy `grant` 0 lần, lần 2 ra 400 (test `admin.int-spec.ts` "bypass via POST /authorize/consent") |
| Context kind sai cửa: context consent đi qua `GET /authorize?request_id` | 400, đã consume, POST sau đó ra 400 (test dev) |
| Context login thường (không có `reauthAfter`) đi qua POST consent | `login_required`, không consent (test dev) |
| **Probe tạm**: context re-auth `prompt=login` + POST consent **deny** | 302 `login_required` (không phải `access_denied`), không ghi consent, replay ra 400 |
| **Probe tạm**: context cũ không có `kind` (ghi thẳng vào Redis) | Cả 2 cửa từ chối: resume ra 400, consent ra `login_required` không code |
| **Probe tạm**: 4 POST consent đồng thời trên context `max_age=0` | Đúng 1 response 302 (`login_required`), không response nào có `code` |
| Mutation (của reviewer): vô hiệu check `kind` trong `decideConsent` | admin+authorize int: **2 RED**. Đã khôi phục, `cmp` byte-identical |

Probe được chèn tạm vào `be/test/authorize.int-spec.ts` rồi khôi phục từ bản sao, kiểm `sha256sum -c` OK, file không còn chuỗi PROBE.

Verify: `pnpm -C be typecheck` sạch, `lint` sạch, unit 22 suites **220/220**, int 25 suites **542/542** (`vg-test-*`).

## Security invariants / trust boundaries đã kiểm (lượt 2)

| Invariant | Kết quả |
|---|---|
| INV-26 re-auth (`prompt=login`/`max_age`) qua cả 2 cửa | OK |
| Single-use / replay / concurrency của context | OK (consume Lua atomic, cửa sai vẫn consume) |
| Fail-closed với context cũ (không có `kind`, TTL ≤ 10') | OK (cả 2 cửa từ chối) |
| Không lộ thông tin qua lỗi | OK (về RP chỉ có `error`/`state`/`iss`; cửa resume trả trang 400 chung) |
| Không hồi quy phần lượt 1 (admin guard, step-up, `/login`, `NODE_ENV`, DEBT-105/106) | OK. Diff retry chỉ chạm `authorize.service.ts`, `authorize-request-context.service.ts` và test. Toàn bộ int xanh |

## 🔴 Blocker

Không có.

## 🟡 Nên sửa

- **[BE] DEBT-123: context consent không gắn với phiên đã tạo ra nó.** Vị trí: `authorize.service.ts:282` (`decideConsent`).
  - **Vấn đề**: code được cấp cho `session` tại thời điểm POST, không kiểm đó có phải phiên đã mở màn consent hay không. Hiện tại rủi ro thấp vì `request_id` là CSPRNG, CSRF gắn với cookie phiên, và context single-use. Đây không phải hồi quy, hành vi này có từ trước.
  - **Đề xuất (defense-in-depth)**: lưu `sessionRef` vào context lúc tạo. Ở `decideConsent`, yêu cầu `session.ref === ctx.sessionRef`; nếu khác thì trả `login_required`. Cùng cơ chế này cũng giải được DEBT-121: context login lưu `staleSessionRef` và yêu cầu `session.ref` khác, không phụ thuộc đồng hồ.

## 💭 Nit

- Context đi nhầm cửa ở `decideConsent` ném `login_required` ngay cả khi người dùng bấm deny. Vẫn đúng fail-closed. RP nhận `login_required` thay vì `access_denied`, chấp nhận được.
- Các nit lượt 1 (`typeof … || !Number.isInteger`, reflow comment `demo.enabled.ts`) vẫn còn. Không chặn.

## ✂️ Ponytail (diff retry)

- `be/src/modules/oauth/authorize/authorize.service.ts:L289`: shrink: khối 4 dòng tạo `AuthorizeRedirectError('login_required')` + gán `redirectUri`/`state` lặp lại y hệt `resume` (L131–134). Thay bằng helper `private reauthError(ctx)` hoặc thêm tham số ctor cho `AuthorizeRedirectError`.

net: -4 lines possible.
