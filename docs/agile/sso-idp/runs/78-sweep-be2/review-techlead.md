# Tech Lead Review — 2026-11-09 (run 78, sweep 🟡 BE đợt 2)

## Kết luận: PASS

Lô 6 task [BE] (fold chi tiết: `tasks.md` mục "Fold tech-lead"): T1 DEBT-139, T2 DEBT-155, T3 DEBT-150, T4 DEBT-198, T5 DEBT-254, T6 DEBT-256 (+ đóng DEBT-257 bằng runbook). Chuyển **backend-dev**.

## Kiến trúc đề xuất

Không đổi kiến trúc. Mọi sửa nằm trong module sẵn có, tái dùng hàm đã có (`revokeAllUserCredentials`, `FAMILY_ID`, `scrubUriCredentials`, `mongoTarget`), không abstraction mới ngoài 2 helper CLI nhỏ (`cliErrorText`, `isDryRun`) và 1 helper options cookie.

## Kiểm từng ứng viên trên code hiện tại (develop `e3af033`)

Không ứng viên nào đã được sửa gián tiếp — không đóng kèm debt nào ngoài DEBT-257 (gộp vào T6).

| Debt | Trạng thái code | Quyết định |
|---|---|---|
| 150 | `be/src/modules/ui/ui.controller.ts:353-375` vẫn tự gọi 3 bước, bước 1 ném ⇒ session không bị revoke | **Chọn T3** — đăng xuất mọi nơi không hoàn tất khi lỗi một phần (rủi ro bảo mật thật: session khác còn sống) |
| 254 | `sync-indexes.ts:110`, `seed.ts:295`, `seed-dev.ts:296` in `err.message` thô; `seed-dev` main không in `target:` | **Chọn T5** — có thể lộ credential Mongo ra log CI/terminal |
| 256 (+257) | 3 CLI kết nối và ghi ngay, không dry-run | **Chọn T6** — `sync-indexes` có thể drop index/đổi TTL audit sai đích; runbook §0 dùng 2 lần gõ biến |
| 198 | `federation.controller.ts:157-160` không gia hạn `idp_fed` khi `link_required` | **Chọn T4** — người dùng chậm mất pending link (đã đốt), sửa 1 chỗ |
| 155 | `admin-users.controller.ts:377-383` truyền `q.after` thẳng vào `$gt`; `listConsents` :429 đã kiểm | **Chọn T2** — đồng nhất hợp đồng input, rẻ |
| 139 | `refresh-token.service.ts:457` `{ new: false }` trên đường rotate | **Chọn T1** — 1 dòng, chặn rủi ro khi nâng Mongoose |
| 120 | Còn — nay `GET /login` peek tới 3 lần (`reauthRequested` :177, `socialLogins` :141, `loginFormActionOrigin` :190) | Hoãn: chỉ hiệu năng (1–2 GET Redis), refactor chạm CSP/social có rủi ro hồi quy > lợi ích. Ghi chú vào backlog |
| 121 | Còn (`authorize.service.ts:178` so `session.authTime` với `reauthAfter` từ `Date.now()` node khác) | Hoãn: chỉ fail-closed UX khi lệch đồng hồ > thời gian gõ đăng nhập; NTP đủ |
| 129 | Còn (audit lỗi sau rotate ⇒ 5xx, plaintext không trả) | Hoãn: an toàn (fail-closed), secret cũ còn grace 7 ngày, admin rotate lại là khôi phục |
| 134 | Còn (`client.service.ts:383` `after = {...before, ...set}`) | Hoãn: chỉ hiển thị `updatedAt` cũ; sửa đúng cần đọc lại sau ghi (race với audit diff) |
| 168 | Còn (`local-key-provider.ts:72`) | Hoãn: chỉ thiếu test, provider prod là Vault |
| 179 | Còn (`client.service.ts:250,311,475`) | Hoãn: bản ghi `{confidential,none}` không tạo được qua API (`isValidAuthMethodFor` :486), mọi chốt runtime đã từ chối — không phải lỗ |
| 182 | Còn (`federation.service.ts:372-401` bù trừ, không transaction) | Hoãn: cửa sổ = tiến trình chết giữa 3 insert; có đường tự cứu (quên mật khẩu ⇒ đặt mật khẩu ⇒ link). Replica set đã bắt buộc (SuperAdminGuard) nên làm được ở run sau. Ghi chú vào backlog |
| 188, 192, 193 | Còn | Hoãn: UX/giới hạn đã biết, không có RP/UI cần |

## Điểm mạnh

- Lô gom theo module: refresh-token (T1), admin-users (T2), ui (T3), federation (T4), CLI DB (T5–T6) — diff nhỏ, không chồng chéo.
- T3 tái dùng đúng hàm đã kiểm chứng ở admin lock/reset (DEBT-055) thay vì sửa logic song song.
- Mỗi task có ca RED đo được + mutation chỉ rõ test nào phải đỏ.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có. Lưu ý thực thi (bắt buộc làm đúng):
- [ ] T3 giữ nguyên nhánh `scope=session` và thứ tự audit → clear cookie → redirect; lỗi một phần vẫn 5xx (không báo đăng xuất thành công).
- [ ] T4 chỉ set lại binding với giá trị cookie request đã khớp state; không sinh giá trị mới; không set ở nhánh khác.
- [ ] T5/T6 không chạy CLI vào DB dev `sso-idp` (dùng `mongodb://127.0.0.1:1/x`).
- [ ] T6 ca CLI không được skip âm thầm khi thiếu `dist/`.

## Đề xuất (không bắt buộc)

- DEBT-521 (mới, backlog): logout global lỗi một phần không có audit failure — có thể truyền `onFailure` ghi `SESSION_REVOKED failure` + `failedStep` như admin.
- DEBT-182 làm ở run sau bằng transaction (replica set đã là điều kiện prod).
