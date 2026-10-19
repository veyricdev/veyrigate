# Tech Lead Review — 2026-10-19

## Kết luận: PASS (kèm fold bắt buộc trong `tasks.md` mục "Fold tech-lead")

Đối chiếu code thật (nền `e950419`): `token.service.ts` (`adminTargetForbidden`, `adminResource`), `authorize.service.ts` (`resolveResource`, `decideConsent`), `refresh-token.service.ts` (`issueForRefresh` filter), `tenant-context.ts` (`AdminTokenGuard.canActivate`, `seen.client`), `access-token-liveness.ts`, `client.service.ts` (`updateForTenant`, `assertAllowedResources`), `client-authentication.service.ts`, `admin-clients.controller.ts` (`update`), `seed.ts`, `sync-indexes.ts`, int `admin-api.int-spec.ts` (DEBT-161), `seed.int-spec.ts`.

## Kiến trúc đề xuất
Giữ modular monolith, không thêm abstraction. Ưu tiên **đóng lỗ bằng cấu trúc** thay vì thêm dấu vết/khôi phục:
- Task 2: seed không bao giờ re-point `admin` (`$setOnInsert`) ⇒ race check-then-write (DEBT-173(1)) và ngoại lệ fe-admin (DEBT-173(2)) biến mất thay vì phải rollback/lock.
- Task 3: cấm `disabled:true` đi kèm field khác ⇒ 409 không còn xảy ra sau một ghi thật (DEBT-167) thay vì audit "thất bại một phần".

## Trả lời câu hỏi
- **Q-31.1**: chặn theo client hiện tại trong DB tại `AdminTokenGuard`. Không phát sinh query: `isAccessTokenLive` đã tải `Client` đầy đủ qua `findByClientId` và guard giữ trong `seen.client` (chỉ cần nới type). 401 `invalid_token` (không lộ lý do).
- **Q-31.2**: seed tự `createIndexes()` mọi `MODELS` trước mọi ghi; KHÔNG `syncAllIndexes` (drop index ngoài schema). Lỗi index/dữ liệu trùng ⇒ throw trước ghi ⇒ exit 1.

## Điểm mạnh
- Phạm vi gọn, đúng nhóm debt bảo mật admin còn mở; đã nhận ra 3 debt cùng gốc (DEBT-173(3)/174/175).
- Hạ tầng/ràng buộc (không compose up/FLUSH/drop, không seed DB dev) nêu rõ.

## Vấn đề (đã fold vào tasks.md — dev làm theo fold)
- [x] Task 1: predicate theo `=== 'none'` là denylist ⇒ chốt **allowlist** `client_secret_basic|client_secret_post` + `confidential` (thiếu field ⇒ cấm). Liệt kê đủ 5 chốt, guard trả 401; acceptance có test AT cũ sau khi client bị đổi DB.
- [x] Task 2: "re-check sau upsert + rollback" không đóng được race (TA đọc `adminIds` trước upsert, ghi sau post-check) ⇒ thay bằng không re-point + `createIndexes`. Acceptance concurrency loại trừ credential (DEBT-164).
- [x] Task 3: audit `concurrent_update` kèm `changedFields` vẫn để client nhận 409 dù redirectUris đã đổi ⇒ thay bằng 400 cho PATCH disable lẫn field khác. DEBT-170 chỉ còn nhánh 404/DB/lượt-2 sau revoke lượt 1 ⇒ lỗi mang `secretsRevoked`, controller audit `CLIENT_SECRET_REVOKED{reason:'admin_grant_aborted',count}`.
- [x] Test hiện có phải đổi có chủ đích: `seed.int-spec` "ISSUER change … fe-admin alone => re-pointed" ⇒ refused; DEBT-161 race test giữ xanh.

## Security design gate
- Tài sản/actor/boundary: token `aud=admin` (control-plane); actor tenant_admin (không được admin-capable), super_admin, operator CLI; client public/lệch method.
- Invariant: chỉ client confidential có secret method mới giữ/dùng `aud=admin` — kiểm ở mọi điểm phát hành VÀ điểm dùng (guard), theo trạng thái DB hiện tại. Seed không đổi identifier của resource đã tồn tại.
- Abuse: token cũ sau khi client đổi loại (stale credential) ⇒ guard 401; race seed∥API ⇒ không còn cửa sổ re-point; race disable∥enable ⇒ 409 không kèm ghi; dữ liệu trùng do không index ⇒ unique index chặn.
- Failure semantics: `createIndexes` lỗi ⇒ fail-closed trước ghi; DB lỗi sau revoke lượt 1 ⇒ secrets đã thu hồi (fail-closed) + audit best-effort `.catch` rồi 5xx; audit store lỗi không nuốt lỗi gốc.
- Exposure: audit chỉ count/reason, không secret/hash/version; message seed chỉ nêu clientId/identifier; guard không phân biệt lý do 401.

## Đề xuất (không bắt buộc)
- DEBT-177 (backlog): `/introspect`/`/userinfo` vẫn coi AT `aud=admin` của client không admin-capable là active (không cấp quyền admin vì admin API chỉ qua guard).
