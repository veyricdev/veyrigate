# Log — run 10 — B4.1 (`/authorize`)

> Nhật ký ngắn theo thời gian. Mỗi mục ≤ 8 dòng.

## Khởi tạo (orchestrator)
- Mở run 10 cho B4.1 (M3 walking skeleton). spec/plan đã có ⇒ bỏ qua analyst, sinh tasks.md từ plan §B4.1.
- Preflight CodeGraph: v1.5.0, index up-to-date, sync OK.
- Phụ thuộc B3.2/B2.3/B2.5 đã xong (run 05/06/09). Cổng tiếp theo: tech-lead.
## [2026-10-06 11:58] tech-lead
- Đã làm: Preflight CodeGraph OK (v1.5.0, index up-to-date); đọc spec §9.1-9.2/§13/§15,
  plan §B4/§12, backlog DEBT-015/019/020; verify code clients/resources/sessions/ui/redis.
- File đổi: runs/10-B4.1/review-techlead.md (mới)
- Kết quả: PASS — kèm 8 điều kiện (C1-C8), quan trọng nhất C1 (wiring module/AppModule)
  và C2 (filter HTML cho nhánh lỗi trước redirect_uri hợp lệ).
- Bàn giao: backend-dev — triển khai B4.1 theo tasks.md + điều kiện Cn trong review.

## backend-dev — B4.1
- `/authorize` + `AuthorizeRequestContext`: `AuthorizeService` (validate+flow), `AuthorizeRequestContextService` (Redis Lua single-use, TTL 10'), `AuthorizeController`, wire `OauthModule`→AppModule (C1).
- Open-redirect (INV-3/C2): lỗi trước khi redirect_uri hợp lệ ⇒ `AuthorizeErrorPage` (trang HTML qua `HtmlExceptionFilter`); sau đó ⇒ `AuthorizeRedirectError` redirect kèm error/state/iss (RFC 9207).
- C3 Lua get-and-delete atomic; C4 prompt=none ⇒ login_required/consent_required qua redirect; C5/C6 xác nhận CORS+CSP form-action không áp dụng (redirect GET) — ghi chú trong code; C7 audit OAUTH_AUTHORIZE không log nhạy cảm; C8 request_id opaque ≠ state (test).
- PKCE `plain` reject; resource map identifier→resourceId qua ResourceService; scope lọc theo client.scopes.
- Verify: typecheck PASS, lint PASS (sau eslint --fix), unit 67/67, int 158/158 (+19 authorize.int-spec). Cổng → senior-reviewer.

## [2026-10-06 16:58] senior-reviewer
- Đã làm: Preflight CodeGraph OK; đọc tasks/review-techlead/log/spec §9.1-9.2; đọc + chạy app
  thật (`pnpm start:dev` + Mongo/Redis thật) để verify C1-C8 bằng `curl` thật, không chỉ test.
- Phát hiện 🔴: `/authorize` không bao giờ `consume()` lại `AuthorizeRequestContext` khi resume
  sau login — tái tạo bằng HTTP thật (register→verify→login→follow redirect → 400 "Invalid
  request"). 19/19 test pass vì không test nào gọi qua `AuthorizeController` ở cấp HTTP.
- File đổi: runs/10-B4.1/review-senior.md (mới); backlog.md (+DEBT-022, DEBT-023, 🟡 ponytail).
- Kết quả: REJECT. Bàn giao: backend-dev — sửa blocker (wire resume qua `request_id`) + thêm
  test HTTP-level (`app.inject`, như `ui-auth.int-spec.ts`).

## backend-dev — B4.1 (sửa sau senior REJECT)
- Blocker: `/authorize` không bao giờ `consume()` context khi resume sau login ⇒ thêm `AuthorizeService.resume(requestId)` (consume → dựng lại params → chạy lại `handle`); controller đọc `request_id`, context hết hạn ⇒ trang lỗi (không redirect).
- Tách `respond()` dùng chung cho nhánh fresh + resumed; thêm field `request_id` vào `AuthorizeParams`.
- Thêm 5 test HTTP-level qua `AuthorizeController` (`app.inject`): no-session→302/login; login→resume→200 ready (context không mất); request_id lạ→400; client_id lạ→400 không redirect; PKCE plain→302 error.
- DEBT-023 đóng (bỏ `UiModule` thừa khỏi OauthModule). DEBT-022 giữ mở (gộp type Fastify req/reply → B4.2+).
- Verify: typecheck PASS, lint PASS, unit 67/67, int 163/163 (authorize 24/24). Cổng → senior-reviewer (re-review).

## [2026-10-07] orchestrator — fix test hang (phát hiện khi verify B4.1)
- pnpm test:int treo ~3.4h: 5 file int-spec gọi `MongooseModule.forRoot(MONGO_URI)` không option ⇒ NestJS retry kết nối vô hạn (rxjs `retryWhen`) khi Mongo test (`27117`) không chạy. App thật không dính vì `MongoModule` đã có `retryAttempts:5`.
- Sửa: thêm `serverSelectionTimeoutMS:5000, retryAttempts:5, retryDelay:1000` vào `forRoot` của authorize/authentication/identity/tenant-context/ui-auth int-spec (khớp app).
- Khởi động container test `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479`.
- Verify: Mongo down ⇒ spec fail trong 2s (trước: treo vô hạn); Mongo up ⇒ unit 67/67, int 163/163, lint PASS.
## [2026-10-07 15:45] senior-reviewer (re-review)
- Đã làm: Preflight CodeGraph OK (cài v1.6.2, init/sync); chạy lại unit 67/67 + int 163/163 +
  lint + typecheck từ đầu (PASS, khớp khai báo); verify HTTP thật blocker cũ đã sửa (register→
  verify→login→resume → 200, không còn 400); verify single-use/open-redirect/PKCE plain qua curl.
- Phát hiện 🔴 MỚI: resume() lỗi Phase 2 (vd scope/resource bị đổi giữa tạo context và resume) →
  controller dùng params HTTP hiện tại (thiếu redirect_uri khi resume) để buildErrorRedirect →
  TypeError → 500, không phải redirect OAuth error đúng hợp đồng. Tái tạo được bằng HTTP thật.
- File đổi: runs/10-B4.1/review-senior.md (ghi đè); backlog.md (+DEBT-024).
- Kết quả: REJECT. Bàn giao: backend-dev — sửa để lỗi Phase 2 trong nhánh resume luôn có đủ
  redirect_uri để redirect (không throw TypeError/500); thêm test HTTP-level cho case này.

## [2026-10-07 16:xx] backend-dev (fix DEBT-024)
- Sua `AuthorizeRedirectError` tu mang `redirectUri?`/`state?`; gan trong `catch` cua
  `AuthorizeService.handle()` ngay tai diem `redirect_uri` da trusted (Phase 1 xong), truoc khi
  rethrow. `AuthorizeController.buildErrorRedirect(err)` doc tu error, khong con doc `params` cua
  request HTTP hien tai -- nhanh fresh va resume dung chung mot duong.
- Them 1 test HTTP-level (`authorize.int-spec.ts`): tao context qua fresh request (chua login) ->
  sua `client.scopes` trong Mongo bo `openid` -> login -> resume -> assert 302 kem
  `error=invalid_scope`+`state`+`iss` (khong con 500).
- Verify: typecheck PASS; lint PASS (eslint --fix cho indent try-block); unit 67/67; int 164/164
  (authorize suite 25/25, gom test moi). DEBT-024 dong (backlog.md); DEBT-022 giu mo.
- Cong -> senior-reviewer (re-review lan 3).

## [2026-10-07 17:xx] senior-reviewer (re-review lan 3)
- Da lam: Preflight CodeGraph OK; chay lai unit 67/67 + int 164/164 (authorize 25/25, gom test
  moi) tu dau; verify blocker DEBT-024 bang HTTP that (`pnpm start:dev` + Mongo/Redis dev that):
  chen client Mongo -> register -> verify Mailpit -> fresh `/authorize` -> thu hep `client.scopes`
  -> login -> resume -> **302 redirect `error=invalid_scope`+`state`+`iss`, khong con 500**.
- Soat regression: single-use (replay 400), open-redirect (unknown client_id -> 400, khong co
  `Location`), PKCE plain fresh (302 dung) -- tat ca PASS. Soat code: 14 throw site cua
  `AuthorizeRedirectError`/`AuthorizeErrorPage` deu trong try-block gan `redirectUri`/`state`,
  khong co duong lot ra ngoai catch.
- File doi: runs/10-B4.1/review-senior.md (ghi de). Khong co DEBT moi.
- Ket qua: PASS. Don file tam curl (be_review_*.txt), client/user review khoi Mongo dev, dung
  `start:dev`. Ban giao: tester.

## [2026-10-07 17:xx] tester
- Chay unit (`pnpm.cmd test` 67/67) + int (`pnpm.cmd test:int` 164/164) that tren container test
  27117/6479 - PASS, exit 0. Ra soat 9 AC (spec 9.2, INV-3/4/14/15) vs `authorize.int-spec.ts`:
  7/9 da phu du HTTP+service level; 2 gap (AC8 response_type!=code, AC9 prompt=none) chi co test
  service-level, thieu test HTTP-level 302+error_description.
- Them 2 test HTTP-level (`app.inject`, cung pattern resume) + bo sung assert error_description
  vao test PKCE-plain co san. KHONG sua code production. Chay lai toan bo: int 166/166 PASS,
  `authorize.int-spec.ts` rieng 27/27 PASS.
- Risk matrix (identity/credential/authorization/input/state/request-chain/exposure) da map du
  vao test-report.md, khong co invariant nao thieu bang chung.
- Ket qua: PASS. Khong co DEBT moi (gap la thieu test, khong phai hanh vi sai). Don temp file,
  khong tao be/body.json hay be/cookies.txt. Ban giao: orchestrator dong run.
