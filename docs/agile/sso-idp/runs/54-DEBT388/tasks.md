# Tasks — run 54 — DEBT-388 + DEBT-401 + DEBT-398 (M7, lane BE/ops)

> Nguồn: `backlog.md` DEBT-388 (🟡, tech-lead run 53), DEBT-401 (🟡, run 53c), DEBT-398 (🟡, senior run 53b). Liên quan spec/plan: plan §6.2 (fail-closed), §6.4 (keys), B4.x refresh rotation + reuse detection (family revoke, stamp-first), INV liên quan trong `security-matrix.md` (single-use code, RT rotation/reuse). Phải làm DEBT-388 trước khi bật Vault ở prod (STATUS).
>
> Hạ tầng: KHÔNG compose up/FLUSH/drop `aegate-*`; Vault tạm chỉ `vg-b73-vault`@127.0.0.1:18200 (như run 53), image smoke `veyrigate-be:smoke-run53b*`; dọn đúng tên. Không đụng `be/keys`, `be/.env`.

### [x] Task 1 [BE]: DEBT-388 — `/token` (authorization_code và refresh_token): ký AT/ID token TRƯỚC khi commit thay đổi trạng thái không thể hoàn tác (tiêu code, xoay RT), hoặc cơ chế tương đương (vd. ký trước rồi commit nguyên tử; nếu commit thất bại thì không trả token). Yêu cầu: lỗi ký (Vault down/timeout) ⇒ code vẫn dùng lại được / RT cũ vẫn hợp lệ, retry của client KHÔNG bị coi là reuse, family không bị revoke; đồng thời giữ nguyên bảo đảm single-use code, reuse detection (stamp-first), race 2 request đồng thời không phát hai bộ token hợp lệ. Test int: ký lỗi ⇒ retry thành công, 0 `TOKEN_REUSE_DETECTED`; race; reuse thật vẫn bị phát hiện.
### [x] Task 2 [BE]: DEBT-401 — lỗi mạng/5xx của `signJwt`/`getPublicKeys` ⇒ `KeyProviderUnavailableError` ⇒ `/token` và `/jwks.json` trả 503 `temporarily_unavailable` + `Retry-After` + `no-store`, không token; cập nhật test T5/vault spec.
### [x] Task 3 [ops]: DEBT-398 — bước build fail-closed trong `be/Dockerfile` và `fe-admin/Dockerfile` chặn `.env*`/key/PEM/`.npmrc` trong build context; runbook cấm export cache `mode=max`; mutation (hỏng ignore ⇒ build FAIL).

## Câu hỏi cho tech-lead
- Q-54.1: Thứ tự ký/commit cụ thể cho code grant và refresh grant với kiến trúc hiện tại (Lua consume code, rotate stamp-first) — làm sao không mở cửa cho race/double-issue.
- Q-54.2: Có cần đổi cấu trúc Redis/Mongo (vd. trạng thái "pending" ngắn hạn) không.

## Fold tech-lead (2026-10-26) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Kết luận: **PASS có fold**. Không tách run. Thứ tự làm: **Task 2 → Task 1 → Task 3** (Task 1 cần phân loại 503 của Task 2 để test nói đúng; Task 3 độc lập). Lý do chi tiết: `review-techlead.md`.

Trả lời Q-54.2: **không** đổi cấu trúc Redis/Mongo, **không** thêm trạng thái "pending", **không** thêm cửa sổ grace (spec §9.5 cấm), **không** bù trừ (khôi phục code / gỡ revoke RT). Nguyên tắc duy nhất: **ký trên bản đọc (không ghi) → commit nguyên tử hiện có → chỉ trả token khi commit thắng và mọi re-check sau commit đạt**. Token đã ký mà commit thua chỉ nằm trong bộ nhớ và bị bỏ (không trả, không log, không audit).

### F2 (Task 2, DEBT-401) — làm trước

1. Phân loại **chỉ trong** `be/src/modules/keys/vault-transit-key-provider.ts`, ở biên public `signJwt` và `getPublicKeys` (bọc cả lỗi `keySet()`/`refresh(false)` bên trong, tức đường "ký 5xx → refresh metadata cũng chết"). Đổi thành `KeyProviderUnavailableError(cause)` **khi và chỉ khi** lỗi cuối cùng là `VaultNetworkError` (mạng, timeout/AbortError, body không đọc được) hoặc `VaultStatusError` có `status >= 500` hoặc `status === 429`. Giữ nguyên (⇒ 500): 400, 403 (sau khi đọc lại token file), metadata sai hình, "unexpected signature format or key version", "signature does not verify", key sai cấu hình (exportable, không RSA). Phân loại chạy **sau** logic refresh-một-lần của `signJwt` (nhánh `err instanceof VaultStatusError` hiện tại phải thấy lỗi gốc, không phải lỗi đã bọc). `listKeys`/`rotate` KHÔNG đổi (DEBT-410). `LocalKeyProvider`, `TokenSigner` KHÔNG đổi (lỗi signer chung vẫn 500: test `token.int-spec.ts › TokenSigner.sign error => 500` giữ).
2. `/token`: `renderError` đã map `isDependencyUnavailable` ⇒ 503; sửa mô tả: nhánh dependency dùng đúng câu của `OAuthExceptionFilter` ("The service is temporarily unavailable. Try again later."), KHÔNG dùng `descriptionFor('temporarily_unavailable')` (đang là câu rate-limit client auth, sai cho cả Redis outage từ 53c). 429 rate-limit giữ câu cũ. `/jwks.json`: không cần code mới trong controller (global `OAuthExceptionFilter` ⇒ 503 + `Retry-After: 5` + `no-store`), chỉ thêm test.
3. Test bắt buộc:
   - Unit `vault-transit-key-provider.spec.ts` (fetchFn giả), bảng: network error, AbortError timeout, 500, 502, 503, 429 ⇒ `KeyProviderUnavailableError` có `cause` là lỗi gốc, `message` không chứa addr/path/tên key/token; 400, 403 (cả 2 lần), sai định dạng chữ ký, chữ ký không verify, metadata sai hình ⇒ **không** phải `KeyProviderUnavailableError`. Cho cả `signJwt` (cache còn hạn và cache hết hạn) và `getPublicKeys`. T8/DEBT-395 (10 sign 500 ⇒ 1 metadata read) giữ xanh.
   - Vault spec T5 (`be/test/b73-tester.vault-spec.ts`): đổi `>= 500` thành đúng **503** cho `/token` (code grant **và** refresh grant) và `/jwks.json`; mỗi cái: `Retry-After: 5`, `cache-control: no-store`, body đúng `{error:'temporarily_unavailable', error_description:<câu outage>}`, không `eyJ`/`access_token`/`refresh_token`/`kty`. Sau `proxy.up()`: **cùng code** (còn trong 60 s) ⇒ 200 và **cùng RT** ⇒ 200, `TOKEN_REUSE_DETECTED` = 0 (test thật của DEBT-388 trên Vault thật).
   - Int: `/token` khi Redis down (đã có từ 53c) assert thêm `error_description` = câu outage (pin sửa mô tả).
   - Mutation: (M5a) bỏ bọc ở `signJwt` ⇒ T5 `/token` 503 + unit RED; (M5b) bỏ bọc ở `getPublicKeys` ⇒ test JWKS 503 RED; (M5c) bọc MỌI lỗi ⇒ case "signature does not verify ⇒ không 503" RED.

### F1 (Task 1, DEBT-388) — thứ tự thao tác cố định

**Code grant** (`token.controller.ts handleAuthorizationCodeGrant`, `authorization-code.service.ts`, `token.service.ts`):

1. Phần đầu giữ nguyên (grant type, định dạng verifier, client auth, rate limit, CORS).
2. **Mới** `AuthorizationCodeService.peek(code, clientId, redirectUri, codeChallenge)`: `GET` khoá `authz_code:{sha256}` (KHÔNG `DEL`, KHÔNG đổi TTL), so 3 trường binding **giống hệt** Lua consume; khác ⇒ `null`. Trả `{ raw, data }`. Không log. `null` ⇒ `invalid_grant` (binding sai thì code còn nguyên như hôm nay, INV-13).
3. **Cổng ký thuần (không I/O)** trên `data` đã peek: `bodyResource` undefined hoặc = `data.resource`; `data.sessionRef` có; `data.resource` có; `!adminTargetForbidden(client, data.resource, adminResource)`. Cả 4 đạt ⇒ `signed = await tokens.signForAuthorizationCode(client, data)` (method mới, tách nguyên phần ký của `issueForAuthorizationCode`: AT rồi ID token, claim/thứ tự giữ y nguyên). Không đạt ⇒ `signed = undefined` (không ký) và đi tiếp bước 5 để refusal vẫn **đốt code** như hôm nay.
4. **Lỗi ký ⇒ ném ngay, KHÔNG gọi `consume`** (code còn nguyên; `KeyProviderUnavailableError` ⇒ 503, lỗi khác ⇒ 500). Không audit `TOKEN_ISSUED` (không có gì bị tiêu).
5. `consume(...)` (Lua hiện có, KHÔNG sửa). `null` ⇒ `invalid_grant` (thua race / hết hạn trong lúc ký), token đã ký bị bỏ. `raw` consume trả về phải **===** `raw` đã peek; khác ⇒ `invalid_grant`, không token (bất biến phòng thủ: code bất biến sau `SET NX`).
6. Từ đây **giữ nguyên chuỗi hiện tại, đúng thứ tự**, dùng `data` đã consume: body resource ⇒ `invalid_target`; thiếu sessionRef ⇒ `invalid_grant`; `sessions.exists` ⇒ `invalid_grant`; `issueForAuthorizationCode(client, data, audit, signed)` giữ 2 kiểm `invalid_target` (resource/admin) ở đầu, rồi **chỉ** mint family + dựng response từ `signed`; `signed` undefined mà tới được đây ⇒ `throw new Error(...)` (500, bất biến: cổng bước 3 và kiểm bước 6 cùng predicate). Sau đó post-insert session re-check, `recheckCodeGrant`, `recordIssued success`, reply: **không đổi**.
   - Helper `afterInsert` (`be/test/token-code-recheck.int-spec.ts`) spy `issueForAuthorizationCode` phải truyền đủ tham số mới; ngữ nghĩa "ngay sau insert family" giữ.

**Refresh grant** (`refresh-token.service.ts issueForRefresh`; controller giữ nguyên):

1. `allowedIdentifiers`, pre-check `original` (đọc, không ghi), kiểm `invalid_target`/`invalid_scope`: giữ nguyên.
2. **Mới**: nếu có `original` ⇒ `signed = await tokens.signTokensForRefresh({ userId: original.userId.toHexString(), clientId: original.clientId, resource: original.resource, effectiveScope: effectiveScope ?? original.scope, sessionRef: original.sessionRef ?? undefined })` **TRƯỚC** `rotate`. Lỗi ký ⇒ ném, **không** `rotate` ⇒ RT cũ còn `revokedAt:null, replacedBy:null`, không successor, retry hợp lệ, 0 reuse.
3. `rotate(...)` **không sửa** (swap nguyên tử; miss ⇒ `classifyMiss` ⇒ reuse detection stamp-first y nguyên; INV-11 re-read `familyRevokedAt` y nguyên). `original` null ⇒ vẫn gọi `rotate` như hôm nay (chắc chắn miss: `revokedAt` không bao giờ bị gỡ, `expiresAt` cố định, cùng `allowedIdentifiers`) để phân loại reuse.
4. Sau `rotate` thành công: bất biến `signed` có **và** `result.rotatedFromId.equals(original._id)` (tokenHash unique); vi phạm ⇒ `revokeFamily(result.familyId, …)` best-effort + `throw new Error` (500), không token.
5. `recheckAfterRotate` (giữ nguyên, vẫn SAU rotate), audit `TOKEN_REFRESHED success`, trả response dùng `signed` + `result.newRefreshToken`. `TokenService.signTokensForRefresh` không đổi chữ ký.
6. Rủi ro còn lại chấp nhận (KHÔNG làm run này): Mongo lỗi **sau** swap (insert successor / audit success) ⇒ RT đã đốt ⇒ retry = reuse: đã là DEBT-032.

**Ràng buộc chung**: token đã ký bị bỏ không được log/audit/metric (kể cả qua `errorForLog`); không thêm Redis key/collection/field/index; không retry ký trong controller (provider đã retry 1 lần); `expires_in` giữ hằng TTL (AT ký sớm hơn commit vài ms đến vài giây, chấp nhận).

**Test int bắt buộc** (Redis/Mongo thật, `be/test/`, file mới `debt388-sign-before-commit.int-spec.ts` hoặc gộp vào `token*.int-spec.ts`). Tiêm lỗi ký bằng `jest.spyOn` trên `TokenSigner.sign` ném `new KeyProviderUnavailableError(new Error('x'))`; barrier = deferred promise trong spy `sign` (chỉ chặn lần ký `typ: 'at+jwt'`), spy gọi bản gốc rồi chờ barrier:

- C1 ký lỗi ⇒ 503 + `Retry-After` + `no-store`, không token; khoá `authz_code:{sha256(code)}` còn `EXISTS=1`, PTTL không bị reset (≤ trước); 0 RefreshToken doc mới; 0 `TOKEN_ISSUED`; restore spy ⇒ **cùng code** ⇒ 200, đúng 1 family, đúng 1 `TOKEN_ISSUED success`.
- C2 lỗi signer thường (Error) ⇒ 500 (test hiện có) **và** code còn dùng được ⇒ 200.
- C3 race 2 request cùng code, barrier giữ cả hai SAU khi ký xong / trước consume (cả hai đã gọi `sign`) rồi thả ⇒ đúng 1×200 + 1×400 `invalid_grant`; 1 family; body bên thua không chứa `eyJ`; log capture không chứa `eyJ`.
- C4 race: ký lỗi ở A, B thành công ⇒ A 503, B 200; A retry ⇒ `invalid_grant`; 1 family.
- C5 refusal trước ký (vd. `resource` body khác; client không admin-capable + code `aud=admin`) ⇒ lỗi như hôm nay **và** code đã bị đốt (retry ⇒ `invalid_grant`), `sign` không được gọi.
- C6 binding sai (verifier/redirect sai) ⇒ `invalid_grant`, `sign` không được gọi, code còn nguyên (pin INV-13 cho `peek`).
- R1 refresh ký lỗi ⇒ 503; doc RT cũ `revokedAt:null`, `replacedBy:null`, không successor; `familyRevokedAt` null; retry **cùng RT** ⇒ 200; `TOKEN_REUSE_DETECTED` = 0.
- R2 reuse thật vẫn bị phát hiện: sau R1 retry thành công (RT0→RT1), replay RT0 ⇒ `invalid_grant` + family revoked + đúng 1 `TOKEN_REUSE_DETECTED`.
- R3 race 2 refresh cùng RT, barrier sau khi cả hai đã ký: thả A ⇒ A 200 (RT1); thả B ⇒ B 400 `invalid_grant`, `TOKEN_REUSE_DETECTED` = 1, family revoked (RT1 chết), body B không token. Thêm biến thể thả đồng thời: kỳ vọng như ma trận R1 (≤ 1×200, ≤ 1 successor dùng được, không có 2 doc con active cùng `parentId`, body thua không token).
- R4 family bị `/revoke` (hoặc logout sweep) trong cửa sổ ký (barrier) ⇒ `invalid_grant`, 0 reuse audit, không token.
- R5 pin đổi có chủ đích: `token-code-recheck.int-spec.ts › tester exposure: a refused refresh … never signs a token` đổi thành "never **returns** a token": bỏ `expect(sign).not.toHaveBeenCalled()`, thay bằng body không token + không `TOKEN_REFRESHED success` + log không `eyJ`; comment test ghi lý do (DEBT-388). Test DEBT-067 ngay dưới sửa tương tự.
- Giữ xanh: ma trận A1–A5, R1–R4, INV 1/2/10/11/13; `b73c-tester` R3 (Redis lỗi sau consume ⇒ 503, retry `invalid_grant`) vẫn đúng vì `sessions.exists` vẫn sau consume.

**Mutation bắt buộc** (ghi RED/GREEN vào log): (M1) code grant ký sau `consume` (thứ tự cũ) ⇒ C1 RED; (M2) refresh ký sau `rotate` ⇒ R1 RED; (M3) bỏ kiểm `consume` null (trả `signed` dù thua) ⇒ C3 RED; (M4) refresh nuốt lỗi miss của `rotate` và vẫn trả `signed` ⇒ R2/R3 RED; (M6) `peek` bỏ so binding ⇒ C6 RED (`sign` bị gọi); (M7) bỏ bất biến `raw` peek === consume ⇒ unit (Redis giả trả 2 giá trị khác) RED.

**Cổng security** (senior/tester đối chiếu): I1 mỗi code tối đa 1 bộ token rời server; I2 mỗi RT tối đa 1 successor dùng được; I3 token chỉ rời server khi commit thắng và mọi re-check sau commit đạt; I4 lỗi ký ⇒ 0 thay đổi trạng thái (code/RT/family/audit); I5 reuse sau rotate đã commit vẫn revoke family + alert. Cập nhật `security-matrix.md` dòng A1/A2/R1/R2 + INV 1/10/11 với tham chiếu test C1/C3/R1/R2/R3.

### F3 (Task 3, DEBT-398)

1. Guard là **bước đầu tiên** của stage `build` ở cả `be/Dockerfile` và `fe-admin/Dockerfile`, chạy trên bind mount của context (không tạo layer chứa file): `RUN --mount=type=bind,target=/ctx sh -ec '…'`, trước mọi `COPY`, nên không có layer/cache nào chứa secret. KHÔNG đặt sau `COPY be/ be/` như backlog gợi ý (lúc đó layer chứa secret đã vào cache, và `node_modules` đã cài có thể chứa `.pem`/`.npmrc` fixture ⇒ false positive).
2. Mẫu cấm (khớp tên, không đọc nội dung): `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `.npmrc`, thư mục `be/keys/` và `**/.keys/`. **Không** dùng `-path '*/keys/*'` (trúng `be/src/modules/keys/*`, `fe-admin/src/routes/keys/*`). Lỗi in tên file tương đối + exit ≠ 0; không `cat`.
3. Mutation: KHÔNG dùng `be/.env`/`be/keys` thật. Dựng context tạm trong scratchpad từ `git archive HEAD` + file canary nội dung giả (`CANARY=1`), dùng bản sao Dockerfile + `.dockerignore` đã bỏ dòng tương ứng ⇒ build **FAIL** với từng canary: `be/.env.production`, `be/x.pem`, `be/keys/k.json`, `be/sub/.npmrc` (fe-admin: `fe-admin/.env`, `fe-admin/.npmrc`). Đối chứng: context sạch ⇒ build qua (không false positive). Dọn image/cache canary theo đúng tag tạm; không `builder prune` toàn cục.
4. `runbook-deploy.md` §7 và §9: cấm `--cache-to …,mode=max` ra registry/ngoài máy build; build cần BuildKit (bind mount). CI hiện dùng `docker build` (BuildKit mặc định), smoke hiện có phải xanh.
