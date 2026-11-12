# Tech Lead Review — 2026-11-11 (run 86, X6 release checklist đợt 2b, BE + UI + FE + QA)

## Kết luận: PASS

Fold chi tiết nằm ở `tasks.md`, mục "Fold tech-lead (2026-11-11)": phát hiện khi kiểm code, D86.1–D86.15, AC/RED/mutation/file/rủi ro cho từng task. Đã kiểm trên `develop` HEAD `e39b7b5`.

| Task | Nội dung | P | Lane |
|---|---|---|---|
| T5 | CSP `base-uri 'none'` (helmet + `csp.ts`); `networkOf` dùng `ipaddr.js`, key bucket giữ nguyên byte (DEBT-583/599) | P2 | [BE] backend-dev |
| T1 | Token một lần chuyển sang fragment + một field mã, thư in mã (DEBT-577) | **P0** | [BE+UI] backend-dev |
| T4 | POST `/logout` không có `_csrf` ⇒ trang xác nhận; CSRF hai identity cho logout (DEBT-572) | P1 | [BE] backend-dev |
| T2 | Pre-publish key: `pending`/`activatesAt`, 409, Local + Vault, Admin API/OpenAPI (DEBT-393) | P1 | [BE] backend-dev |
| T3 | fe-admin hiển thị pending, 409, uncertain theo tập kid, dashboard (DEBT-393) | P1 | [FE] frontend-dev |
| T6 | Checklist (P0 ❌ = 0), security-matrix, spec tester, gate | — | [QA] tester |

**Vừa một run.** Thứ tự: T5 → T1 → T4 → T2 → T3 → T6.
- T5 đi đầu vì rẻ và độc lập.
- T1 và T4 cùng sửa `ui.controller.ts` ⇒ làm tuần tự.
- T3 bắt đầu ở mốc T2 bước 6 (DTO + OpenAPI + `schema.d.ts`), sau T2 như yêu cầu.
- Nếu trễ: T1/T4/T5 phải xong. T2 và T3 dời **cùng nhau** sang run 87, vì BE gửi `pending` thì fe-admin cũ lỗi schema.

## Kiến trúc đề xuất

Không đổi kiến trúc, không thêm dependency (`ipaddr.js` đã là dependency trực tiếp của `be`). Trạng thái key suy ra theo thời gian, không có job nền (D85.7 giữ nguyên). Có ba điều chỉnh so với chữ của D85.3/D85.7/DEBT-572, đều xuất phát từ code thật:

1. **D86.1 — một field mã, không `<noscript>`.** Theo chữ D85.3 thì khi tắt JS có hai field `token` ⇒ body thành mảng ⇒ `@IsString()` trả 400. Một field hiện sẵn, script điền giá trị rồi ẩn đi là đủ cho cả hai trường hợp có và không có JS.
2. **D86.6 — CSRF hai identity cho `POST /logout`.** Trang xác nhận render từ POST cross-site không thấy cookie phiên `Lax`, nên token gắn với cookie ẩn danh. Lúc bấm "Sign out", `CsrfGuard` so với cookie phiên ⇒ 403. Làm đúng chữ DEBT-572 vẫn hỏng ở topology cross-site của X3. Chấp nhận HMAC của cookie phiên **hoặc** cookie ẩn danh. Kẻ tấn công không đọc được cookie nào và không có secret. Chỉ áp cho logout.
3. **D86.8 — 409 dùng `error: "conflict"`, không dùng `rotation_pending`.** BFF fe-admin chỉ map `409 conflict`. Một mã mới sẽ bị xem là "kết quả không rõ", tức đúng lỗi mà D85.7 muốn tránh. `rotation_pending` vẫn có ở audit và OpenAPI.

## Điểm mạnh

- Hướng của D85.3/D85.7 đúng và khả thi trên code hiện có:
  - Đã có tiền lệ script ngoài (`logout-redirect.js`), nên CSP không phải đổi.
  - Vault đã gửi `key_version` và rotate normal không nâng `min_encryption_version` ⇒ ký bằng version cũ hơn latest chạy được ngay.
  - JWKS `no-cache` (D84.2) giúp RP thấy key pending ngay.
- Có sẵn test byte-identity cho CSP, nên T5 tự được kiểm.
- Mặc định `KEY_PREPUBLISH_SEC=0` trong test giữ 25 lời gọi rotate và 27 chỗ khởi tạo `LocalKeyProvider` mà không phải sửa.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các điểm dev **bắt buộc** làm theo fold (đã ghi ở AC):

- [ ] Local: không xoá PEM của key active lúc rotate normal (nó còn ký tới `activatesAt`), nếu không sẽ `ENOENT` khi ký (T2 AC8).
- [ ] Vault: `signOnce` retry phải so version **active**, không so `latest` (T2).
- [ ] 409 kiểm trong mutex của Local (T2 AC5).
- [ ] fe-admin: `uncertainText` của rotate normal so **tập kid**, không so kid active (T3 AC6), nếu không admin sẽ rotate lại.
- [ ] `networkOf` dùng `toFixedLengthString()` 4 nhóm, không dùng `toNormalizedString()`, để key Redis không đổi (T5).
- [ ] Helper `tokenFromMailLink` thay 9 chỗ `searchParams.get('token')` trong int (T1).
- [ ] E2E `KEY_PREPUBLISH_SEC=20` và chờ hết pending lúc bắt đầu. `e2e/.keys` tồn tại giữa các lần chạy; nếu dùng 3600 thì lần chạy sau trong 1 h sẽ ăn 409 (D86.12).

## Đề xuất (không bắt buộc)

- DEBT-602: Local giữ PEM của key đã retiring tới lần rotate kế tiếp (chỉ dev). Có thể dọn trong `init` khi đã chắc chắn retiring.
- DEBT-603: Vault, hai instance rotate normal đồng thời có thể tạo hai version pending (vô hại). Nếu cần chặt, dùng CAS bằng `latest_version` đọc lại sau rotate.
- DEBT-604: trình duyệt có thể ghi URL có fragment vào lịch sử trước `replaceState`. Theo dõi khi pentest (run 88); token một lần, TTL 30'.

## Ghi chú deploy (orchestrator chép vào summary/STATUS)

- BE và fe-admin deploy cùng một bản (schema `pending`/`activatesAt`).
- Link verify/reset phát trước deploy (`?token=`) không tự điền ⇒ người dùng xin link mới.
- Vault: tránh deploy trong `KEY_PREPUBLISH_SEC` sau một lần rotate normal. Version vừa xoay sẽ thành pending trở lại và IdP ký bằng version trước; vô hại nhưng gây bất ngờ.
- `KEY_PREPUBLISH_SEC ≥ 600` ở production (runbook-ops §1).
- `POST /logout` từ RP giờ trả 200 trang xác nhận thay vì 403.
