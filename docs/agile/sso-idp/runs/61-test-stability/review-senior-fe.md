# Senior Review (FE) — 2026-11-03
## Kết luận: PASS

Phạm vi: `git diff -- fe-admin/test/session-store.test.ts e2e/tests/lab.spec.ts` (T2 DEBT-450, T3 DEBT-432). Phần BE đã PASS ở `review-senior-be.md`, không review lại.

## Tổng quan
- T2 khớp fold từng ý: fixture JWT thật, phân biệt AT/IDT; bỏ `eyJ`; kiểm rõ/base64/base64url cho {AT, IDT, RT, cookie, từng phần JWT}; giải mã base64url mọi đoạn `[A-Za-z0-9_-]{16,}`; kiểm tập khoá + regex `tokens`. Assertion bảo mật KHÔNG bị nới: M1/M2/M3 đều bị bắt (M3 do tập khoá, M2 do nhánh giải mã, M1 do kiểm rõ).
- T3 là chờ có điều kiện đúng chỗ (`lab-replay-steps` chỉ render sau `setSteps` khi cả chuỗi xong), không `waitForTimeout`, không đổi `playwright.config`, retries 0.

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
- **Exposure (token at rest)**: blob Redis không chứa AT/RT/IDT/cookie ở dạng rõ, base64, base64url; không có đoạn base64url nào giải mã ra bí mật hoặc tên khoá ⇒ vẫn bắt lớp lỗi "chỉ base64, không mã hoá" mà `eyJ` cũ nhắm tới. Tập khoá cố định ⇒ không có field thừa lén lưu token.
- **Độ bền của regex 16 ký tự (câu hỏi điều phối)**: trên `raw` thật regex chỉ khớp đúng 3 đoạn (IV 16, ciphertext, tag 22); `email`/`sub`/tên khoá đều ngắn hoặc bị `@`/`.`/`"` cắt. Kim ngắn nhất khi giải mã là `"idToken"` (7 byte) trên ~470 byte ngẫu nhiên ⇒ P ≈ 470·2⁻⁵⁶ ≈ 7·10⁻¹⁵ mỗi lượt; kim rõ ngắn nhất là RT 19 ký tự (64⁻¹⁹). Không có nguy cơ flaky thực tế. Probe độc lập của reviewer (scratchpad, chỉ `node:crypto`, cùng fixture/AES-GCM/AAD, không chạm Redis): 100 000 mẫu ⇒ kiểm cũ dính 278 lần, kiểm mới 0, đúng 3 đoạn/lượt.
- **Fail-closed sau thu hồi họ RT (T3)**: xác nhận trong code, không chỉ tin log. `Lab.tsx:90` đọc `tokens.get()` mỗi lần render; bước 3 refresh bằng RT hậu duệ ⇒ `invalid_grant` ⇒ `refresh.ts:97` `tokens.clear()`; `setSteps`/`setBusy(false)` trong `finally` gây re-render ⇒ `session` null ⇒ nhánh `lab-replay-signin` thay cho `<button data-testid="lab-replay-run">` (`Lab.tsx:133-141`). Nút bị gỡ khỏi DOM là hành vi ĐÚNG (plan §11, `lab-replay-note`), nên `toBeEnabled()` của fold là sai, không phải dấu hiệu bug. Không có rủi ro kẹt `busy` (đã có `finally`). Hành vi clear đã có unit test `fe-sso-test/test/refresh.test.ts:80,115,130`.

## 🟡 Nên sửa
(không có)

## 💭 Nit
- `e2e/tests/lab.spec.ts:83` — thay chỗ `toBeEnabled()` đã bỏ, cân nhắc `await expect(page.getByTestId("lab-replay-signin")).toBeVisible()` (hoặc `expect(run).toHaveCount(0)`). Vì sao: chốt ở mức E2E đúng cái mà lệch fold dựa vào (UI bỏ session bị thu hồi). Nếu sau này client giữ token đã bị thu hồi thì test sẽ đỏ. Unit đã phủ phần này nên chỉ là nit.
- `fe-admin/test/session-store.test.ts:91` — regex `tokens` gắn cứng IV 12 byte / tag 16 byte. Đúng ý fold (kiểm cấu trúc), nhưng đổi định dạng blob sẽ phải sửa test. Chấp nhận được.
- Reviewer không chạy được `session-store.test.ts` vì `vg-test-redis@6479` đang tắt (theo ràng buộc, reviewer không khởi động container). Bù lại bằng probe offline ở trên. `pnpm -C fe-admin typecheck` 0, `lint` 0, `pnpm -C e2e typecheck` 0.

## DEBT-464 (E2E webServer /ready 120 s)
Hợp lệ, nhãn 💭 phù hợp: xảy ra 1 lần, ngay sau lượt chạy dưới tải; `playwright.config.ts:48` để `timeout: 120_000` cho chuỗi build → assert-dist-clean → sync-indexes → seed-dev → seed:e2e-admin → e2e-main. Hướng xử lý trong backlog (đo từng bước rồi mới tách hoặc nâng có số đo) đúng tinh thần "không tăng timeout mù quáng". Không mở debt mới.

## ✂️ Ponytail
- session-store.test.ts:L79-81: shrink: vòng rõ/base64/base64url chồng một phần với vòng giải mã (một secret base64url nằm thẳng hàng sẽ bị bắt ở cả hai). Giữ vì fold yêu cầu cả hai, và vòng rõ bắt được secret nằm lệch hàng mà vòng giải mã bỏ sót.
Lean already. Ship.
