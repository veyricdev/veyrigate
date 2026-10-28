# Tech Lead Review — 2026-10-28

## Kết luận: PASS

Phạm vi chốt 3 task (fold cuối `tasks.md`, ưu tiên hơn phần trên): T1 DEBT-389/158/160 (test + docs), T2 DEBT-151, T3 DEBT-238. DEBT-214 chờ người dùng (Q58.1).

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc. Modular monolith giữ nguyên; không thêm abstraction, env hay interface mới. T2 sửa một method service + một handler; T3 sửa một predicate.

## Xác minh debt tại HEAD `b71405a`

- **DEBT-158** còn đúng (`key-rotation.service.ts:51-80`). **Đóng, chấp nhận rủi ro.** Actor là super_admin + step-up 5'. Một lần xoay thừa chỉ thêm 1 key vào JWKS trong `ACCESS_TOKEN_TTL`. FE đã không tự gửi lại. Runbook §1 đã cấm gọi lại mù. Cooldown hay idempotency-key cần đổi `KeyProvider.rotate`, thêm env cho test và làm vỡ khoảng 25 test xoay liên tiếp (admin-keys, metrics, runbook-drill, vault-spec). Chi phí lớn hơn rủi ro.
- **DEBT-389** còn đúng (`vault-transit-key-provider.ts:196-230`). Gọi lại emergency đã hội tụ về mặt logic: `config`/`trim` dùng `n = latest` mới, nên version thừa cũng bị trim. Lỗ thật nằm ở runbook: bước 3 ghi "kid active đã khác ⇒ dừng". Khi emergency dở, kid active **đã** đổi nhưng key cũ vẫn còn `retiring` trong JWKS, nên người trực sẽ dừng sai. T1 sửa runbook và thêm test hội tụ.
- **DEBT-160** còn đúng: `SIGNING_KEY_CREATED` có trong enum nhưng không được phát. Ở prod, key do ops tạo trong Vault; app không tạo key nên không có gì để audit. Chốt spec §10, không code.
- **DEBT-151** còn đúng và là rủi ro thật. `revokeById` lọc `revokedAt: null`, nên lần gọi lại trả 404. Refresh grant không kiểm consent (`token.controller.ts:446-457` chỉ kiểm client/resource/subject). Vì vậy nếu sweep lỗi, family `offline_access` sống tới khi hết hạn và không có đường retry. Hợp đồng senior run 28 (204 idempotent) đúng. Bản sửa chỉ một round-trip, dùng pipeline `$ifNull` + before-image, nên race-safe.
- **DEBT-238** còn đúng nhưng rủi ro thấp (hôm nay không dep nào gắn `statusCode`). Bản sửa 2–3 dòng: chỉ nhận `code` rỗng hoặc bắt đầu `FST_`. Có hai mutation hai chiều, chặn cả quá rộng lẫn quá hẹp.
- **DEBT-214** còn đúng. Đây là quyết định nghiệp vụ/pháp lý, nên ghi câu hỏi Q58.1 với 3 phương án; đề xuất A (giữ hiện tại). Không đưa vào run.

## Điểm mạnh

- Run 54–57 đã dựng sẵn hạ tầng phù hợp: `revokeWhere` stamp `familyRevokedAt` cho mọi biến thể (race-close INV-11), audit best-effort theo mẫu DEBT-067, 404 byte-identical (D-27.c). T2 tái dùng toàn bộ.
- Fake Vault trong `vault-transit-key-provider.spec.ts` đủ để kiểm hội tụ, không cần container Vault.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có. Ràng buộc cho dev, nằm trong fold:
- [ ] T1 không đổi code sản phẩm; test RED trên HEAD ⇒ dừng, báo lại.
- [ ] T2 không ghi đè `revokedAt`; âm (e) gồm cả consent **đã revoke** ngoài phạm vi ⇒ 404 byte-identical; đổi test cũ "already revoked ⇒ 404" phải ghi rõ là đổi kỳ vọng có chủ đích.
- [ ] T3: nếu một nguồn 4xx thật (static 403, body parser) mang `code` khác `FST_` ⇒ dừng, báo lại, không tự nới.
- [ ] Mutation đúng như liệt kê, khôi phục byte-identical.

## Đề xuất (không bắt buộc)

- DEBT-428 (FE): `user-grants.tsx` coi lỗi uncertain của revoke consent là "không idempotent". Sau T2 có thể cho phép thử lại an toàn; nhánh `not_found` ⇒ "already revoked" nay sai nghĩa (chỉ còn khi ngoài phạm vi).
- DEBT-429 (BE/ops 💭): normal rotate trên Vault không bao giờ trim, nên `load()` parse PEM của mọi version mỗi lần refresh cache. Nên định kỳ trim các version đã ra khỏi cửa sổ retiring (runbook).
- Q58.1 (DEBT-214): xem cuối `tasks.md`.
