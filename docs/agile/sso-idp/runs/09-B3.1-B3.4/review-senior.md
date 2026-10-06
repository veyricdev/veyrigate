# Senior Review — 2026-10-06
## Kết luận: PASS

## Tổng quan
Code B3.1–B3.4 gọn, đúng phạm vi plan §B3 (chỉ service/validator/schema, không controller — đúng vì CRUD admin là B6.3, chưa có HTTP endpoint nào lộ ra).
Đã verify độc lập (không chỉ tin log của dev):
- `pnpm typecheck` (be/): PASS, không lỗi.
- `pnpm lint` (be/): PASS, không lỗi.
- `pnpm test` (be/, unit): 12 suites / 67 tests PASS, gồm `redirect-uri.validator.spec.ts` (16 test) và `validation.schema.spec.ts` (CLIENT_SECRET_GRACE_TTL).
- `pnpm test:int` (be/, Mongo thật port 27117): 10 suites / 138 tests PASS, gồm `clients.int-spec.ts` (B3.1–B3.4 end-to-end trên Mongo thật).
- Đối chiếu từng điều kiện C1–C6 của tech-lead với code thật (đọc file, không chỉ đọc log.md của dev) — xem mục "Security invariants" dưới.

Điểm tốt:
- `redirect-uri.validator.ts` tách rõ hai mối quan tâm khác bản chất: format tại write-time vs exact-match tại request-time — đúng tinh thần INV-4, không trộn lẫn.
- `client-credential.service.ts`/`client-authentication.service.ts` dùng dummy-hash đúng pattern đã có ở `authentication.service.ts` (`DUMMY_HASH`) — nhất quán, không tự nghĩ cơ chế chống enumeration mới.
- `resource.service.ts.resolveForClient` implement đúng mapping `identifier (URI) → resourceId` rồi mới so với `allowedResources[]` — đúng C3, có test int riêng cho case "URI hợp lệ nhưng resourceId không nằm trong allowedResources".
- Comment trong code trỏ thẳng tới `tech-lead C1..C6`, giúp review sau dễ đối chiếu, không phải đoán ý định.

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm

**C1 — redirect_uri env-aware**: `ClientService` đọc `config.getOrThrow<AppConfig>('app').nodeEnv !== 'production'` để quyết định `allowHttpLocalhost`; `redirect-uri.validator.ts` không tự đọc `NODE_ENV`, chỉ nhận flag qua tham số — đúng yêu cầu "caller-supplied, never hard-coded in this file". `clients.int-spec.ts` build lại service với `nodeEnv: 'production'` → reject `http://localhost`; `nodeEnv: 'development'` → accept. Unit spec riêng cover wildcard/fragment/subdomain/query/trailing-slash. ĐẠT.

**C2 — grace TTL**: `CLIENT_SECRET_GRACE_TTL` theo đúng pattern `positiveInt` như `SESSION_IDLE_TTL`, default tạm 604800s (7 ngày), ghi rõ "pending spec §17" ở `validation.schema.ts`, `.env.example`, `configuration.ts`; tên test mô tả rõ "tech-lead C2 — spec §17 still open" — không bị hiểu lầm là đã chốt vĩnh viễn. ĐẠT.

**C3 — mapping resource↔resourceId**: `resolveForClient` tra `Resource` theo `identifier`, lấy `resourceId`, rồi check `allowedResourceIds.includes(resource.resourceId)` — không so URI trực tiếp với `allowedResources`. Test int cho cả 3 case: allowed, resourceId hợp lệ nhưng không trong allowedResources, URI chưa đăng ký. ĐẠT.

**C4 — timing oracle client auth**: `ClientCredentialService.verifySecret` luôn chạy Argon2 verify — dùng dummy hash khi `active.length === 0` (client không tồn tại hoặc hết hiệu lực) — và `Promise.all` verify mọi version còn hiệu lực song song, không short-circuit (`results.find` chỉ chọn sau khi mọi promise đã resolve). `ClientAuthenticationService.authenticate` luôn gọi `verifySecret` trước khi kiểm `client`/`method`, nên "unknown client_id", "method sai", "secret sai" đều đi qua cùng nhánh DB-lookup + Argon2-verify. Test int có case "unknown client_id" riêng khẳng định reject đúng kiểu lỗi (`InvalidClientError`). Chưa đo timing thực tế bằng benchmark — chấp nhận được ở mức B3 (đo timing thuộc security test matrix §14, không phải việc của B3). ĐẠT cho scope B3.

**C5 — CORS theo đúng client/endpoint**: `ClientCorsService` tách `isOriginAllowedForClient` (per-client) và `isOriginRegisteredForAnyClient` (union, dùng cho jwks/discovery/preflight) — đúng docblock nêu endpoint→method mapping. Service không tự set HTTP header, không đụng response — đúng ý tech-lead "endpoint cần nó (B4) gọi sau khi biết client context, tự set header". Vì `/token`/`/userinfo`/`/jwks.json` chưa tồn tại (B4), C5 ở B3.4 chỉ cần expose đúng primitive — đã đạt; phần "ai gọi, lúc nào, set header thế nào" là trách nhiệm B4, không phải B3.4. `@fastify/cors` được thêm vào `package.json` nhưng **chưa được dùng ở bất kỳ đâu trong `src/`** (xác nhận bằng search toàn repo) — xem 🟡 bên dưới.

**C6 — secretHash dùng hashPassword/verifyPassword**: `ClientCredentialService` dùng `hashPassword`/`verifyPassword` (Argon2id) từ `crypto.util.ts`, không tự viết lại thuật toán. Docblock ghi rõ "the Argon2 verify itself is the constant-time comparison" để tester không hiểu nhầm thiếu `constantTimeEqual`. ĐẠT.

**Exposure**: không có log nào ghi secret raw; `InvalidClientError` message cố định `'Client authentication failed'`, không echo secret/client_id.

**Boundary input**: `validateRedirectUriFormat`/`validateResourceFormat` dùng `new URL()` để parse (bắt mọi malformed string), không tự viết regex URI dễ sai edge-case; throw sớm, không tiếp tục xử lý input bẩn.

## 🟡 Nên sửa
- **`@fastify/cors` thêm vào `package.json` nhưng chưa dùng ở bất kỳ đâu trong `src/`.** Tech-lead C5 gợi ý dependency này cho hook CORS thủ công ở B4, B3.4 mới dừng ở "trả lời origin có hợp lệ không" (đúng scope task). Rủi ro: nếu B4 quên wire, dependency nằm chết trong `package.json`. Đề xuất: khi làm B4, dùng `ClientCorsService` + `@fastify/cors` (hoặc hook thủ công) đúng như comment đã tả trong `client-cors.service.ts`; nếu cuối cùng chọn tự viết hook thì gỡ dependency thừa. → DEBT-019.
- **`ClientSchema` chưa có index hỗ trợ truy vấn CORS theo origin.** `isOriginRegisteredForAnyClient` query `{ allowedCorsOrigins: origin }` không có index trên field này (chỉ có index trên `clientId`), nên sẽ full-scan collection `Client`. Ở quy mô nhỏ chưa vấn đề, nhưng đây là endpoint gọi mỗi preflight/jwks/discovery request. Đề xuất: thêm `ClientSchema.index({ allowedCorsOrigins: 1 })` khi B4 wire thật và có traffic. → DEBT-020.
- **`ClientCredentialService.rotateSecret` không atomic dưới concurrent calls trên cùng `clientId`.** `nextVersion` tính bằng `Math.max(...active.map(c => c.version)) + 1` sau khi load toàn bộ `listActive` — hai lời gọi `rotateSecret` đồng thời có thể tính ra cùng `nextVersion` (index `{clientId:1, version:1}` hiện không unique). Rotate thường là hành động hiếm/đơn luồng (không phải hot path như `/token`) nên rủi ro thấp, nhưng nên ghi chú rõ trong code đây "không atomic dưới concurrent rotate" để không bị hiểu nhầm là đã an toàn tuyệt đối, và cân nhắc unique index `(clientId, version)` khi có admin API thật (B6.3). → DEBT-021.

## 💭 Nit
- `resource.schema.ts` không có `timestamps: true` (có trên `ClientSchema`). Không ảnh hưởng B3.2, nhưng nếu sau cần audit "resource tạo lúc nào" sẽ thiếu.
- `client-credential.service.ts`: `dummyHashPromise`/`getDummyHash` là lazy/async (hash một secret random tại lần gọi đầu) khác cách khởi tạo tĩnh của `DUMMY_HASH` ở `authentication.service.ts` — hoạt động đúng, chỉ khác style, không cần đổi ngay (xem ponytail bên dưới cho đề xuất gộp).

## ✂️ Ponytail
- be/src/modules/clients/client-credential.service.ts:L30-36: yagni: `dummyHashPromise`/`getDummyHash` lazy-cache riêng cho module này, một caller duy nhất (`verifySecret`). Export `DUMMY_HASH` tĩnh đã có ở `authentication.service.ts` và tái dùng thay vì tạo bản async/lazy mới.
- be/src/modules/clients/client-cors.service.ts:L29-48: giữ nguyên — `isOriginAllowedForClient`/`isOriginRegisteredForAnyClient` chưa có caller (B4 chưa tồn tại) nhưng là nền tảng cho task kế tiếp liền sau (B3.4 phụ thuộc trực tiếp vào B4 sắp tới), không phải đầu cơ xa; không tính vào net cắt.
net: -6 lines possible (gộp dummy-hash vào `DUMMY_HASH` sẵn có).

