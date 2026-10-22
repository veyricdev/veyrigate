# Log — run 43 — A5 API layer fe-admin (+ DEBT-281/282/289)

## orchestrator — 2026-10-22
- Tiếp lane ADMIN sau run 42 (`9d2de22`). Tự sinh `tasks.md` từ plan §6 A5, D11 + DEBT-281 (E2E step-up round-trip), 282/289 (503 vs 500). Cổng → tech-lead.

## tech-lead — 2026-10-22
- Preflight CodeGraph (1.6.2, sync). Đối chiếu `9d2de22`: `bff.ts` (refresh/viewer), `errors.ts`, `start.ts`, `server.ts`, `idp.ts`/`discovery.ts`; BE `admin.openapi.ts`, `admin-auth.errors.ts`, `StepUpGuard`, controllers admin; CI `ci.yml`, `e2e/playwright.config.ts`.
- **PASS kèm fold** (mục "Fold tech-lead" trong `tasks.md`). Q-43.1 dùng snapshot `fe-admin/openapi/admin.json` + kiểm lệch ở CI `git diff` và spec E2E. Q-43.2 lưu ý định ở `sessionStorage`: dùng một lần, gắn `sub`/path/action, allowlist field, không lưu secret, không tự gửi. Q-43.3 mock theo hợp đồng qua `fetch` inject, không MSW. Q-43.4 DEBT-281 chuyển sang A6.1. DEBT-282 xử lý bằng ALS ở `server.ts` (500→503).
- Phát hiện: OpenAPI BE không có schema response ⇒ response dùng zod allowlist (DEBT-290). `doRefresh` không ép refresh được khi gặp 401 ⇒ fold `staleAccessToken`.
- Phiên bản chốt: `openapi-typescript@7.13.0` (dev), `@tanstack/react-query@5.104.1`.
- Backlog: mở DEBT-290…293; dời đích DEBT-281 → A6.1, 283 → A6, 285/288 → A7. Chuyển → **frontend-dev**.

## frontend-dev — 2026-10-22
- Preflight CodeGraph 1.6.2 (sync). T1: `fe-admin/openapi/admin.json` (lấy bằng `fetch:api` từ BE dist tạm `NODE_ENV=test` :4900, DB E2E, đã dừng) + `gen:api` → `src/server/admin-api/schema.d.ts` (sha256 ổn định qua 2 lần gen); CI `quality` thêm bước `gen:api && git diff --exit-code`; spec `e2e/tests/admin-openapi.spec.ts` (deep-equal, lỗi in lệnh cập nhật; kiểm âm: snapshot sửa tay ⇒ đỏ, khôi phục sha256 OK). Override `@redocly/openapi-core@1.34.20` (1.34.21 < 14 ngày, DEBT-295).
- T2: `bff.ts` thêm `accessToken`/`refreshRejected`/`dropSession` + `refresh(key,{staleAccessToken})`; `src/server/admin-api/{client,schemas,instance}.ts` theo bảng ánh xạ; server fn `listClients`/`getClient`/`updateClient`. **Lệch fold có chủ đích:** Start serialise lỗi bằng `ShallowErrorPlugin` (chỉ `message`) ⇒ `code`/`uncertain` mất ⇒ dùng union `{ ok:false, error:{code,message,uncertain?} }` (`adminCall`); `AdminApiError extends PublicError` chỉ còn ở server.
- T3: `@tanstack/react-query@5.104.1` (Wrap trong `getRouter`), retry GET transient ≤ 2, mutation `retry 0`/`gcTime 0`, `unauthenticated` ⇒ login; `step-up.ts` (`fea:stepup`, 1 lần, 10', action+path+sub, zod allowlist, logout xoá). T4: DEBT-282 (ALS `src/server/unavailable.ts`), DEBT-289 (discovery), `azp` aud đơn.
- Verify: fe-admin 315 test (+78), typecheck/lint/build/check:bundle xanh (0 hit; client bundle không có chuỗi admin-api server); root lint/typecheck/test xanh (be 401, fe-sso-test 269); audit high 0; E2E 26/26 × 2. Mutation 23 (cp+sha256): 22 bị giết; sống: lookup `inflight` lần 2 trong `refresh` (tương đương ở đường test được). Smoke dev Redis/IdP chết: `/` có cookie ⇒ 503 no-store, `/auth/login` ⇒ 503.
- Debt: đóng DEBT-282/289 (+ phần `azp` của 288); mở DEBT-294 🟡 (BE: `frontchannelLogoutUri` sai kiểu trong OpenAPI), 295 💭. Hook `useClients`/`useClient`/`useUpdateClient` chưa có UI dùng (A6). → **senior-reviewer**.

## senior-reviewer — 2026-10-22
- Preflight CodeGraph (sync).
- Đã review diff kể từ `75d1699`:
  - `src/server/admin-api/*`, `src/features/admin-api/*`;
  - `bff.ts` (`accessToken`/`refreshRejected`/`dropSession`, forced refresh);
  - `errors.ts`, `unavailable.ts`/`server.ts`, `discovery.ts`, `id-token.ts`, `router.tsx`;
  - CI, spec E2E, override.
- Tự chạy typecheck, lint, test (315), build, `check:bundle` (0 hit) và `gen:api`: tất cả xanh. Không chạy E2E.
- **Kết quả: PASS**, không có 🔴.
  - Chấp nhận lệch fold (trả lỗi bằng union value), vì union hẹp hơn throw.
  - Các invariant đều đạt:
    - AT không ra khỏi server;
    - không có proxy chung;
    - có CSRF;
    - refresh một lần, single-flight;
    - intent step-up an toàn;
    - ALS tách theo request;
    - phân loại 503/500 đúng;
    - `azp`.
- 🟡 ghi vào backlog:
  - DEBT-296: khe race trong forced refresh.
  - DEBT-297: mutation 2xx thiếu `uncertain`.
  - DEBT-298: server fn GET thiếu `no-store`.
- 💭: StrictMode làm `takeIntent` mất bản nháp ở dev; chưa có cơ chế cắt vòng lặp đăng nhập lại.
- → **tester**.

## tester — 2026-10-22
- Preflight CodeGraph (sync). Đối chiếu acceptance + fold; đọc `client.ts`/`instance.ts`/`clients.ts`/`inputs.ts`/`step-up.ts`/`unavailable.ts`/`start.ts` + CSRF middleware của Start (không Sec-Fetch-Site/Origin/Referer ⇒ 403).
- **PASS**: fe-admin 417 + 1 expected fail / 22 file (+103 test, 4 file mới); E2E full **27/27** (spec mới `admin-api-risk.spec.ts`: CSRF replay 7 biến thể × POST/GET ⇒ 403, control 200; id độc ⇒ `not_found` BE thật; input sai ⇒ lỗi chung, BE không bị gọi; không rò). Root lint/typecheck/test xanh (be 401, fe-sso-test 269); audit high 0 (1 ignore DEBT-226 có sẵn); build + check:bundle 0 hit.
- `gen:api` không diff (sha256 ổn định); mutation snapshot (cp + sha256) ⇒ types đổi và spec `admin-openapi` đỏ kèm lệnh cập nhật ⇒ khôi phục, sha256 khớp.
- Mở **DEBT-299** 🟡 [FE]: `saveIntent` thất bại không xoá intent cũ ⇒ khôi phục bản nháp cũ (giữ case `it.fails`). Không sửa code sản phẩm. Chi tiết: `test-report.md`. → **orchestrator** đóng run.
