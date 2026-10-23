# Senior Review — 2026-10-23
## Kết luận: PASS

Phạm vi: diff chưa commit so với `c8216f3` (Task 0 BE, Task 1–4 FE/E2E, DEBT-346/347/348). Bỏ qua `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`. Đọc code qua CodeGraph + diff. Chạy lại: fe-admin `typecheck` 0 lỗi; vitest `keys-ui`, `signing-keys-fn`, `audit-ui`, `audit-ui-risk`, `admin-schema-types` 5 file / 72 passed; BE `pnpm -C be test -- admin.spec.ts` 29 passed. Không chạy E2E.

## Tổng quan (ấn tượng chung + điểm tốt)
- Bám sát fold F0–F4. Cảnh báo khẩn cấp có đúng 5 ý của Q-49.1 cộng câu về phiên console. Không có câu sai sự thật (test âm bằng regex chặn "mọi người dùng bị đăng xuất", "RT bị thu hồi", "15 min").
- Phòng thủ nhiều lớp với key material:
  - BE controller map allowlist 5 field. Test Task 0 cho provider trả kèm `n/e/d/pem/path` rồi so khoá output với khoá schema.
  - BFF dùng `z.object` strip; test fake BE trả thêm `privateKey`, `d`… và xác nhận chúng bị bỏ.
  - E2E đọc JWKS công khai, xác nhận không có `d/p/q/dp/dq/qi`; trang không chứa `eyJ`/`BEGIN`.
- `ConfirmAction.confirmText` là prop tuỳ chọn, gọn:
  - Không truyền ⇒ `blocked = false` ⇒ caller cũ giữ nguyên hành vi.
  - Cổng chặn ở hai chỗ: nút `disabled` và kiểm lại trong `confirm()`.
  - Chữ đã gõ bị xoá khi đóng, Cancel hoặc xong việc.
  - Nhập không nằm trong `<form>` ⇒ Enter không submit được.
  - `busy` ref ⇒ double-click chỉ gửi một lần; có test.
- Rotate không idempotent nên được xử lý đúng:
  - `mutations.retry: 0` toàn cục; `call` không retry.
  - Kết quả uncertain hoặc lỗi throw ⇒ đóng dialog, announce, invalidate list, không gửi lại.
  - Có test cho cả hai nhánh, đều assert `rotate` được gọi đúng 1 lần.
- Mutation testing có ghi chép, khôi phục kiểm bằng sha256. E2E context B kèm mutation bỏ `cooldownDuration: 0` ⇒ RED (`JWKSNoMatchingKey`). Đây là bằng chứng tốt cho một thay đổi auth tưởng như nhỏ.

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
- **Exposure (key material)**: kiểm cả ba tầng.
  - BE: controller allowlist; `AdminKeyViewDto implements KeyMetadata` chỉ thêm metadata OpenAPI, không đổi runtime.
  - BFF: `SigningKeySchema`/`RotateKeyResultSchema` là `z.object` strip, không có `.passthrough()`. Mutation `.passthrough()` ⇒ RED.
  - Trình duyệt: chỉ nhận `kid/alg/status/createdAt/retireAt` và `newKid/oldKid/mode`.
  - URL không mang tham số. kid độc hại (`<img onerror>`) hiển thị dạng text (test).
- **Authorization**:
  - FE gate chỉ là UX. Non-super_admin thì `Keys` không mount ⇒ 0 lần gọi server fn (test).
  - Server fn không tự kiểm role. Bảo vệ thật nằm ở BE: `AdminTokenGuard` + scope + `RequireRecentAuth(5)` + `assertSuperAdmin`. Không có id đầu vào ⇒ không có bề mặt IDOR.
  - Input `RotateKeyInput.strict()`, `mode` là enum ⇒ field lạ hoặc `EMERGENCY` sai hoa thường bị từ chối, 0 request (test + mutation).
- **`cooldownDuration: 0` (rủi ro DoS JWKS)**: đã truy mọi đường gọi verifier qua `getAuth().jwks` → `policy.jwks` → `verifyIdToken`. Chỉ có 2 chỗ:
  - `bff.ts:185`: callback, ID token lấy từ `exchangeCode` (back-channel `/token`, client_secret_basic + PKCE).
  - `bff.ts:302`: refresh, ID token lấy từ `refreshGrant` (back-channel).
  - Không đường nào verify token do trình duyệt gửi lên, nên người ngoài không chọn được `kid`. Spam token có kid lạ không khuếch đại thành fetch JWKS.
  - Số lần fetch bị chặn bởi tốc độ đăng nhập/refresh thành công ở IdP. jose RemoteJWKSet chỉ reload khi không khớp kid và gộp các reload đồng thời.
  - JWKS URI lấy từ discovery của `OIDC_ISSUER` (env).
  - Kết luận: chấp nhận được, comment trong code nêu đúng lý do.
- **DEBT-349 (cache 10')**: đồng ý mức 💭. Một ID token ký bằng key đã gỡ chỉ có thể tới qua back-channel từ IdP thật (cần MITM kênh TLS server-to-server). Giữ nguyên debt.
- **Failure semantics**: refresh gặp JWKS timeout ⇒ `verifyIdToken` throw ⇒ `dropNew` (huỷ phiên, revoke RT mới) ⇒ fail closed. Hành vi này có từ trước, không phải hồi quy; cooldown 0 không làm xấu thêm.
- **Chuỗi request sau khẩn cấp**: POST thành công bằng AT cũ (guard verify trước khi xoay) → `onSettled` invalidate → GET 401 → BFF refresh 1 lần → ID token kid mới → JWKS reload ngay (cooldown 0) → list mới.
  - Refresh lỗi ⇒ `unauthenticated` ⇒ `signInAgain`, đã cảnh báo trong dialog.
  - POST 401 rồi refresh và gửi lại an toàn, vì 401 nghĩa là BE chưa thực hiện thao tác.
- **Concurrency**: mutex BE (DEBT-145). FE `busy` ref + `pending` khoá dialog. Không retry.
- **E2E an toàn với key dev**:
  - `test.skip(E2E_REUSE === "1")`.
  - Khi không REUSE, `reuseExistingServer: false` ⇒ nếu cổng 4000 đang có BE dev, Playwright lỗi chứ không chạy vào dev.
  - `KEY_LOCAL_DIR = e2e/.keys` (đã gitignore).
  - Chỉ rotate thường. K1 còn verify thêm 120s ⇒ spec sau không bị ảnh hưởng (dev báo full suite 33 passed ×2).

## 🟡 Nên sửa
- (ponytail) `fe-admin/src/features/admin-api/hooks.ts` `useSigningKeys(enabled)` — xem mục Ponytail. → DEBT-352.

## 💭 Nit
- `routes/keys/index.tsx:72`: `kidBefore` lấy từ cache list lúc click, sát hơn "lúc mở dialog" nên tốt hơn fold.
  - Edge: cache cũ (admin khác vừa xoay; focus refetch thường đã giảm khả năng này) có thể khiến thông điệp uncertain kết luận "đã áp dụng" trong khi lần xoay khẩn cấp của mình chưa chạy.
  - Cân nhắc thêm vào thông điệp khẩn cấp: "an emergency rotation leaves exactly one key in the list", và/hoặc trỏ tới audit `SIGNING_KEY_ROTATED` `mode=emergency`.
- `confirm-action.tsx`: nút xác nhận `disabled` khi chưa gõ đúng nhưng không gắn `aria-describedby` tới nhãn "Type EMERGENCY to confirm". Ngữ cảnh đã đủ rõ vì ô nhập nằm ngay trên nút, nên thêm là tuỳ chọn.
- `routes/keys/index.tsx`: hai nút rotate vẫn hiện khi list đang tải hoặc lỗi. Nếu uncertain lúc đó, thông điệp không có `kidBefore` (đã có nhánh xử lý), nên chấp nhận được.
- `schemas.ts` `SigningKeySchema`: `alg`/`createdAt` là `z.string()` không giới hạn độ dài. Chỉ render text nên vô hại; có thể thêm `.max(64)` cho đồng bộ với `kid`.
- Trigger "Rotate key" và nút xác nhận trùng tên. E2E và test đã scope theo dialog nên không lỗi; đổi nhãn xác nhận thành "Rotate" là tuỳ chọn.

## ✂️ Ponytail
- fe-admin/src/features/admin-api/hooks.ts:L338: yagni: tham số `enabled` (caller duy nhất `useSigningKeys(true)`; `Keys` chỉ mount cho super_admin). Bỏ tham số và dòng `enabled`, gọi `useSigningKeys()`.
- fe-admin/src/routes/keys/index.tsx:L78: shrink: `outcomeOf(err, uncertainText(kidBefore), BY_CODE)`. Nhánh uncertain bên trong `outcomeOf` đã bị chặn ở dòng 77 nên không bao giờ chạy; giữ nguyên để dùng chung helper cũng được (0 dòng).

net: -3 lines possible.
