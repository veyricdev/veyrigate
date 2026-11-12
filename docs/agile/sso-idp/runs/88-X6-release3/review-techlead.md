# Tech Lead Review — 2026-11-12

Phạm vi: fold run 88 (ứng viên T1–T6 của orchestrator) trên `develop` HEAD `6e68a1f`. Đã đọc `STATUS.md`, `release-checklist.md` (D-16, C-7.5.2, C-10.7b, C-6.3.3, D-14, mục F, C-6.4b/C-6.5/C-7.5.1/C-10.7a), backlog DEBT-164/165/334/579/581/582/586/604, `plan.md` §12 (Q1–Q9, D84–D87), `spec.md` §4/§6.1/§9.4/§9.6/§9.8/§9.11/§10/§15, và code qua CodeGraph + đọc đích (`session.service.ts`, `login-throttle.service.ts`, `authentication.service.ts`, `ui.controller.ts`, `consent.service.ts`, `admin-users.controller.ts`, `seed.ts`, `admin-recover.ts`, `tenant-context.ts`, `token.service.ts`, `client-credential.service.ts`, `super-admin-guard.ts`, `validation.schema.ts`).

## Kết luận: PASS

Với điều kiện chia lô D88.1: run 88 = T1 bootstrap + T2 trang phiên + T3 consent + T4 gate; MFA sang run 89; pentest + ký F sang run 90. Mọi điểm mở đã chốt thành D88.2–D88.30 trong `tasks.md` (người dùng ủy quyền, tiêu chí production).

## Kiến trúc đề xuất (nếu cần điều chỉnh)

- Giữ **modular monolith** NestJS hiện tại; không thêm service, container hay dependency. Ba việc run 88 là trang BE render (Q2/D1) trong `UiModule` (khuyến nghị tách `account.controller.ts`) cộng một CLI ops cạnh `admin-recover`.
- **Bootstrap** chống chạy song song bằng **transaction Mongo + touch document** (cùng mẫu `SuperAdminGuard`), không dùng lock lease: ít trạng thái hơn, không phụ thuộc đồng hồ, và production đã bắt buộc replica set.
- **Trang phiên** dùng lại trình tự huỷ của local logout qua một helper chung (family → phiên + tombstone → sweep), không chép logic thứ hai.
- **MFA** (run 89) bắt buộc theo **resource `admin` lúc cấp/đổi code**, không theo vai trò ở `AdminTokenGuard`: AT admin không mang `amr` và refresh family không lưu `amr`, nên chặn ở nguồn là điểm duy nhất đúng mà không cần đổi contract token. Secret TOTP mã hoá AES-256-GCM bằng khoá ở env (backup Mongo lộ không lộ seed).

## Điểm mạnh

- Nền đã có cho cả ba việc: `listByUser`/`revokeByDevice` kiểm chủ sở hữu, tombstone `sess_end`, `revokeForSession`/`revokeForConsent`, before-image idempotent của consent (DEBT-151), mẫu CLI `admin-recover` (dry-run, allowlist tham số, audit trong transaction, smoke trong image).
- Danh mục ứng viên đúng các ❌ P1 còn lại; thứ tự pentest + ký cuối cùng là đúng.
- Ràng buộc hạ tầng rõ (không container mới, DB/Redis db riêng); pentest D88.30 tuân thủ (Mongo `vg-pentest`, Redis `/7`, không tải công cụ).

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các lệch giữa ứng viên và code đã được sửa ngay trong fold (ghi lại để dev không đi theo mô tả cũ):

- [x] Ứng viên gộp 6 việc vào một run — quá lớn (MFA một mình chạm login, federation, `/authorize`, `/token`, admin API, fe-admin, E2E) ⇒ chia 88/89/90 (D88.1).
- [x] `revokeByDevice` sẵn có **không** thu hồi refresh family gắn `sessionRef` ⇒ trang phiên phải theo trình tự 3 bước của local logout (D88.19, T2 AC2/AC7).
- [x] ASVS 7.5.2 L2 đòi **xác thực lại** trước khi huỷ phiên — ứng viên không nêu ⇒ D88.18 (cửa sổ 5' hoặc mật khẩu hiện tại qua bucket sẵn có).
- [x] Phiên không có nhãn thiết bị (controller không truyền `deviceLabel`) ⇒ D88.17 (allowlist từ UA, không lưu UA thô).
- [x] `ADMIN_SEED_EMAIL` bắt buộc trong `envSchema` làm env production phải chứa email vô nghĩa mà CLI production lại dùng `validateEnv` ⇒ gộp DEBT-165 vào T1 (D88.13).
- [x] "Khoá chống chạy song song" mơ hồ; `createSecret` hiện cấp được 2 version song song ⇒ D88.6 (transaction + touch, secret in sau commit) + AC3 lặp 20 lần có barrier.
- [x] Mất secret lần đầu / domain sai lần đầu là ngõ cụt (console cần chính client đó) ⇒ `--rotate-secret`, `--update-uris` có `--ticket` + audit (D88.8/D88.9).

## Đề xuất (không bắt buộc)

- Khi đóng run, orchestrator chép D88.1–D88.30 vào `plan.md` §12 và cập nhật `spec.md` §4 ("MFA-ready" ⇒ phạm vi D88.23–D88.24 sẽ làm ở run 89) cùng §11 (route `/account/*`).
- Backlog mới (đã thêm vào `backlog.md`): DEBT-622 xác thực lại cho tài khoản chỉ federation trên `/account/*`; DEBT-623 `displayName` client trên màn consent; DEBT-624 WebAuthn/passkey; DEBT-625 QR cho enroll TOTP; DEBT-626 `acr`/`acr_values` theo MFA.
- Run 89 nên fold lại trên code sau run 88 (không dùng nguyên outline): kiểm số int fixture mint code admin trực tiếp trước khi chọn cách bật `ADMIN_MFA_REQUIRED` trong test.
