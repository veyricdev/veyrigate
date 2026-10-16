# Tech Lead Review — 2026-10-16 (run 25, lượt 1)

## Kết luận: PASS (có fold bắt buộc F1–F7 vào `tasks.md`)

Không có blocker kiến trúc / không cần task [BE]. Các sai lệch giữa tasks.md và hành vi IdP thực tế đều nhỏ, đã fold trực tiếp vào `tasks.md` § "Fold tech-lead". Dev phải làm theo phần fold (ghi đè chỗ mâu thuẫn).

Preflight: `codegraph --version` 1.6.2, `status` up to date, `sync` xong. Đọc code qua CodeGraph MCP + Git Bash. Không compose up / FLUSH / drop, không commit, không sửa code.

## Kiến trúc đề xuất (điều chỉnh)

Giữ nguyên kiến trúc hiện có (SPA React Router Data Mode, client OIDC viết tay, token in-memory, transient sessionStorage có `purpose`). Lab tái dùng đúng các mảnh sẵn có, không thêm abstraction:
- Dựng URL lab = `beginLogin()` hiện có + biến đổi 1 param trên `URL` (không builder thứ hai).
- Callback lab = thêm 1 giá trị `purpose: "lab"` (cùng mẫu `aud-probe` run 24), consume-once, không gọi `/token`.
- Giả mạo `state` = chạy **`finishLogin` thật** (không chép lại phép so state — tránh test tautology và tránh làm DEBT-103 tệ hơn).
- Gate dev = `import.meta.env.DEV` + `buildRoutes({lab})` + `lazy` import (tree-shake ở prod).

## Đối chiếu code thật

### Hành vi `/authorize` (be/src/modules/oauth/authorize/authorize.service.ts `handle()`, controller `:170-188`)
- Phase 1 (chưa tin `redirect_uri`): thiếu/không biết `client_id`, `redirect_uri` không exact-match ⇒ `AuthorizeErrorPage` ⇒ **400 `error.eta`, không redirect** (INV-4 / open-redirect).
- Phase 2: mọi lỗi ⇒ 302 về `redirect_uri` với `error` + `state` echo + `iss` (`buildErrorRedirect`). Thứ tự: response_type → `code_challenge_method !== 'S256'` (plain/thiếu ⇒ `invalid_request`) → `code_challenge` regex (`invalid_request`) → scope → `resolveResource` (không absolute ⇒ `InvalidResourceError` ⇒ `invalid_target`; absolute chưa đăng ký/không thuộc allowlist ⇒ `invalid_target`) → `max_age` → `prompt`.
- **`nonce` KHÔNG bắt buộc ở IdP** (spec §9.1: IdP chỉ mang nonce vào ID token; validate là việc RP). tasks.md gộp "bỏ nonce" vào nhóm "redirect `error=`" là **sai** ⇒ F1 sửa kỳ vọng thành "IdP trả `code`".
- `prompt=none` khi đang có phiên IdP + consent đủ ⇒ trả `code`, không phải `login_required`. Trong lab, người dùng gần như luôn còn cookie IdP ⇒ kịch bản "prompt=none khi chưa login" không tất định. `prompt=none&max_age=0` ⇒ `maxAgeExceeded` true ⇒ `login_required` tất định ⇒ F1 thay thế; bản "không phiên" chỉ assert trong E2E context sạch (tuỳ chọn).

### Luồng callback (fe-sso-test/src/router.tsx `:54-90`)
- Loader hiện có nhánh `aud-probe` → `silentRestore` → `?error=` → `finishLogin`. Nhánh `lab` chèn được cùng mẫu, không đụng `handleCallback`. Yêu cầu bắt buộc (F2): kiểm `state` khớp transient + `iss` === issuer trước khi tô xanh (kỳ vọng "redirect error + iss đúng" chỉ đo được nếu lab thực sự kiểm `iss`), consume transient trước mọi nhánh, không lưu `code`/`state`.
- Mọi kịch bản 3b/3c rời SPA bằng full navigation ⇒ mất phiên in-memory. Nếu `/lab` bọc `requireAuth`, khi quay về sẽ bị đẩy sang `/login` và kết quả one-shot không hiển thị ⇒ F4: `/lab` không guard cấp route, chỉ mục Refresh replay cần phiên.

### Refresh replay (Task 2) — khả thi không cần BE
- `refreshSession` (`refresh.ts`) single-flight, cập nhật store, `clear()` khi lỗi ⇒ bước 1 và 3 dùng lại `refresh()`; bước 2 gọi `postToken` trực tiếp với RT cũ.
- BE `refresh-token.service.ts classifyMiss`: RT cũ có `revokedAt && replacedBy` ⇒ reuse ⇒ `revokeFamily` ⇒ `invalid_grant`. RT hậu duệ sau đó bị `revokedAt` (không `replacedBy`) ⇒ plain invalid ⇒ `invalid_grant`. Kỳ vọng 3 bước khớp.
- `postToken` hiện chỉ ném `Error("Token endpoint error (code)")` ⇒ F6: thêm mã lỗi có cấu trúc để lab phân biệt `invalid_grant` với network/5xx (fail-closed: không kết luận được = đỏ).
- E2E: `VITE_OIDC_SCOPE` có `offline_access`, seed client có `refresh_token` grant ⇒ có RT.

### E2E (Task 4)
- `playwright.config.ts` chạy FE bằng `vite dev` ⇒ `import.meta.env.DEV=true` ⇒ `/lab` có mặt cho smoke. `webServer` BE đã chạy `db:sync-indexes` mỗi lần (trừ `E2E_REUSE=1`) ⇒ "tiền đề ops" đã tự động (F7a).
- Nhánh B (probe redirect chuỗi: revoke → authorize `other` (+consent lần đầu) → callback probe → `/demo/me` → `prompt=none` → callback → `/api-test`) toàn bộ là top-level navigation, Playwright theo được bằng `waitForURL` predicate + race consent như `login.spec.ts`. Khả thi; giữ phương án hạ A+C nếu flaky.
- Thu secret: phải nghe MỌI `POST /token` 200 (login, probe, restore) ⇒ `page.on('response')`, không `waitForResponse` đơn.
- Smoke refresh replay revoke family ⇒ phá phiên ⇒ chạy sau cùng / test riêng.

## Trả lời câu hỏi
- **Q-25.1**: KHÔNG cần BE. Phản hồi `/token` đủ chứng minh INV-10/11 (lý do ở trên). Không thêm endpoint dev xem family (tăng bề mặt tấn công, không cần thiết).
- **Q-25.2**: Hoãn DEBT-099. E2E đã phủ redirect chuỗi; popup cần nới COOP — ngoài phạm vi.
- **Q-25.3**: `import.meta.env.DEV` (không biến env mới), qua `buildRoutes({ lab })` thuần để test được nhánh prod, `lazy` import để bundle prod không chứa Lab; nhánh callback lab cũng gated. Acceptance đo được: grep `dist/` sau `build`.

## Cổng security design (trust boundary: RP ↔ IdP redirect, `/token`)
- Tài sản: refresh/access/ID token, `code`, `code_verifier`, `state`/`nonce`. Actor: người dùng dev, kẻ tấn công tạo link `/callback?...`. Boundary: URL callback (attacker-controllable), `/token`.
- Invariant: token chỉ memory; transient consume-once trước mọi nhánh (gồm lab và `?error=` thường — DEBT-102); lab không bao giờ gọi `/token` với `code` nhận ở nhánh lab.
- Abuse: link `/callback?error=...` giả khi có transient lab ⇒ không ghi PASS nếu `state` lệch (F2); replay RT là chính kịch bản lab (đúng); state tamper đi qua code thật (F3); purpose lạ fail-closed; prod build không có nhánh lab (F5).
- Failure: network/5xx ở `/token` ⇒ lab đỏ "không kết luận được", không retry (F6); IdP trang lỗi ⇒ lab hiển thị "kỳ vọng không quay về".
- Exposure: không render RT cũ/mới; không lưu `code`/`state`; mã lỗi qua whitelist (DEBT-080/104); E2E assert DOM/storage không chứa mọi secret thu được.
- Test âm có trong acceptance: state giả ⇒ 0 `/token`; mutation bỏ so state ⇒ RED; `buildRoutes({lab:false})` không có `/lab`.

## Điểm mạnh
- Phạm vi gọn (4 task), thứ tự phụ thuộc đúng (DEBT-101/102 trước E2E vì `<a href>` làm mất phiên giữa chừng E2E).
- Tái dùng hạ tầng probe/transient-purpose của run 24; không cần BE.
- Acceptance có mutation và giữ bất biến exposure của run 21–24.

## Vấn đề (đã fold vào tasks.md — dev bắt buộc theo)
- [x] F1: Kỳ vọng "bỏ nonce" sai (IdP trả `code`); `prompt=none khi chưa login` không tất định ⇒ thay `prompt=none&max_age=0`; bổ sung `resource` không absolute; bảng kỳ vọng đầy đủ.
- [x] F2: Nhánh callback `lab` phải kiểm `state` + `iss`, consume-once, không `/token`, không lưu `code`/`state`.
- [x] F3: Đổi `state` phải chạy `finishLogin` thật, assert 0 `/token`.
- [x] F4: `/lab` không `requireAuth` cấp route.
- [x] F5: Gate dev qua `buildRoutes({lab})` + `lazy`; acceptance grep `dist/`.
- [x] F6: Lỗi `/token` có cấu trúc; RT cũ chỉ trong ref.
- [x] F7: E2E: sync-indexes đã tự động; nghe mọi `/token`; smoke lab chạy sau cùng.

## Đề xuất (không bắt buộc)
- Nếu chạm `callback.ts` cho F3, có thể gộp DEBT-104 (dùng `describeOAuthError`) — nhỏ, cùng file; KHÔNG mở rộng sang DEBT-103 trong run này.
- Debt mới → backlog: **DEBT-107** (`/callback?error=` nhánh thường không kiểm `state`/`iss`), **DEBT-108** (call log Playwright khi fail có thể in URL `/callback?code=&state=`).
