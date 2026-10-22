# Tech Lead Review — 2026-10-21

## Kết luận: PASS

PASS kèm fold bắt buộc trong `tasks.md` (mục "Fold tech-lead", ưu tiên hơn text cũ). Không có blocker: các lỗi của tasks gốc đều sửa được bằng fold, không cần analyst viết lại.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

- Giữ một app TanStack Start trong `fe-admin/` (BFF theo D2/Q3), không tách service.
- **Dựng tay, không dùng TanStack CLI** (F0). CLI `@tanstack/cli` 0.71.1/0.72.0 vẫn 0.x, registry không có README nên không xác minh được flag cho chế độ không tương tác. CLI sinh range `^`/bản mới nhất (trái quy tắc ≥14 ngày), sinh demo, có thể tự `git init`/install trong repo. Dựng tay vài file (vite config, router, `__root`, index) ít rủi ro hơn và cho lockfile tất định.
- Server env tách ở `src/server/env.ts`. Validate lúc runtime (server khởi động), không lúc build. Chưa có client env vì chưa có biến `VITE_*` nào.
- Query/Form/Table hoãn tới lần dùng đầu (A5/A6) để giảm bề mặt phụ thuộc và audit.

## Phiên bản chốt (Q-41.1)

Tra registry npm chỉ-đọc ngày 2026-10-21, mốc ≤ 2026-10-07. Ngoại lệ: được dùng bản đã có sẵn trong `pnpm-lock.yaml` ở `c35174d` (không thêm tarball mới).

| Package | Bản | Ngày phát hành / lý do |
|---|---|---|
| @tanstack/react-start | 1.168.60 | 2026-09-30 (latest 1.169.3 là 10-16, quá mới) |
| @tanstack/react-router | 1.170.41 | 2026-09-30, khớp đúng dep của Start 1.168.60 |
| react / react-dom | 19.3.0 | 2026-09-09, đã có trong lockfile |
| @t3-oss/env-core | 0.13.11 | 2026-03-22, peer zod ^4 |
| zod | 4.6.5 | đã có trong lockfile |
| tailwindcss / @tailwindcss/vite | 4.3.3 | 2026-07-16 (`@tailwindcss/oxide` đã có trong allowBuilds) |
| shadcn (chỉ qua dlx) | 4.21.3 | 2026-10-06 |
| radix-ui | 1.7.0 | 2026-10-05 |
| class-variance-authority / clsx / tailwind-merge | 0.7.1 / 2.1.1 / 3.7.0 | cũ, ổn định |
| lucide-react / tw-animate-css / sonner | 1.52.0 / 1.4.0 / 2.0.8 | ≤ 10-04 |
| vite | 8.3.4 | trùng lockfile (fe-sso-test). Bản 14 ngày nghiêm là 8.3.3 |
| vitest | 5.0.4 | trùng lockfile. Bản 14 ngày nghiêm là 5.0.3 |
| @vitejs/plugin-react | 6.1.2 | 2026-10-05, trùng lockfile |
| happy-dom | 21.0.1 | trùng lockfile |
| typescript | 5.7.3 | trùng lockfile |
| @testing-library/react / user-event | 16.3.3 / 14.6.7 | ≤ 09-02 |
| (hoãn) @tanstack/react-query / react-form / react-table | 5.104.1 / 1.33.5 / 9.2.6 | ứng viên, chốt lại ở A5/A6 |
| (không dùng) @tanstack/cli | 0.71.1 | chỉ ghi để tham chiếu |

Tương thích đã kiểm qua manifest: Start 1.168.60 peer `vite >=7`, engines `node >=22.12` (repo 22.23.2). Vitest 5.0.x peer vite ^8. plugin-react 6.1.2 peer vite ^8. @tailwindcss/vite peer vite ^8.

## Điểm mạnh

- Phạm vi A1–A3 tách khỏi A4 (auth) đúng: run này không chạm luồng token.
- Đã nhắc pin phiên bản, audit gate và cổng :3000 khớp redirect đã seed.
- Workspace sẵn sàng: `pnpm -r --if-present` và job `quality` tự gom package mới, không cần job CI mới.

## Vấn đề (đã fold vào tasks.md, dev bắt buộc làm theo)

- [x] Task 1 chỉ định scaffold bằng CLI `@latest`, trái ràng buộc pin/≥14 ngày và dễ sinh nhiều thứ thừa ⇒ F0 dựng tay, F1 bảng pin.
- [x] Task 2 yêu cầu "thiếu biến ⇒ **build** lỗi": build sẽ cần secret thật/giả ở CI, trái mục đích. Đổi thành validate lúc runtime và chặn render.
- [x] Task 2 dùng tên `ADMIN_API_BASE` lệch plan §1.4 (`ADMIN_API_BASE_URL`, thiếu `ADMIN_API_RESOURCE`, `APP_URL`) ⇒ sửa schema đủ 7 biến kèm ràng buộc (URL, ≥32, https ở production).
- [x] Một file `env` dùng chung server+client sẽ đưa tên biến server vào bundle ⇒ chỉ có server env dưới `src/server/**`, thêm `check:bundle` + test canary.
- [x] Exposure: thông báo lỗi validate không được in giá trị; error page production không render `error.message`/stack; `.env.example` để rỗng secret.
- [x] `routeTree.gen.ts` phải được commit, vì CI chạy typecheck trước build.
- [x] Dark mode: không dùng `next-themes` hay inline script (giữ CSP cho A7) ⇒ dùng cookie và đọc phía server.
- [x] Acceptance a11y "cơ bản" mơ hồ ⇒ thay bằng các case đo được (skip-link, aria-current, aria-label, 404, error canary).

Cổng security design: run này chỉ chạm trust boundary ở mức xử lý secret (env). Tài sản là `OIDC_CLIENT_SECRET`/`SESSION_SECRET`; ranh giới là bundle client, log và HTTP response. Exposure rules và test âm (canary trong bundle/log/error page) đã fold. Authn/authz, session, replay thuộc A4, sẽ review ở run 42.

## Đề xuất (không bắt buộc)

- DEBT-264: chọn adapter deploy production cho Start (output build mặc định chưa phải node server hoàn chỉnh), làm ở A7/X6.
- DEBT-265: A4 chốt nơi lưu session (cookie stateless có giới hạn ~4KB và không thu hồi được phía server; Redis opaque-ID).
- DEBT-266: theme/FOUC phải tương thích CSP nghiêm ở A7.
- DEBT-267: lockfile đang có bản < 14 ngày lúc pin (vite 8.3.4, vitest 5.0.4, happy-dom 21.0.1). Khi bật `minimumReleaseAge` (DEBT-228) cần kiểm `--frozen-lockfile` và tự động hoá kiểm tuổi transitive.
- DEBT-268: cập nhật plan §1.5/A1 (bỏ lệnh CLI `@latest`, dời Query/Form/Table sang A5/A6).
