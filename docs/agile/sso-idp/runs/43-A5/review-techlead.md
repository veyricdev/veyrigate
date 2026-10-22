# Tech Lead Review — 2026-10-22 — run 43 (A5 API layer fe-admin)

## Kết luận: PASS (fold bắt buộc nằm ở mục "Fold tech-lead" trong `tasks.md`)

Plan giải quyết đúng A5 (D3, D11, INV-26) và DEBT-282/289. Các điểm còn thiếu ở cổng security (bảng ánh xạ lỗi, forced refresh khi gặp 401, chỗ lưu ý định step-up, chống proxy chung) đã được chốt cụ thể và fold thẳng vào `tasks.md`. Vì vậy không có blocker và không cần trả về analyst. Không phải sửa `be/`.

## Kiến trúc đề xuất

- fe-admin vẫn là một BFF khối. Mỗi endpoint admin được bọc bởi một server fn mỏng, cố định: không có proxy chung. Server fn lấy AT từ phiên Redis qua hàm mới `accessToken()` trong `createAuth`, dùng lại single-flight refresh của run 42.
- **Q-43.1 (nguồn OpenAPI):** dùng snapshot `fe-admin/openapi/admin.json` commit vào repo, gen offline. Kiểm lệch ở hai lớp:
  - CI `quality` chạy `gen:api` rồi `git diff --exit-code` trên `schema.d.ts`.
  - Spec E2E so `/openapi/admin.json` lấy từ BE thật (`NODE_ENV=test`) với snapshot.

  Cả hai đều không đụng `be/`.
- **Phát hiện chặn D11 một phần:** OpenAPI của BE không có schema response. Không controller nào có `@ApiOkResponse`, `nest-cli.json` không bật swagger plugin, mapper trả về `interface`. Hướng xử lý:
  - Types sinh ra chỉ dùng cho request.
  - Response parse bằng zod (strip). Schema này đồng thời là allowlist, nên field lạ không thể rò ra browser.
  - Phần còn lại ghi thành DEBT-290.
- **Q-43.2 (ý định form qua step-up):** lưu trong `sessionStorage` của tab, không lưu ở Redis. Lý do: callback step-up luôn cấp session id mới và huỷ phiên cũ (`bff.ts`, bước 10), nên state server-side gắn phiên cũ sẽ mất. Ràng buộc:
  - dùng một lần, TTL 10 phút;
  - gắn với `action`, `path` và `sub`;
  - chỉ lưu field nằm trong allowlist, payload được parse lại bằng zod;
  - không lưu secret, token hay dữ liệu server;
  - không tự gửi lại;
  - đăng xuất thì xoá.
- **Q-43.3 (chiến lược test):** mock theo hợp đồng bằng cách inject `fetch` vào `test/support/fake-idp.ts`, body lỗi copy từ `admin-auth.errors.ts`. Không dùng MSW, không boot BE trong vitest. Hợp đồng thật được giữ bằng snapshot OpenAPI và E2E ở A6.1.
- **Q-43.4 (phạm vi):** run này làm Task 1–3, DEBT-282/289 và kiểm `azp`. **DEBT-281 (E2E step-up) chuyển sang A6.1**, vì A5 chưa có form thật, còn dựng trang sandbox thì thành code chết trên production.
- **DEBT-282:** đổi 500 thành 503 ở server entry `src/server.ts`, qua `AsyncLocalStorage`:
  - cờ được đặt khi `toPublicError` ra 503 (ở `safely` và ở `serverFnErrorBoundary`);
  - chỉ đổi khi response là 500 và cờ đã đặt;
  - stream body được chuyển tiếp, không đọc.

  Không cần sửa router-core.
- **Phiên bản chốt** (tra registry chỉ-đọc ngày 2026-10-22):
  - `openapi-typescript@7.13.0`: devDependency, phát hành 2026-02-11.
  - `@tanstack/react-query@5.104.1`: phát hành 2026-10-02, được 20 ngày. Bản 5.104.2–5.104.5 còn dưới 14 ngày nên không dùng.

  Peer dependency khớp TS 5.7.3 và React 19.3.0. Không thêm `openapi-fetch`, `msw` hay `@tanstack/react-router-ssr-query`.

## Điểm mạnh

- Bám D3: đã nêu `prompt=login&max_age=0` và yêu cầu quay lại đúng thao tác. Run 42 đã có sẵn phần nền: `stepup=1`, chặn đổi danh tính, `sanitizeReturnTo`.
- Có nhận thức YAGNI: chỉ làm server fn mà A6 cần, MSW chỉ thêm khi thật sự cần.
- Gom DEBT-282/289 vào đúng chỗ, tức tầng lỗi dùng chung.
- Nền tảng sẵn có:
  - boundary `PublicError` / `toPublicError` (DEBT-275);
  - CSRF middleware cho mọi serverFn;
  - `fetchWithTimeout` với `redirect: "manual"`;
  - fake IdP đã có `/admin/me` và refresh.

## Vấn đề (đã fold vào tasks.md, frontend-dev phải làm; không phải lý do REJECT)

- [x] **"401 thì refresh 1 lần" không làm được với code hiện tại.** `doRefresh` sẽ return sớm khi `atExp` còn hạn. Đã fold `refresh(key, { staleAccessToken })`: chỉ refresh khi AT trong store vẫn là AT vừa bị từ chối. Kèm test: hai 401 song song chỉ sinh đúng 1 refresh grant (replay RT sẽ revoke cả family).
- [x] **Chưa có cách lấy AT cho server fn.** `createAuth` chỉ export `viewer`. Đã fold hàm `accessToken()`, và token không được rời `src/server/`.
- [x] **Plan ghi "không retry mutation" nhưng lại cho 401 refresh rồi gửi lại.** Đã làm rõ: gửi lại sau 401 an toàn vì guard chặn trước handler. Ngược lại, timeout/network/5xx của mutation thì **không retry** và gắn `uncertain: true` để UI invalidate.
- [x] **Retry chồng hai tầng.** BFF không retry gì ngoài 401. Query chỉ retry GET khi lỗi là transient, tối đa 2 lần.
- [x] **Lỗi có kiểu sẽ bị boundary đổi thành 500.** `toPublicError` thay mọi lỗi không phải `PublicError`. Đã fold `AdminApiError extends PublicError` (own property `code`), kèm test serialise không chứa AT hay body BE. Nếu seroval không giữ own property thì đổi sang union giá trị.
- [x] **Confused deputy / SSRF.** Cấm proxy chung. Path param qua zod rồi `encodeURIComponent`. Không nhận URL, method hay header từ client.
- [x] **Thiếu exposure rule cho 400/409.** Cho phép trả `error_description` cắt còn tối đa 200 ký tự, dạng text thuần, vì A6.1 cần hiện lỗi validate. Các code khác dùng message chung. Log không chứa body.
- [x] **Mutation cache giữ kết quả 5 phút theo mặc định**, nguy cơ giữ secret ở A6.1. Đã fold `mutations.gcTime = 0`, không persister.
- [x] **Ý định step-up**: nguy cơ khôi phục nhầm cho người dùng khác (máy dùng chung), payload bị sửa, lưu cả secret. Đã fold ràng buộc với `sub`, parse zod, dùng allowlist field, dùng một lần.
- [x] **DEBT-289:** chỉ lỗi network/timeout/5xx mới thành 503. Issuer mismatch hoặc sai schema vẫn là 500 (fail-closed, lỗi cấu hình).

## Đề xuất (không bắt buộc)

- Debt mới DEBT-290…293 đã ghi vào `backlog.md`.
- Đích các debt cũ đã dời: DEBT-281 sang A6.1; DEBT-283 sang A6; DEBT-285 và phần còn lại của DEBT-288 sang A7.
