# Tasks — run 25 — T5 (security lab) + T4 E2E + DEBT-101/102

> Hiện thực plan §7 Phase T: **T5** (plan dòng 259) + phần E2E của **T4** (plan dòng 258) đã tách từ run 24 (xem `runs/24-T3-B6.5-T4/tasks.md` § "Tách run 25"). Kéo **DEBT-101, DEBT-102** (backlog, senior run 24, "nên sửa trước E2E"). INV liên quan: plan §9 bảng ánh xạ — INV-3/4 (PKCE S256, `redirect_uri` exact), INV-8 (`aud`), INV-9 (`iss`), INV-10/11 (refresh atomic + reuse ⇒ revoke family), INV-14/15 (`resource`). Ghi chú plan §11 (dòng 322): client public + strict rotation ⇒ lỗi mạng có thể buộc login lại — lab phải nói rõ, không coi là bug.
>
> Thứ tự + phân công: **Task 1** trước (FE, chặn E2E) → **Task 2, Task 3** (FE) → **Task 4** (E2E, frontend-dev) sau cùng. Không có task [BE] trừ khi tech-lead phát hiện lab cần hỗ trợ IdP.
>
> Ràng buộc chung: token chỉ in-memory, không lộ token thô vào DOM/storage/URL/log (bất biến run 21–24); lab chỉ có ở dev (giống demo-resource — tắt khi build production / `import.meta.env.PROD`); không echo `error_description` thô (DEBT-080). Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop dữ liệu `aegate-*`.

## Fold tech-lead (2026-10-16) — BẮT BUỘC, ghi đè chỗ mâu thuẫn bên dưới
Đối chiếu code thật (`authorize.service.ts handle()` + `authorize.controller.ts`, `fe-sso-test/src/router.tsx`, `oidc/{client,callback,probe,transient,authorize,refresh,token-exchange}.ts`, `e2e/playwright.config.ts`). Chi tiết lý do: `review-techlead.md`.
- **F1 — Bảng kỳ vọng `/authorize` (Task 3b) theo hành vi IdP hiện tại** (thứ tự kiểm ở `handle()`: client → redirect_uri [trang lỗi] → response_type → method → challenge → scope → resource → max_age → prompt → session/consent):
  | Kịch bản | Biến đổi | Kỳ vọng (xanh) |
  |---|---|---|
  | `redirect_uri` lệch (INV-4) | đổi path/port, vd `http://localhost:5173/callback-x` | IdP **400 trang lỗi first-party, KHÔNG redirect** (`AuthorizeErrorPage`). Lab không nhận được callback ⇒ hiển thị "kỳ vọng: không quay về"; xác nhận bằng E2E |
  | `code_challenge_method=plain` (INV-3) | đổi method | redirect `error=invalid_request` + `state` khớp + `iss`=issuer |
  | bỏ `code_challenge` | xoá param | redirect `error=invalid_request` + `iss` |
  | `resource` lạ (absolute, chưa đăng ký) | vd `${issuer}/unknown/` | redirect `error=invalid_target` + `iss` (INV-14/15) |
  | `resource` không absolute | vd `demo` | redirect `error=invalid_target` + `iss` |
  | bỏ `nonce` | xoá param | **IdP CHẤP NHẬN** (nonce là trách nhiệm RP — spec §9.1, OIDC Core: optional ở code flow) ⇒ redirect **`code`** + `iss` (có thể qua consent). Xanh = "IdP không lỗi; RP tự chặn ở `validateIdToken` (INV-6, test T2)". KHÔNG được ghi kỳ vọng là `error=` |
  | `prompt=none` + `max_age=0` (thay "prompt=none khi chưa login" — tất định dù đang có phiên IdP) | thêm 2 param | redirect `error=login_required` + `iss` |
  | `prompt=none` khi **không có phiên IdP** | thêm `prompt=none` | redirect `error=login_required` + `iss`; trên lab hiển thị "chỉ đúng khi chưa đăng nhập IdP"; chỉ assert trong E2E (context sạch, không cookie) nếu làm |
  Lab dựng URL bằng `beginLogin(...)` hiện có rồi biến đổi đúng 1 param trên `URL` trả về (không viết builder thứ hai).
- **F2 — Nhánh callback `purpose:"lab"`** (Task 3): mở rộng union `Transient.purpose` thành `"login" | "aud-probe" | "lab"` + lưu `labScenario` (id kịch bản, chuỗi whitelist) trong transient. Trong loader `/callback`, kiểm lab **trước** `isAudProbePending` hoặc ngay sau, **trước** `consumeSilentRestoreFlag`. Nhánh lab: đọc + `clearTransient` ngay (consume-once); chỉ ghi kết quả `{scenario, outcome: "error"|"code"|"rejected", error?: <mã whitelist qua describeOAuthError/sanitise>, issOk, stateOk}` nếu **`state` khớp transient**; `iss` phải có và === issuer mới tô xanh; KHÔNG BAO GIỜ gọi `/token`, KHÔNG lưu `code`/`state` vào storage; rồi `redirect('/lab')`. `state` lệch/thiếu transient ⇒ không ghi PASS (ghi `rejected`/không ghi). Purpose lạ ⇒ fail-closed như hiện tại (không vào nhánh lab/probe).
- **F3 — Task 3c (đổi `state`) phải đi qua code thật**: lab gọi `beginLogin` (purpose `login`, returnTo `/lab`), rồi đổi `state` trên URL trước `location.assign` (transient giữ state gốc) + set cờ one-shot `oidc:lab_expect=state-tamper`. Loader `/callback` khi thấy cờ: gọi **`finishLogin` thật** trong try; ném "state mismatch" ⇒ ghi PASS; nếu thành công ⇒ ghi FAIL (đỏ). Cấm viết lại phép so state riêng trong lab. Acceptance thêm: unit test fetch giả ⇒ **0 lần gọi `/token`**; mutation bỏ so state ở `callback.ts exchange()` ⇒ RED.
- **F4 — Guard `/lab`**: `/lab` **KHÔNG** dùng `requireAuth` ở cấp route (mọi luồng 3b/3c rời trang bằng full navigation ⇒ mất phiên in-memory; kết quả one-shot phải hiển thị được khi quay về ẩn danh). Riêng mục Refresh replay (Task 2) cần phiên: không có phiên ⇒ hiển thị link `<Link to="/login?returnTo=/lab">`. Thay câu "guard như các trang khác" ở Task 2.
- **F5 — Gate dev-only (Q-25.3)**: dùng `import.meta.env.DEV` (Vite thay hằng lúc build ⇒ tree-shake), KHÔNG thêm biến env mới. Dựng bảng route qua hàm thuần `buildRoutes({ lab: boolean })` (export `routes = buildRoutes({ lab: import.meta.env.DEV })`); route `/lab` dùng `lazy: () => import("./routes/Lab")`; nhánh callback `lab`/`lab_expect` cũng chỉ chạy khi `lab=true` (prod ⇒ transient `lab` bị bỏ qua, đi nhánh login thường ⇒ `handleCallback` fail-closed). Acceptance: test `buildRoutes({lab:false})` không có `/lab` + callback không vào nhánh lab; `pnpm -C fe-sso-test build` rồi grep `dist/` không chứa chuỗi đặc trưng của Lab (vd `data-testid="lab-`). E2E chạy `vite dev` ⇒ DEV=true, smoke lab khả thi.
- **F6 — Task 2 chi tiết**: bản sao RT cũ giữ trong `useRef`/biến module (không `useState`, không render, không storage). Bước 1 dùng `refresh()` hiện có (single-flight, cập nhật store). Bước 2 gọi `postToken` trực tiếp với RT cũ; bước 3 dùng `refresh()` (store tự `clear()` khi lỗi — đúng kỳ vọng). Phân loại lỗi: thêm thuộc tính có cấu trúc (vd `TokenEndpointError { code }`) trong `token-exchange.ts` thay vì parse chuỗi message; giữ nguyên message cũ để không vỡ test. Xanh chỉ khi code === `invalid_grant` (network/`http_5xx` ⇒ đỏ "không kết luận được"). Hiển thị văn bản plan §11: mất phiên là hành vi đúng.
- **F7 — Task 4**: (a) `db:sync-indexes` **đã nằm trong `webServer` BE** (`playwright.config.ts`) ⇒ chỉ cần chạy tay khi `E2E_REUSE=1`; (b) thu secret bằng `page.on('response')` cho MỌI `POST /token` 200 (mảng), không `waitForResponse` một lần; (c) nhánh B: chờ `waitForURL` predicate theo pathname `/api-test` (không dùng regex in ra URL chứa `code`), consent `other` có/không bằng race URL như `login.spec.ts`; (d) smoke lab refresh replay chạy **sau cùng** hoặc test riêng có login riêng (nó revoke family ⇒ phá phiên); assert panel 3 bước xanh và `refresh_token` cũ/mới không có trong DOM/storage; (e) `page.content()` lab không chứa secret thu được.
- **Q-25.1**: KHÔNG cần BE — `/token` đã trả `invalid_grant` cho cả replay (reuse ⇒ `revokeFamily`) lẫn hậu duệ (`revokedAt` set, `replacedBy` null ⇒ plain invalid). **Q-25.2**: hoãn DEBT-099. **Q-25.3**: xem F5.

### [x] Task 1 [FE]: DEBT-101 + DEBT-102 — điều hướng nội bộ giữ session; xoá transient ở nhánh lỗi callback
- DEBT-101: đổi `<a href>` nội bộ (`Home.tsx:78-79`, `Profile.tsx:81`, `Tokens.tsx:88`, `ApiTest.tsx:145`, và mọi chỗ tương tự) sang `<Link to>` của react-router.
- DEBT-102: `router.tsx` nhánh `/callback?error=` gọi `clearTransient` trước khi `redirect('/error')`.
- **Acceptance**: (a) test điều hướng Home→Profile→Tokens→ApiTest giữ nguyên session in-memory (không gọi lại authorize); (b) router test: sau `/callback?error=...` sessionStorage không còn `state/nonce/code_verifier`; (c) mutation: trả lại `<a href>` / bỏ `clearTransient` ⇒ test RED.

### [x] Task 2 [FE]: T5(a) — Lab refresh replay (INV-10/11)
- Trang `/lab` (dev-only, guard như các trang khác) mục "Refresh replay": giữ bản sao refresh token cũ **chỉ trong memory**, refresh hợp lệ một lần (rotate), rồi gửi lại token cũ.
- **Kết quả mong đợi**: replay ⇒ `invalid_grant`; sau đó refresh bằng token mới (hậu duệ) cũng `invalid_grant` (family bị revoke). Mỗi bước tô xanh/đỏ theo kỳ vọng; phiên chính bị mất là ĐÚNG — hiển thị hướng dẫn login lại (plan §11).
- **Acceptance**: unit test luồng 3 bước với fetch giả (đúng/sai kỳ vọng ⇒ xanh/đỏ); không render token thô; mutation đảo kỳ vọng ⇒ RED.

### [x] Task 3 [FE]: T5(b)+(c) — Lab tham số `/authorize` + giả mạo `state`
- (b) Bảng kịch bản dựng URL `/authorize` từ tham số chuẩn rồi biến đổi một tham số: `redirect_uri` lệch (INV-4), `code_challenge_method=plain` (INV-3), bỏ `code_challenge`, bỏ `nonce`, `resource` lạ / không absolute (INV-14/15), `prompt=none` khi chưa login. Mỗi dòng có "kết quả mong đợi" (IdP hiển thị trang lỗi KHÔNG redirect với `redirect_uri` sai; redirect `error=...` + `iss` đúng với lỗi khác) và kết quả thực tế ghi lại khi quay về `/callback` (purpose `lab`, không đổi code lấy token).
- (c) Đổi `state` trước khi xử lý callback ⇒ client phải từ chối (không gọi `/token`), hiển thị PASS.
- Trường hợp IdP hiển thị trang lỗi (không redirect) ⇒ lab hiển thị hướng dẫn "kỳ vọng: IdP không redirect", ghi kết quả thủ công/được E2E xác nhận.
- **Acceptance**: unit test dựng URL đúng từng kịch bản; nhánh callback purpose `lab` không gọi `/token`, ghi kết quả một-lần (không token/code trong storage); state giả ⇒ từ chối; mutation ⇒ RED.

### [x] Task 4 [E2E]: T4 E2E — `/api-test` A/B/C (+ smoke lab nếu khả thi)
- Theo đúng run 24 § "Tách run 25": login → `/profile` → `/api-test`: A `/demo/me` **200**; B (redirect chuỗi) ⇒ panel "PASS 401"; C `/userinfo` **200**. Chặn MỌI response `/token` (gồm probe + khôi phục `prompt=none`) để lấy secret phục vụ assert; consent `other` có thể có/không.
- Sau B: `sub` ở `/profile` trùng trước đó. Không chuỗi access/refresh token trong `page.content()`/`localStorage`/`sessionStorage`; log E2E không chứa `code`/`state`/cookie/token (giữ run 23).
- Smoke lab: refresh replay (Task 2) chạy end-to-end ⇒ xanh.
- **Tiền đề ops**: chạy `pnpm -C be db:sync-indexes` trên DB `sso-idp-e2e` (chỉ đồng bộ index theo schema — bỏ index cũ `consents.userId_1_clientId_1`, runbook DEBT-028; KHÔNG xoá dữ liệu).
- **Acceptance**: `pnpm -C e2e e2e` xanh **2 lần liên tiếp**; nếu nhánh B không ổn định ⇒ hạ xuống A+C, ghi DEBT, báo tester.

## Câu hỏi cho tech-lead
- Q-25.1: Lab có cần hỗ trợ BE không (vd. endpoint dev để xem trạng thái family)? Đề xuất: KHÔNG — chỉ dựa trên phản hồi `/token`.
- Q-25.2: DEBT-099 (popup thay redirect chuỗi) — làm trong run này hay hoãn? Đề xuất: hoãn (E2E đã phủ redirect chuỗi).
- Q-25.3: Cách gate dev-only cho `/lab` ở FE (`import.meta.env.DEV` vs biến env riêng).
