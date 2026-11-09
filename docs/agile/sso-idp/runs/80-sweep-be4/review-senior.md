# Senior Review — 2026-11-09 (run 80, sweep 🟡 BE đợt 4)

## Kết luận: PASS

## Tổng quan (ấn tượng chung + điểm tốt)

Diff nhỏ, bám sát fold tech-lead, mỗi task có test RED + mutation ghi lại. Điểm tốt:
- T4 kiểm `super_admin` ngay trong `AdminTokenGuard` (guard cấp class) thay vì dựa vào thứ tự decorator: Nest chạy guard global → controller → method, và `RequireRecentAuth` = `applyDecorators(SetMetadata, UseGuards(StepUpGuard))` ở method ⇒ thứ tự cố định thật. `getAllAndOverride([handler, class])` đúng. Thiếu metadata ⇒ handler vẫn `assertSuperAdmin` ⇒ không fail-open.
- T1 giữ dừng-ở-lỗi-đầu, `.catch` trên audit failure, test (4) dùng lỗi gốc Redis timeout ⇒ 503 để chứng minh chính lỗi gốc được ném lại (lỗi audit sẽ là 500) — thiết kế test tinh.
- T5 assert `commitTransaction` thật sự được gọi (chống xanh giả), restore trong `finally`.
- Bảng parity FE đo lại bằng validator thật trong `resource.validator.spec.ts` thay vì giả định.

Đã chạy lại: be unit `resource[.]validator|admin-guards|html-exception` 92/92; int `admin-keys|ui[.]int|federation` 247/247; fe-admin 1578/1578.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Authorization (T4)**: mọi route `assertSuperAdmin` (`grep`): keys `list`/`rotate`, resources `create`/`update` — cả 4 có `@SuperAdminOnly()`; không sót. `admin-clients` (admin-capable client ⇒ super_admin) là điều kiện theo dữ liệu, không dùng được metadata — ngoài phạm vi DEBT-325. tenant_admin ⇒ `{error:'forbidden'}` như nhánh thiếu vai trò (không oracle mới); 401/`insufficient_scope` vẫn trước; super_admin cũ vẫn `step_up_required` (unit + int). `GET /admin/resources` vẫn mở cho tenant_admin.
- **Boundary input (T3)**: `/[\p{Cc}\p{Cf}\p{Z}]/u` là một lớp ký tự, không lượng từ ⇒ không ReDoS; cờ `u` có. Kiểm ký tự trước `new URL` (đúng: URL nuốt tab/LF). Scheme so trên `protocol` đã lowercase. Thông điệp 400 cố định, không echo (`validateResourceFormat` vẫn echo nhưng chỉ ở runtime và nhánh format trên đường ghi — input chính là của super_admin, không mới). Chỉ áp ở `create/createUnique`; `updateScopes` không validate identifier, PATCH lọc theo `current.identifier` ⇒ resource cũ có identifier lạ vẫn sửa scopes được; DTO PATCH không nhận `identifier`. Runtime `resolveForClient` giữ `validateResourceFormat`.
- **Parity FE/BE (T3)**: cùng regex + allowlist; FE đo độ dài UTF-16 (chặt hơn) ⇒ FE không bao giờ nhận cái BE từ chối. Form edit chỉ có `scopes` ⇒ identifier cũ không chặn sửa.
- **Exposure (T1/T2)**: audit failure chỉ `scope` + `failedStep` (enum), `targetId = session.ref` như audit success. `HtmlExceptionFilter` log `errorForLog` (tên/code/frame, lọc dòng trùng message), chỉ ≥ 500; 4xx không log. 503 `/introspect` thêm câu cố định, vẫn không `active`, `Retry-After` giữ.
- **Failure behavior (T1)**: lỗi ⇒ 5xx, không audit success, không clear cookie/redirect; `pre_revoke`/`sessions` lỗi ⇒ phiên sống, retry 302 (int).
- **State/transaction (T5)**: lỗi ở COMMIT ⇒ 0 User/UT/FI và tổng 3 collection không đổi; spy restore trong `finally`, `log-capture` có `restoreAllMocks`. `deleteMembership` = 0 kết quả grep trong `be/src` + `be/test`.

## 🟡 Nên sửa

- [ ] `be/src/modules/resources/resource.validator.ts:38` (doc) + `be/src/database/seed-dev.ts:99` + `be/src/database/seed.ts:107` — doc nói quy tắc ghi áp cho "seed-dev through `ResourceService`", nhưng cả `seedDev` lẫn `seedBootstrap` ghi thẳng `resourceModel.updateOne(..., {upsert:true})` sau `validateResourceFormat`, không qua service. Vì sao: invariant "điểm GHI không lưu identifier có khoảng trắng/ký tự điều khiển/scheme lạ" có 2 cửa sau; đầu vào chỉ là `ISSUER` + hằng (dev/test, `assertDevOrTestEnv`) nên rủi ro thấp, nhưng một `ISSUER` sai (vd. có dấu cách cuối dòng trong `.env`) sẽ lưu `aud` mà không client nào khớp, và doc đang khẳng định điều sai cho người sau. Đề xuất: đổi 2 chỗ sang `validateResourceIdentifier` (mỗi chỗ 1 dòng + import) và sửa doc; unit seed: `ISSUER` có `\t`/`javascript:` ⇒ ném trước mọi ghi. ⇒ **DEBT-531**.

## 💭 Nit

- `be/src/modules/admin/admin.dto.ts:179` — `@ApiProperty` của `identifier` vẫn "Absolute URI without fragment (the `aud`)." — OpenAPI (FE đọc) chưa nói quy tắc mới (https/http/urn, không khoảng trắng/ký tự điều khiển). Cân nhắc cập nhật description + regenerate khi chạm admin DTO.
- `urn:` (NSS rỗng) vẫn được nhận cả hai phía — nhất quán, vô hại, chỉ ghi nhận.
- `resource.validator.ts:49-50` parse `new URL` hai lần (trong `validateResourceFormat` rồi lấy `protocol`) — có thể cho `validateResourceFormat` trả `URL`; lợi ích không đáng một thay đổi API.

## ✂️ Ponytail

Diff đã gọn: guard thêm 1 điều kiện, validator 1 regex + 1 Set, xoá `deleteMembership` (-6). Không thấy abstraction thừa; regex trùng FE/BE là bắt buộc (2 package, có bảng parity chốt).

Lean already. Ship.
