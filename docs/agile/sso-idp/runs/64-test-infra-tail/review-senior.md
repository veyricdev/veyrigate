# Senior Review — 2026-11-03
## Kết luận: PASS

## Tổng quan
Diff nhỏ, đúng fold tech-lead: 2 config CJS cạnh `jest.int.config.js`, script chỉ còn `--config … --runInBand --forceExit`; guard DEBT-471 đặt đúng chỗ (dòng đầu `intPreflight()`, trước probe và `acquireLock()`), fail-closed, chỉ in tên DB; `full-app.ts` bỏ 2 điều kiện `!TEST_MONGO_URI` ⇒ một ngữ nghĩa drop. Bằng chứng dev đủ mạnh (drill âm + mutation tắt guard ⇒ DB drill bị xoá + drill dương consent/security-headers + int full 1420/1420 +0 DB).

Kiểm lại độc lập (không chạy int): `test:vault run54 --listTests` = 1 file `run54-tester.vault-spec.ts`; vault không lọc = 5 (khớp 5 `*.vault-spec.ts` tracked); sentinel = 1; vault `--testTimeout=5000 --showConfig` ⇒ scalar 5000, setup `vault-preflight.mjs`, teardown `int-teardown.mjs`; sentinel `testTimeout` 60000. `vault-preflight.mjs:39` gọi `await intPreflight()` ⇒ guard phủ `test:vault`.

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
- Invariant: không spec int nào drop DB tên khác `vg-int-*` khi `TEST_MONGO_URI` đặt. Chặn ở globalSetup (process cha, trước mọi spec) ⇒ phủ cả ~45 drop trực tiếp + `full-app` + `test:vault`. `test:sentinel` không dùng Mongo.
- Regex tách tên DB (chạy thử): nhiều host + query `u:p@a:1,b:2/vg-int-y?replicaSet=x` ⇒ `vg-int-y` ✓; `mongodb+srv://h/vg-int-z` ✓; `/sso-idp` ✗; không path / `/?x=1` / `h?x=/vg-int-a` / `MONGODB://` / khoảng trắng đầu ⇒ `""` ✗; `#frag` cắt đúng; `%41` decode. `%` hỏng ⇒ `decodeURIComponent` ném ⇒ globalSetup ném = fail-closed.
- Exposure: thông điệp chỉ in `db`, không in URI/credential.
- Lock: guard ném trước `acquireLock()` ⇒ không giữ `vg:int-lock` (dev đo `vg:int-lock` 0).
- `full-app.ts:70/181`: drop vô điều kiện giờ an toàn vì override đã bị giới hạn ở `vg-int-*` (đúng ý: DB người dùng chỉ định phải là DB dùng-một-lần).

## 🟡 Nên sửa
- [ ] `be/jest.vault.config.js:6` và `be/jest.sentinel.config.js:6` — `testRegex: '\.vault-spec\.ts$'` trong chuỗi JS nháy đơn: `\.` là escape thừa ⇒ chuỗi thực là `.vault-spec.ts$` (`--showConfig` in `".vault-spec.ts$"`), dấu chấm thành "ký tự bất kỳ". Vì sao: lệch fold (`'\\.vault-spec\\.ts$'`), lệch `jest.int.config.js` (`'\\.int-spec\\.ts$'`) và lệch script cũ (regex thực `\.vault-spec\.ts$`); hôm nay vô hại (listTests 5/1 đúng) nhưng file kiểu `foo-vault-spec.ts` sẽ bị kéo vào dưới preflight Vault. Đề xuất: đổi thành `'\\.vault-spec\\.ts$'` / `'\\.sentinel-spec\\.ts$'` (hai backslash). → DEBT-476.

## 💭 Nit
- `int-preflight.mjs` guard: với URI bất hợp lệ có `/` chưa encode trong password (`mongodb://u:pa/ss@h/db`), phần sau `/` (gồm đuôi password) bị in trong lỗi. URI như vậy driver cũng từ chối; không đáng sửa, ghi để biết.
- Backlog DEBT-203: ghi chú là "Run 64 tech-lead" — trung thực (đúng nội dung fold), không đóng là đúng.

## ✂️ Ponytail
- be/jest.sentinel.config.js:L1-2: shrink: chú thích 2 dòng gần trùng `jest.vault.config.js`. Có thể 1 dòng "see jest.int.config.js (DEBT-470)".
net: -1 lines possible. Gần như lean; 2 file config là lựa chọn đúng (không gộp theo env).
