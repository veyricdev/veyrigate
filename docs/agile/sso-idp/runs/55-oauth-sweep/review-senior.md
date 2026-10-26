# Senior Review — 2026-10-26 (run 55, sweep debt bảo mật OAuth)

## Kết luận: PASS

Không có 🔴, không có 🟡. Còn 3 💭 và 2 dòng ponytail nhỏ, không cần đưa vào backlog. Chuyển **tester**.

Phạm vi: diff chưa commit so với HEAD `e94267b` trong `be/src` (11 file) và `be/test` (6 file), cùng `backlog.md` và `STATUS.md`. Không xét `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`. Preflight CodeGraph 1.6.2: `status` OK, `sync` OK (index build v1.5.0, chưa re-index).

Đã tự chạy lại (foreground): `pnpm -C be typecheck` OK, `pnpm -C be lint` OK, `pnpm -C be test` 37 suite / 587 test xanh. Không chạy int/vault/E2E vì đã có output thật của dev (int 1285, vault 26, E2E 35) và lượt review này không cần thêm bằng chứng runtime.

## Tổng quan

Thay đổi gọn và bám đúng fold của tech-lead. Mỗi debt chỉ thêm một điều kiện fail-closed vào predicate có sẵn, không đổi kiến trúc:

- **F1**: thêm `sessionRef` vào context và helper `trustedClient`.
- **F2**: thêm một dòng vào liveness, dùng lại `isAdminCapableClient`.
- **F3**: callback nhận thêm `resource`, dùng cùng predicate với `recheckCodeGrant`.
- **F4**: một khối `try/catch asUnavailable`.

Điểm tốt:

- Test int chạy qua HTTP thật với CSRF thật.
- Có đối chứng cho mọi nhánh âm, nên chứng minh được không chặn nhầm.
- Mutation 12/12 khớp đúng danh sách tech-lead yêu cầu.
- Prefix Redis `authz_code:*` mà test dùng khớp `authorization-code.service.ts:35`, nên assertion "0 code mới" có tác dụng thật.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

### F1: DEBT-123 + DEBT-130 (`authorize.service.ts`)

- **Thứ tự trong `decideConsent` (L349–384) đúng fold**:
  1. `consume` (single-use, context bị đốt cả khi refuse).
  2. `trustedClient(ctx)` cho mọi nhánh: client bị disable thì `findByClientId` lọc `disabledAt: null` (`client.service.ts:215`), sau đó kiểm `isRegisteredRedirectUri`.
  3. `kind !== 'consent'` ⇒ `login_required`, nay tới URI đã kiểm lại.
  4. Kiểm `sessionRef` **trước** nhánh deny.
  5. Deny.
  6. Kiểm resource/admin trên `client` đã đọc ở bước 2, không gọi `findByClientId` lần hai.
  7. `assertMember`, grant, code.

  Nhánh lỗi của `assertMember` redirect sau `trustedClient`, nên URI đã được kiểm.
- **Context thiếu `sessionRef`**: `ctx.sessionRef === undefined` ⇒ `null`. Có test int ghi context legacy thẳng vào Redis, cho cả approve và deny.
- **Chỉ có 2 chỗ gọi `createContext`** (L259 `login`, L300 `consent`). Chỉ context consent mang `session.ref`. Vì `resume` đi qua `handle`, context consent tạo sau khi resume cũng được gắn phiên.
- **Trang lỗi không lộ `state` hay URI**: `expectPage` kiểm 400, không có `Location`, body không chứa `victim-state` hay `app.example.com`.
- **`resume` với `reauthAfter` (L173–181)**: `trustedClient` chạy trước `login_required`. Test int dùng `prompt=login` và phiên cũ: còn URI ⇒ 302, đã gỡ URI ⇒ 400.
- **`sessionRef` không lộ ra ngoài**:
  - Không có trong `AuthorizeOutcome`, nên không lên view.
  - Không bị log (không có logger trong context service hay controller).
  - Test xác nhận giá trị không có trong HTML, `Location` và toàn bộ audit của user.
  - `session.ref` là sha256 của session id. Giá trị này vốn đã có trong claim `sid` của AT, nên là định danh công khai chứ không phải credential, và chỉ lưu trong Redis có TTL.
- **Tương tác với luồng khác**:
  - Logout giữa chừng: controller kiểm lại phiên trước khi gọi `decideConsent`; phần này không đổi.
  - Step-up / `prompt=login` ở tab khác sinh phiên mới: ref đổi ⇒ trang lỗi. Đây là fail-closed, và CSRF cũng gắn với cookie phiên nên UX hợp lệ không bị giảm.
  - Context `login` gửi vào cửa consent vẫn trả `login_required` mà không kiểm phiên. Đây là chủ đích: request_id nằm trong URL `returnTo`, cùng lớp với DEBT-413 đã ghi.
- **CsrfGuard không đổi**: diff không chạm controller hay `csrf.service`.
- **Khi lookup lỗi**: `findByClientId` ở nhánh deny/login_required ném lỗi ⇒ propagate ⇒ 5xx, không redirect.

### F2: DEBT-177 (`access-token-liveness.ts:101-105`)

- **Mọi caller đã truyền `adminAud`**: kết quả grep và CodeGraph cho thấy đủ 4 caller sản phẩm (introspect, userinfo, demo, `AdminTokenGuard`), cùng `refresh-token.int-spec` và unit spec. Không còn chỗ gọi nào khác. Tham số là bắt buộc, nên `tsc` sẽ bắt mọi caller bị sót.
- **`adminAud` nhất quán**: đều là `adminResourceIdentifier(issuer)`, giống `AuthorizeService.adminAud` và `TokenService.adminResource`.
- **Không có đường vòng qua `aud` dạng mảng**: `verifyAccessToken` đã bác `aud` khác string, và `AccessTokenClaims.aud: string`. Vì vậy so sánh `claims.aud === adminAud` không bị lách bằng `aud` mảng.
- **Thứ tự đúng fold**: sub → sid → client → admin-capable → aud → user. Unit test xác nhận không gọi `users.exists` khi bị từ chối.
- **Token thường không bị chặn nhầm**: `it.each` 8 shape client với aud thường đều live. Predicate dùng đúng `isAdminCapableClient` (allowlist), nên các shape thiếu field hoặc mang giá trị lạ đều bị từ chối.
- **`AdminTokenGuard` không yếu đi**: vẫn giữ `isAdminCapableClient(seen.client)` (L187), nay thêm lớp kiểm trong liveness. Lookup của guard trả `Client` đầy đủ, `tsc` OK.
- **Không có import cycle**: `token.service.ts` không import liveness.
- **Int test**: client chuyển sang misfit ⇒ `/userinfo` 401 `invalid_token` và `/introspect` `{active:false}`, qua một RS confidential được phép hỏi `aud=admin`. Đổi lại thành capable ⇒ 200, nên không có trạng thái dính.

### F3: DEBT-216 (`refresh-token.service.ts:298`, `token.controller.ts:438-449`)

- **Resource lấy từ doc đã rotate**: `recheck(result.userId, result.resource)`. Trường `RotationResult.resource: string` là bắt buộc (schema RT cũng bắt buộc), nên không có family "không resource" bị chặn nhầm.
- **Callback dùng `fresh` cho cả hai predicate** (`adminTargetForbidden`, `resolveForClient`), cùng reason `resource_not_allowed` như `recheckCodeGrant`.
- **Nếu `resolveForClient` ném lỗi**: chỉ xảy ra với URI sai định dạng, điều không thể có với giá trị đã lưu. Lỗi sẽ rơi vào nhánh catch sẵn có (revoke best-effort, `recheck_failed`, 500), tức fail-closed.
- **Không phá run 54**: không đổi `peek`, `consume`, `rotate`, Lua hay thứ tự ký. Re-check vẫn chạy sau `rotate`, và token đã ký bị bỏ đi khi refuse.
- **Retry không thành reuse**: `expectRefreshRefused` kiểm replay ⇒ `invalid_grant` và 0 `TOKEN_REUSE_DETECTED`. Body bị từ chối giống hệt body của RT rác, tức opaque.
- **Đối chứng**: gỡ một resource khác ⇒ 200. Biến thể admin chuyển sang `{confidential,none}` ⇒ `resource_not_allowed`.

### F4: DEBT-410 (`vault-transit-key-provider.ts:175-183`)

- **`listKeys`** bọc `asUnavailable` giống `getPublicKeys`; `rotate` không đổi.
- **Unit**: mạng, timeout, 5xx, 429 và AbortError ⇒ unavailable; 400, 403 và metadata sai shape ⇒ không unavailable; cache còn hạn ⇒ 0 lần fetch; có test pin cho `rotate`.
- **Int**: dùng code provider Vault thật với fetch lỗi.
  - super_admin ⇒ 503, `retry-after: 5`, `no-store`, body chuẩn, không có `kid` / `kty` / addr / mount.
  - tenant_admin ⇒ 403 và provider không được gọi.
  - `rotate` ⇒ 500, không có `Retry-After`, audit `rotate_failed`.
- **Mock được dọn**: `afterEach jest.restoreAllMocks()` (L373) gỡ spy, nên không rò sang test sau.

### Lộ token trong terminal dev (F3, lúc test RED)

Chấp nhận được. AT được ký bằng key tạm của test, thư mục tmp đã xoá, và token chỉ xuất hiện trong terminal agent. Grep repo và log cho `eyJ`/`hvs.`/PEM ra 0. Token đó không xác thực được với bất kỳ môi trường nào.

## 🟡 Nên sửa

Không có.

## 💭 Nit

**Truyền tham số tuỳ chọn theo vị trí ở `createContext`**
`authorize.service.ts:300-308` — gọi `createContext('consent', …, params, undefined, session.ref)`.
Vì sao: hai tham số tuỳ chọn truyền theo vị trí với `undefined` chen giữa dễ bị đảo khi thêm field mới.
Đề xuất: cân nhắc gộp thành `opts: { reauthAfter?, sessionRef? }` khi chạm lại hàm này.

**Biến thể admin của F3 chưa thử replay**
`token-code-recheck.int-spec.ts` (test "DEBT-216 admin variant") chỉ kiểm `reuseAudits === 0` mà không thực hiện replay. Ca chính đã phủ DEBT-215 qua `expectRefreshRefused`, nên chỉ thiếu đối xứng.

**DEBT-414**
Test cross-session cũ còn assert có điều kiện. Dev đã ghi 🟢 trong backlog; nên đóng khi chạm lại authorize int spec. Mục này đã có trong backlog, không cần thêm debt.

## ✂️ Ponytail

- be/src/modules/oauth/authorize/authorize.service.ts:L369: shrink: `ctx.sessionRef === undefined ||`. `session.ref` luôn là string, nên chỉ cần `ctx.sessionRef !== session.ref` (giữ nguyên cũng được vì nó ghi rõ ý đồ fail-closed).
- be/src/modules/oauth/authorize/authorize.service.ts:L304: shrink: `undefined, session.ref` theo vị trí. Dùng object tuỳ chọn (xem 💭 ở trên).

net: -1 lines possible.

Không có debt mới (không có 🟡). Danh sách debt vẫn dừng ở DEBT-414.
