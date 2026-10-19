# Senior Review — 2026-10-19

## Kết luận: PASS

Không có 🔴. Chuyển sang **tester**. Các 🟡 vào backlog (DEBT-179, DEBT-180); gợi ý cho DEBT-178 ghi bên dưới.

Bằng chứng tự chạy (reviewer): `pnpm -C be typecheck` sạch; `pnpm -C be test` 271/271; `pnpm -C be test:int -- admin-public-client admin-api seed refresh-token admin-target-risk` 8 suite, 176/176 xanh (vg-test-*). Không chạy E2E, không chạy seed trên DB dev.

## Tổng quan

Run gọn, đúng fold tech-lead và đóng lỗ bằng cấu trúc thay vì vá dấu vết:
- Một predicate `isAdminCapableClient` (allowlist `confidential` + `client_secret_basic|client_secret_post`, thiếu field => cấm), `adminTargetForbidden(client, …)` dùng ở /authorize (`resolveResource`), consent (`decideConsent`), /token code (`issueForAuthorizationCode`), refresh (lọc `allowedIdentifiers`) và `AdminTokenGuard` (dùng `seen.client` sẵn có, 0 query thêm). `adminAud` tính 1 lần trong constructor.
- Seed: `createIndexes()` trước mọi ghi, `admin` chỉ `$setOnInsert`, identifier khác => throw, bỏ ngoại lệ fe-admin và `isAdminIdentifierShape`.
- PATCH: `disabled:true` phải đi một mình (400 ở controller, trước service), nên 409 của stamp disable không còn theo sau một ghi field khác; `AdminGrantAbortedError{secretsRevoked, cause?}` + audit đếm.
- Test: ma trận `{public,none}`/`{confidential,none}` cho cả 5 chốt, mỗi case có control (demo / client capable basic+post); test seed đổi có chủ đích (ISSUER change => refused, scopes không bị reset).

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm

- **Phát hành `aud=admin`** — mọi đường grant được hỗ trợ: `/token` chỉ có `authorization_code` + `refresh_token` (không client_credentials/token-exchange). /authorize (`authorize.service.ts:449`), consent re-check sau consume (`:315`, client đọc lại từ DB nên client "drift" giữa render và approve => không code), code exchange (`token.service.ts:118`, code đã consume => không replay), refresh (`refresh-token.service.ts:146`). `token.controller.ts:286` đã truyền thêm `tokenEndpointAuthMethod`; nếu thiếu, allowlist sẽ fail-closed với mọi client và test dương tính `admin.int-spec.ts` (refresh basic => 200) sẽ đỏ — có lưới an toàn.
- **Refresh không đốt / không báo reuse giả**: admin bị lọc khỏi allowlist trước khi tra token => phân loại "resource mất" (`invalid_grant`), test kiểm `revokedAt` null + đúng 1 document (không rotate, không revoke family). Đúng invariant.
- **Dùng token (AdminTokenGuard)**: check sau liveness, theo bản ghi DB hiện tại, trả cùng `AdminAuthError.invalidToken()` (401 + WWW-Authenticate) như token không live => không oracle phân biệt lý do. Thứ tự: verify chữ ký -> liveness -> capable -> scope, nên client lệch không thể dò scope.
- **Fail-closed**: thiếu/không rõ `clientType` hoặc method => không capable (unit `it.each` 9 case gồm `{}` và `private_key_jwt`). Lỗi DB ở liveness vẫn propagate (không đổi).
- **Seed không re-point**: `$setOnInsert` + guard (i) identifier khác => throw trước ghi; (ii) `admin` vắng mà có client tham chiếu => throw; post-check `exists({resourceId, identifier})` giữ nguyên nên nếu super_admin tạo `admin` khác identifier xen giữa guard và upsert, upsert no-op và seed throw. Race với tenant_admin đóng vì `assertAllowedResources` đòi resource tồn tại.
- **Lỗi createIndexes không lộ giá trị trùng**: message chỉ có tên model + `codeName`/`code`, test khẳng định không chứa email.
- **Audit PATCH**: nhánh abort ghi `CLIENT_SECRET_REVOKED{reason:'admin_grant_aborted', count}` + `ADMIN_CLIENT_UPDATED failure`, mỗi lệnh `.catch` rồi trả lỗi gốc (404 opaque khi không có `cause`, raw cause => 5xx). Metadata chỉ count/reason — không secret/hash/version. Nhánh lượt-2 nay cũng ghi count lượt 1. Không oracle: grant `admin` chỉ super_admin, và repo tenant-scoped.
- **Disable đi một mình**: kiểm trên DTO đã qua ValidationPipe (`v !== undefined`, nên `frontchannelLogoutUri:null` cũng tính là field) => 400 trước mọi ghi; `disabled:false` + field vẫn atomic trong `$set`.

## 🟡 Nên sửa

- [ ] [BE] `client.service.ts:454` `assertAdminCapableType` (dùng ở create `:230` và grant `:291`) — điểm GHI vẫn chỉ kiểm `clientType`, là một định nghĩa thứ hai của "client được phép admin".
  Vì sao: với bản ghi lệch `{confidential, none}` (ghi DB trực tiếp — đúng kịch bản DEBT-174), super_admin vẫn cấp được `admin` (revoke secret xong, 200) nhưng mọi chốt runtime sẽ từ chối => cấu hình "admin" chết, gây hiểu lầm. Không phải lỗ bảo mật (runtime chặn), nhưng mâu thuẫn với chốt "MỘT định nghĩa duy nhất".
  Đề xuất: cân nhắc thay bằng `if (!isAdminCapableClient(current)) throw new InvalidClientConfigError(...)` (create: truyền `input`). => DEBT-179.
- [ ] [BE] `seed.ts` khối `catch` của `createIndexes` — mọi lỗi (timeout mạng, `NotWritablePrimary`, thiếu quyền) đều thành "remove duplicated documents / run db:sync-indexes" và nuốt `err` gốc.
  Vì sao: operator bị dẫn sai khi lỗi không phải dữ liệu trùng; chỉ còn `codeName` để chẩn đoán.
  Đề xuất: chỉ dùng thông điệp "dọn trùng" khi `code === 11000` (DuplicateKey) hoặc xung đột index (`IndexOptionsConflict`/`IndexKeySpecsConflict`), còn lại throw `new Error(\`seed: ensuring the ${name} indexes failed (${code})\`, { cause: err })` — vẫn không echo message E11000. => DEBT-180.
- [ ] [BE][test] Đánh giá DEBT-178 (đồng ý giữ là 🟡, không chặn): test race 10 vòng cùng tiến trình RED 0/10 khi bỏ `createIndexes`, nên nó KHÔNG bảo vệ invariant "index có trước ghi"; mutation chỉ RED tất định nhờ test email trùng. Đề xuất rẻ và tất định hơn spawn 2 CLI: sau `seedBootstrap` trên DB `autoIndex:false` rỗng, assert `listIndexes()` có các unique index chính (vd. `users` `email` unique, `resources` `resourceId` unique, `clients` `clientId` unique) — bỏ `createIndexes` => RED 100%. Có thể giữ test race như smoke. (Gợi ý cập nhật vào DEBT-178, không mở DEBT mới.)

## 💭 Nit

- `admin-public-client.int-spec.ts:339` — "không báo reuse giả" đang được suy gián tiếp qua `revokedAt` null; có thể thêm 1 assert không có audit `REFRESH_TOKEN_REUSE` cho rõ ý định.
- `admin-clients.controller.ts` nhánh catch: `metadata: { count }` của `ADMIN_CLIENT_UPDATED` lặp lại `count` đã có trong `CLIENT_SECRET_REVOKED`; vô hại, giữ cũng được để một bản ghi failure tự đủ ngữ cảnh.

## ✂️ Ponytail

- be/src/database/seed.ts:L119: shrink: `connection.models[name] ?? connection.model(name, schema)` lặp ý helper `model()` ngay trên. Nới `model()` nhận `schema?` rồi dùng chung (hoặc giữ nguyên — 1 dòng).
- be/src/modules/clients/client.service.ts:L454: delete: `assertAdminCapableType` thành thừa nếu áp DEBT-179. Dùng `isAdminCapableClient`.
net: -6 lines possible.
