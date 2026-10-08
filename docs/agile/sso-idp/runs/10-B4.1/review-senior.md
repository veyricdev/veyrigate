# Senior Review (re-review lần 3) — 2026-10-07 — Run 10 — B4.1 (`/authorize`)

## Kết luận: PASS

## Tổng quan

Dev đã sửa đúng blocker DEBT-024 (resume Phase 2 fail → 500) bằng Cách B: `AuthorizeRedirectError`
nay tự mang `redirectUri?`/`state?`, gắn trong `catch` của `AuthorizeService.handle()` ngay tại
điểm `redirect_uri` đã trusted (Phase 1 xong), trước khi rethrow. `AuthorizeController.buildErrorRedirect(err)`
đọc `redirectUri`/`state` từ error, không còn đọc `params` của request HTTP hiện tại — nhánh fresh
và nhánh resume dùng chung đúng một đường, loại hẳn giả định sai "params luôn có redirect_uri".

Đã verify **bằng HTTP thật** (không chỉ tin test): `pnpm start:dev` + Mongo/Redis dev thật (27017/
6379), chèn trực tiếp 1 client (`review-http`, `scopes:['openid','profile']`) vào Mongo (chưa có
API tạo client qua HTTP ở B4.1, đúng như vòng review trước) → register → verify-email qua Mailpit
→ fresh `/authorize` (chưa login, scope `openid profile` hợp lệ) → 302 `/login` kèm `request_id`
→ **thu hẹp `client.scopes` xuống `['profile']` trong Mongo** (giả lập đúng kịch bản lần trước) →
login → follow redirect resume `/authorize?request_id=...` → kết quả:

```
HTTP/1.1 302 Found
location: https://app.example.com/callback?error=invalid_scope&error_description=Scope+not+allowed+for+this+client%3A+openid&state=rp-state-xyz&iss=http%3A%2F%2Flocalhost%3A4000
```

**302 redirect đúng hợp đồng OAuth error, không còn 500.** `error=invalid_scope`, `state` echo
đúng (`rp-state-xyz`), `iss` đúng issuer (RFC 9207) — khớp chính xác bằng chứng blocker cũ (lúc đó
log server in `TypeError: Invalid URL`, không có header `Location`). Replay cùng `request_id` sau
đó → 400 "Request expired" (single-use vẫn đúng, không bị ảnh hưởng bởi fix).

Soát code: toàn bộ 14 điểm `throw new AuthorizeRedirectError(...)`/`AuthorizeErrorPage(...)` trong
`authorize.service.ts` đều nằm trong (hoặc được gọi từ trong) `try` block của `handle()` (dòng
136–188), kể cả các helper riêng (`validateScope`, `resolveResource`, `parsePrompt`, `parseMaxAge`)
— không có đường nào throw `AuthorizeRedirectError` lọt ra ngoài catch gắn `redirectUri`/`state`.
Không tìm thấy construction site nào khác của 2 lớp lỗi này ngoài `authorize.service.ts`. Không
phát hiện lỗ hổng mới do cách sửa này tạo ra.

## 🔴 Blocker

(không còn — DEBT-024 đã đóng, đã verify lại bằng HTTP thật, không phải chỉ tin lời khai báo)

## Security invariants / trust boundaries đã kiểm

- **Resume Phase 2 fail (blocker DEBT-024, vòng trước)**: xác nhận ĐÃ SỬA bằng HTTP thật (xem
  Tổng quan) — 302 redirect đúng hợp đồng, không còn 500. Test HTTP-level mới
  (`authorize.int-spec.ts`, case `resume whose Phase 2 fails (scope narrowed after context
  creation) => 302 redirect with error/state/iss, never a 500`) đọc đúng: tạo context fresh →
  sửa `scopes` qua model Mongo trực tiếp → login → resume → assert `302` + `error=invalid_scope`
  + `state` + `iss`. Không giả, khớp đúng kịch bản tái tạo bằng tay.
- **Resume sau login (blocker vòng 2 trước đó)**: vẫn đúng — register→verify→login→resume →
  200 "Authorization request accepted" khi Phase 2 không lỗi gì.
- **Single-use (C3/C8)**: xác nhận lại bằng HTTP thật — replay cùng `request_id` đã dùng (dù lần
  dùng trước đó kết thúc bằng lỗi redirect, không phải 200) → 400 "Request expired", không redirect
  lần hai. `request_id` không tồn tại cũng 400. Lua GET+DEL atomic giữ nguyên.
- **Open-redirect (INV-3)**: xác nhận lại bằng HTTP thật — `client_id` lạ (`unknown-attacker`,
  `redirect_uri` trỏ `evil.example.com`) → 400 HTML, **không có header `Location`** trong response
  (curl -i xác nhận không có `location:`).
- **PKCE S256**: `code_challenge_method=plain` ở **nhánh fresh** (chưa login) → 302 kèm
  `error=invalid_request`, `state`/`iss` đúng — xác nhận qua `curl -i` thật, không chỉ test.
- **Regression C1–C8**: lint/typecheck/unit/int chạy lại từ đầu trên máy review (không chỉ tin số
  liệu dev khai báo) — unit 67/67 PASS, int 164/164 PASS (11 suite), authorize suite riêng 25/25
  PASS (liệt kê đủ tên test bằng `--verbose`, gồm cả 5 test HTTP-level thêm ở vòng trước + 1 test
  mới vòng này). Không có suite nào bị skip/treo.
- **DB thật vs test DB**: verify HTTP dùng Mongo/Redis dev thật (27017/6379, KHÔNG phải cổng test
  27117/6479) để tránh lẫn với dữ liệu int-spec; đã dọn client/user review khỏi Mongo dev sau khi
  xong (xem Vệ sinh).

## 🟡 Nên sửa

- (không có mới ở vòng này — DEBT-022 giữ nguyên trạng thái mở, đúng như quyết định tech-lead/vòng
  trước: xử lý ở B4.2+ khi chạm lại `AuthorizeController`/`UiController`, không bắt buộc ở lần sửa
  blocker DEBT-024 này.)

## 💭 Nit

- `be/src/modules/oauth/authorize/authorize.errors.ts` — docstring cập nhật giải thích đúng lý do
  `redirectUri`/`state` chuyển sang nằm trên error thay vì đọc từ `params`; rõ ràng, không cần sửa.

## ✂️ Ponytail

- Không phát hiện thêm so với vòng trước; `authorize.controller.ts:L9-19` (`AuthorizeRequest`/
  `AuthorizeReply` trùng `UiRequest`/`UiReply`) vẫn còn nhưng đã nằm trong DEBT-022, không lặp lại
  ở đây để tránh double-count.

Lean already (so với vòng review trước, fix chỉ thêm field optional + 1 catch wrap + đọc từ error
thay vì params — không phình thêm trừu tượng). Ship.
