# Tech Lead Review — 2026-10-23
## Kết luận: PASS (có fold)

Đã đối chiếu với code `b9e6cb8` và source dist thật của TanStack trong `node_modules/.pnpm`. Các ràng buộc chi tiết nằm ở `tasks.md`, mục "Fold tech-lead (2026-10-23)". Khi có mâu thuẫn, fold được ưu tiên hơn text gốc. Phạm vi vừa đủ cho 1 run, size M, không cần tách.

## Kiến trúc đề xuất (nếu cần điều chỉnh)
- **Một wrapper ở server entry** (`src/server/security-headers.ts` + `src/server.ts`):
  - Sinh nonce mới cho mỗi response và giữ nó trong `AsyncLocalStorage`.
  - Đặt CSP và các security header cho **mọi** response đi qua entry, kể cả 500 khi env lỗi và 503.
  - Đặt `no-store` khi response chưa có `cache-control`.
  - Không đọc body. Giữ mọi `Set-Cookie`.
- **Nonce đến router**:
  - `router.tsx` đặt `ssr: { nonce }` qua `createIsomorphicFn`, lấy nonce từ ALS.
  - Thư viện tự gắn nonce cho `$_TSR`, các script stream, `Scripts`, `HeadContent`, `ScriptOnce` và script Suspense của React.
  - Client đọc lại nonce từ `meta[property=csp-nonce]`.
  - Không dùng hash hay `strict-dynamic`.
  - Không dùng `getGlobalStartContext`, vì hàm này throw khi chạy ngoài `runWithStartContext`, ví dụ trong `handleRedirectResponse`.
- **CSRF server fn**: giữ nguyên `createCsrfMiddleware`, vốn đã fail-closed. Run này chỉ thêm test wiring.
- **DEBT-360**: root `test` chạy với `--workspace-concurrency=1`. Gốc lỗi là quá tải CPU: 3 runner, mỗi runner khoảng 28 worker.

## Điểm mạnh
- Phần lớn nền tảng A7 đã có sẵn từ A4/A5:
  - `fea_sid`/`fea_tx` có `HttpOnly`, `SameSite=Lax`, và `Secure` + `__Host-` khi chạy https.
  - Logout chỉ nhận POST và kiểm same-origin.
  - CSRF server fn có E2E replay 7 biến thể.
  - Error boundary che lỗi (DEBT-275).
  - Theme được đọc phía server, nên không cần inline script (DEBT-266).
  - Đã có `check:bundle`.
- Start/router có sẵn đường đi nonce hoàn chỉnh. Chỉ thiếu phần sinh nonce, truyền nonce vào router, và header.

## Vấn đề (bắt buộc sửa — đã fold, không cần quay lại analyst)
- [x] Task 2 chưa nói nonce đi đường nào, và chưa nói CSP có áp cho trang lỗi, 503, 500 env lỗi hay không ⇒ F2 quy định wrapper ngoài cùng, ALS và `router.ssr.nonce`.
- [x] Task 2 chưa có tập directive cụ thể ⇒ F2 chốt chuỗi CSP chính xác:
  - `form-action` phải có origin của issuer, vì logout trả 303 sang `end_session` và Chrome áp `form-action` cho redirect.
  - `Referrer-Policy` phải là `same-origin`, không phải `no-referrer`, vì form POST sẽ mang `Origin: null`.
- [x] Thiếu ngữ nghĩa cache cho HTML chứa nonce ⇒ `no-store` khi response chưa có `cache-control` (đồng thời đóng DEBT-298).
- [x] Thiếu chính sách dev/prod ⇒ `script-src` giống nhau ở mọi môi trường. Nếu dev có vi phạm thì DỪNG và báo, không tự nới.
- [x] Task 3 "mọi cookie HttpOnly" là không khả thi cho `theme`/`sidebar_state` vì JS ghi các cookie này ⇒ chấp nhận có chủ đích: thêm `Secure` khi https và `SameSite=Lax` (sidebar hiện thiếu), không thêm HttpOnly.
- [x] Task 3 CSRF: cơ chế đã có ⇒ không đổi code. Thêm test unit wiring kèm mutation, cùng một case E2E `Sec-Fetch-Site: none`.
- [x] A7 "không log token/secret" chưa có hạng mục nào ⇒ F3 thêm ESLint `no-console` (trừ `errors.ts`) và test canary qua các nhánh lỗi.
- [x] Task 1 chưa chốt gốc lỗi ⇒ F1:
  - Đổi sang `--workspace-concurrency=1`.
  - `waitFor` ở router-lab.
  - Timeout riêng cho file check-bundle.
  - Cấm retry và cấm nâng timeout toàn cục.
- [x] Mỗi task đã có mutation bắt buộc và test âm đo được (F2/F3/F4, mục Cổng security).

## Trả lời
- **Q-51.1**: Nonce. Start 1.168.60 (router-core 1.171.34) đọc `router.options.ssr.nonce` cho mọi script SSR/stream và cho React stream; client đọc lại từ meta. Hash không khả thi vì payload thay đổi theo từng request. `strict-dynamic` không cần.
- **Q-51.2**: Đã có. Hành vi: `Sec-Fetch-Site` chỉ chấp nhận `same-origin`; nếu không có thì `Origin` phải bằng origin của request; nếu không có thì `Referer`; không có gì thì 403. Áp cho cả GET lẫn POST của `/_serverFn`. Logout có kiểm riêng. Chỉ cần thêm test.
- **Q-51.3**: Sửa gốc bằng cách cho root test chạy tuần tự từng package, cộng thêm 2 chỉnh test nhỏ. Không tách run.

## Đề xuất (không bắt buộc)
- DEBT-361: siết `style-src` (bỏ `'unsafe-inline'`, dùng nonce cho `<style>` và tách `style-src-attr`) khi Radix/sonner cho phép.
- DEBT-362: header bảo mật và cache cho asset tĩnh ở production, phụ thuộc adapter (DEBT-264).
- DEBT-363: Trusted Types (`require-trusted-types-for 'script'`) và báo cáo CSP (`report-to`). Ghi nhận thêm rằng meta `csp-nonce` hiển thị trong DOM theo thiết kế của router.

## Fold — audit (2026-10-24): PASS có điều kiện
Tester FAIL chỉ vì `pnpm audit --audit-level high` (2 advisory mới công bố, lockfile không đổi). Chi tiết thay đổi và verify: `tasks.md` mục "Fold tech-lead — audit (2026-10-24)".
- **zod 4.6.5 GHSA-mrhx-c7xc-m3w5 ⇒ bump 4.6.6 ngay**, kèm override `zod: 4.6.6`. Đây là ngoại lệ có ghi nhận cho quy tắc 14 ngày (bản 13 ngày tuổi, 0 dependency).
  - BE không bị ảnh hưởng qua mạng: zod chỉ dùng cho env/seed, DTO dùng class-validator.
  - fe-admin BFF có bị ảnh hưởng: `inputs.ts` validate `/_serverFn` bằng array `.max(N)`, không có giới hạn body, và header CSRF thì client ngoài trình duyệt giả được.
- **happy-dom 21.0.1 GHSA-834v-8h66-3h79 ⇒ `ignoreGhsas` tạm**, re-review/bump vào 2026-11-04. Gói chỉ dùng cho dev, không có đầu vào không tin cậy, và bản sửa mới 4 ngày tuổi.
- Điều kiện:
  - Diff lockfile chỉ đổi zod.
  - `pnpm audit --audit-level high` exit 0.
  - Test/build/`check:bundle` của be, fe-admin, fe-sso-test đều xanh.
- Debt: DEBT-369 (bump happy-dom + gỡ ignore + gỡ override zod), DEBT-370 (giới hạn body `/_serverFn` ở BFF).
- Ghi nhận quy trình: advisory high mới có thể làm đỏ CI dù lockfile không đổi. Cách hiện tại (ngoại lệ có ghi nhận cho bản sửa bảo mật, ignore có hạn cho dev-only) phù hợp với DEBT-228. Khi bật `minimumReleaseAge`, dùng `minimumReleaseAgeExclude` cho đúng bản sửa bảo mật.
