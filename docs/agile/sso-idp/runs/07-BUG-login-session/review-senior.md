# Senior Review — 2026-09-30
## Kết luận: PASS

## Tổng quan

Blocker stale CSRF đã được sửa đúng phạm vi: sau khi clear session cookie, controller loại `idp_session` stale khỏi request trước khi tạo form, nên `/login` và `/register` phát anonymous CSRF cookie/token nhất quán với POST kế tiếp. Ma trận absent/live/stale, fail-closed khi lookup lỗi, clear-cookie options, không revoke, chống redirect loop và các route ngoài phạm vi đều giữ nguyên. Test hồi quy mới mô phỏng trình duyệt áp dụng `Set-Cookie`, rồi submit cả hai form và xác nhận không còn 403.

## 🔴 Blocker

- Không có.

## 🟡 Nên sửa

- Không có.

## 💭 Nit

- Không có.

## ✂️ Ponytail

Lean already. Ship.

## Kiểm chứng

- CodeGraph 1.5.0 sync thành công; diagnostics ba file thay đổi không có lỗi.
- Focused `test/ui.int-spec.ts`: PASS 38/38, gồm stale GET `/login` và `/register` → anonymous CSRF cookie → POST thành công.
- Focused UI + Redis thật: PASS 41/41; toàn bộ unit PASS 48/48; toàn bộ integration PASS 91/91.
- Lint, typecheck và build PASS; review tĩnh xác nhận lookup error propagate 5xx, stale clear đúng một lần, không gọi `revoke()`, và redirect stale `/` kết thúc `302 → 200`.