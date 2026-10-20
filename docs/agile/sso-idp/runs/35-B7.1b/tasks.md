# Tasks — run 35 — B7.1b: lỗi sản phẩm còn lại từ ma trận bảo mật

> Analyst, 2026-10-20. Tham chiếu: spec §9.1, §9.2, §9.4, §9.10, §14 (MT1/MT2), §15 (INV-5, INV-13, INV-24, INV-29); `security-matrix.md` dòng MT1/MT2/INV-24b; backlog DEBT-116/128/141/144/156/204/205; `runs/34-B7.1/review-techlead.md` (đề xuất run 35), `review-senior.md` (đánh giá DEBT-204/205).
> Tất cả task là [BE]. KHÔNG sửa spec.md/plan.md. Các mục "Việc cần người dùng quyết định" ở cuối file đã có **mặc định an toàn**. Dev làm theo mặc định đó. Nếu người dùng chọn khác thì chỉ phải đổi mã lỗi hoặc nhánh, không phải đổi thiết kế.

## Khảo sát code (thực tế tại `develop` @ `b2694ee`)

| Điểm | Hiện trạng (file:dòng) | Hệ quả |
|---|---|---|
| `GET /authorize` nhận `@Query() params: AuthorizeParams` | `authorize.controller.ts:64-87`. `AuthorizeParams` chỉ là interface (`authorize.service.ts:21`), không có kiểm runtime. Fastify trả **mảng** khi tham số bị lặp | DEBT-204/205: `scope`/`prompt` lặp gây TypeError ở `.split` (`validateScope:429`, `parsePrompt:471`) ⇒ 500. `state`/`nonce` lặp thì mảng đi thẳng vào context/code. `client_id` lặp ⇒ `findByClientId` (`findOne({clientId})`) bị cast thành `$in`. `request_id` lặp ⇒ `contexts.consume(mảng)` |
| `resource` lặp | `resolveResource:451` đã chặn ⇒ `invalid_target` (INV-15, run 34) | Giữ nguyên hành vi này (xem Q35.4) |
| Ranh giới tin `redirect_uri` | Phase 1 `handle:161-173` (`AuthorizeErrorPage` ⇒ trang 400), Phase 2 `handle:180-267` (`AuthorizeRedirectError` ⇒ 302 kèm `state`/`iss`, catch tại `:261-266` gắn `err.state = params.state`) | Mọi kiểm tham số lặp phải nằm đúng một trong hai pha |
| Membership tenant | `UserTenantService.isActiveMember(userId, tenantId)` (`user-tenant.service.ts:45`) chỉ được gọi ở `TenantGuard`/`AdminTokenGuard` | DEBT-116: `/authorize`, `POST /authorize/consent`, `/token` (code và refresh) không kiểm |
| Tenant của user mới | `register` ⇒ `addMembership(sub, DEFAULT_TENANT_ID)` (`authentication.service.ts:83`). Federation provision cũng vào `DEFAULT_TENANT_ID` (`federation.service.ts:365`). **Admin API không có endpoint thêm member** vào tenant khác (`admin-users.controller.ts` chỉ có lock/unlock/sessions/roles/families/consents) | Sau khi sửa DEBT-116, client ở tenant ≠ `default-tenant` chỉ dùng được với membership tạo bằng seed/DB (xem Q35.2) |
| Code grant `/token` | `token.controller.ts:137-258`: consume+bind ⇒ kiểm `sessionRef` trước (`:177-182`) ⇒ `issueForAuthorizationCode` (insert family) ⇒ kiểm lại session sau insert (`:197-238`) ⇒ audit success | Chỉ kiểm session. Chưa kiểm client còn enabled (DEBT-156), `redirect_uri` còn đăng ký (DEBT-128), consent còn hiệu lực (DEBT-144), user bị khoá (DEBT-141), membership (DEBT-116) |
| Thứ tự ghi ở phía "huỷ" | Disable client: `disabledAt` ⇒ `revokeForClient` (`admin-clients.controller.ts:185-200`). Lock: `lockedUntil` ⇒ `revokeAllUserCredentials` (`admin-users.controller.ts:141-150`). Revoke consent: `revokeById` ⇒ `revokeForConsent` (`admin-users.controller.ts:377-385`) | Cả ba đều **ghi trạng thái trước, quét family sau**. Vì vậy ở phía cấp, chỉ cần **insert family trước, đọc lại trạng thái sau** (cùng mẫu DEBT-051/INV-29) là không còn family nào sống sót, không cần lock phân tán |
| Refresh grant | `RefreshTokenService.issueForRefresh` (`refresh-token.service.ts:118+`): pre-check ⇒ `rotate` ⇒ sign ⇒ audit | Không kiểm lock, membership hay client còn enabled sau khi rotate (DEBT-141, DEBT-116; với client là race kiểu DEBT-156) |
| Login | `login` (`authentication.service.ts:107-175`): `clearFailedLoginsIfUnlocked` (DEBT-154) ⇒ `sessions.establish`. Federation `loginExisting` (`federation.service.ts:405-416`) kiểm lock **trước** `establish` (`:186`) | DEBT-141: lock xen giữa bước kiểm và `establish` ⇒ session mới tạo sau khi `revokeAllUserCredentials` đã chạy vẫn sống |
| Fixture int-test | Client trong int-spec dùng `tenant-A` (39 chỗ), `tenant-B` (9), `tenant-1` (6), `tenant-b` (1). User test thường chỉ có membership `default-tenant`, hoặc không có membership nào | Sau khi sửa DEBT-116, các luồng `/authorize`/`/token` dùng client tenant ≠ default sẽ đỏ. Phải bổ sung membership vào fixture (Task 2) |

## Nguyên tắc thiết kế chung (áp cho cả 5 task)

1. **Tenant chỉ lấy từ document client phía server** (`client.tenantId` do `findByClientId` trả về). Không bao giờ lấy từ query/body/session (INV-24, §9.10). `session.tenantId` (luôn là `DEFAULT_TENANT_ID`) **không** được dùng để quyết định.
2. **Không tự cấp membership** ở bất kỳ luồng OAuth nào. Tự cấp membership tức là để client đang được dùng quyết định user thuộc tenant nào, trái §9.10 "không được cấp quyền cho Client thuộc Tenant B dưới bất kỳ hình thức nào".
3. **Fail-closed**: lỗi Mongo/Redis ở mọi bước kiểm mới đều dẫn tới không cấp code/token và 500 (trang lỗi chung với `/authorize`, `server_error` với `/token`). Family vừa tạo (nếu có) bị revoke best-effort.
4. **Không phân biệt lý do ra ngoài**: `/token` luôn trả `invalid_grant` với body giống hệt nhau từng byte giữa các lý do. Lý do chi tiết chỉ nằm ở audit `reason` (không chứa secret/code/token, INV-20).
5. **Test âm + mutation**: mỗi kiểm mới phải có ít nhất một int-test đỏ khi xoá (hoặc vô hiệu) đúng dòng kiểm đó. Backend-dev ghi kết quả mutation (RED → GREEN) vào `log.md`.

---

### [x] Task 1 [BE]: Từ chối tham số OAuth bị lặp ở `/authorize` (DEBT-204, DEBT-205)

- **Liên quan**: spec §9.1, §9.2 bước 1, INV-3, INV-5, INV-15; RFC 6749 §3.1 ("parameters MUST NOT be included more than once"; tham số không nhận diện được thì bỏ qua).
- **Thiết kế**:
  - Tập tham số được nhận diện: `response_type, client_id, redirect_uri, scope, resource, state, nonce, code_challenge, code_challenge_method, prompt, max_age, request_id`. Tham số **ngoài tập này** bị lặp thì **bỏ qua** (RFC 6749 §3.1), không lỗi.
  - Một helper thuần (vd. `repeatedParam(params): string | undefined`) trả tên tham số đầu tiên trong tập có giá trị không phải `string`. Gọi helper ở **ba chỗ**, theo đúng ranh giới tin `redirect_uri`:
    1. Controller, trước `resume`: `request_id` không phải string ⇒ trang lỗi 400 giống `expiredPage` (chưa có `redirect_uri` để tin, không redirect).
    2. `AuthorizeService.handle` đầu Phase 1: `client_id` hoặc `redirect_uri` không phải string ⇒ `AuthorizeErrorPage('repeated_parameter')` (trang 400, **không redirect**). Bước này phải chạy **trước** `findByClientId`, để Mongoose không bao giờ nhận mảng (cast `$in`).
    3. Đầu Phase 2 (sau khi `redirect_uri` đã được tin), trước `response_type`: bất kỳ tham số nào trong tập (trừ `resource`, `client_id`, `redirect_uri`) không phải string ⇒ `AuthorizeRedirectError('invalid_request', 'Repeated parameter.')` ⇒ 302 về `redirect_uri` kèm `iss`.
  - `state`: chỉ echo khi `typeof params.state === 'string'`. Sửa catch tại `handle:263-264` để **không** gắn `state` dạng mảng. Nếu chính `state` bị lặp thì redirect lỗi **không có** `state` (IdP không chọn hộ RP một trong hai giá trị).
  - `resource` lặp giữ nguyên `invalid_target` (INV-15, RFC 8707 §2). Xem Q35.4.
  - `error_description` tĩnh, không echo tên hay giá trị tham số do client gửi.
- **Acceptance** (int-test, client public, có session sống, `be/test/authorize.int-spec.ts` hoặc file mới `authorize-params.int-spec.ts`):
  - `scope=a&scope=b` ⇒ **302** về `redirect_uri` với `error=invalid_request`, có `state` (string gốc), có `iss`. Không còn 500.
  - `prompt=login&prompt=none` ⇒ 302 `invalid_request` (không 500).
  - `nonce=x&nonce=y` ⇒ 302 `invalid_request`. Không tạo code, không tạo context: đếm key `authz_code:*` và `authz_ctx:*` trong Redis test trước/sau không đổi. Cách đếm theo prefix thực tế trong `authorization-code.service.ts`/`authorize-request-context.service.ts`.
  - `state=a&state=b` ⇒ 302 `invalid_request`, URL redirect **không có** tham số `state`.
  - `code_challenge`, `code_challenge_method`, `response_type`, `max_age` lặp ⇒ 302 `invalid_request` (các trường hợp đang trả 302 lỗi khác nay thống nhất về `invalid_request`).
  - `client_id=c&client_id=c2` ⇒ **400** trang lỗi, header `Location` vắng mặt, `findByClientId` không được gọi với mảng (spy).
  - `redirect_uri` lặp (cả hai giá trị đều đã đăng ký) ⇒ 400 trang lỗi, không có `Location`.
  - `request_id=a&request_id=b` ⇒ 400 trang lỗi, không gọi `contexts.consume` (spy).
  - `resource` lặp ⇒ vẫn `invalid_target` (test run 34 giữ xanh).
  - `utm=1&utm=2` (tham số lạ) kèm request hợp lệ ⇒ luồng bình thường (200 consent hoặc 302 code).
  - Unit test cho helper: mỗi key trong tập, giá trị string/undefined/array.
- **Test âm + mutation**: (a) bỏ kiểm Phase 2 ⇒ test `scope` lặp trả 500 (RED). (b) bỏ kiểm Phase 1 ⇒ test `client_id` lặp không còn 400 trang lỗi, hoặc spy thấy mảng (RED). (c) bỏ điều kiện `typeof state === 'string'` ở catch ⇒ test `state` lặp thấy `state` trong URL (RED).
- **Security invariants**:
  - *Tài sản*: `redirect_uri` (open redirect, INV-3), tính toàn vẹn của `state`/`nonce` (INV-5).
  - *Actor*: attacker tự soạn URL `/authorize`.
  - *Invariant*: khi `redirect_uri` chưa được tin thì không redirect. Mảng không bao giờ tới truy vấn Mongo hay lưu trữ code/context. `nonce` trong ID token luôn là string đúng bằng giá trị RP gửi.
  - *Failure*: tham số lặp ⇒ fail-closed (không code, không context), không 500.
  - *Exposure*: `error_description` tĩnh, không echo input. Trang 400 không lộ stack.
- **Phụ thuộc**: không.

### [x] Task 2 [BE]: Kiểm membership tenant ở `/authorize` và `POST /authorize/consent` (DEBT-116 phần authorize/consent; ma trận MT1, MT2, INV-24b)

- **Liên quan**: spec §9.10, §9.4, §14 MT1/MT2, INV-24.
- **Thiết kế**:
  - `AuthorizeService.handle`: ngay sau `hasSession === true` (sau quyết định login, **trước** `consents.find`, trước nhánh `prompt=none ⇒ consent_required`): `await memberships.isActiveMember(session.userId, client.tenantId)`. Kết quả false ⇒ `AuthorizeRedirectError('access_denied', 'Access denied.')` (Q35.1), cộng audit `OAUTH_AUTHORIZE` với `metadata.outcome = 'not_member'` (có sẵn `tenantId: client.tenantId`). Không gọi `consents.find`/`createContext`/`issueCode`.
  - Chưa có session thì giữ luồng login như cũ. Sau khi login, `resume()` gọi lại `handle()` nên tự đi qua kiểm này.
  - `decideConsent`: sau bước re-resolve client (`:309-321`), **trước** `consents.grant`: không phải member ⇒ ném `AuthorizeRedirectError('access_denied')` có `redirectUri = ctx.redirectUri` và `state = ctx.originalState` (redirect_uri đã được kiểm lại ngay trên). Không ghi `Consent`, không cấp code. Với `approve=false`, giữ nguyên hành vi `access_denied` hiện tại.
  - **Không** auto-provision membership ở bất kỳ đâu. Inject `UserTenantService` vào `AuthorizeService` (module `identity` đã export, `federation`/`authentication` đang dùng).
  - **Cập nhật fixture**: mọi int-spec drive `/authorize` hoặc `/token` (code/refresh) với client tenant ≠ `default-tenant` phải tạo membership `active` cho user test ở đúng `client.tenantId`. Ưu tiên helper chung trong `be/test/` thay cho sửa rải rác. Không đổi tenant của client trong test chỉ để né kiểm (làm vậy sẽ mất phủ cross-tenant).
- **Acceptance** (int, file mới `be/test/oauth-tenant-isolation.int-spec.ts`; dòng MT1/MT2/INV-24b của ma trận trỏ vào đây):
  - MT1: user U chỉ là member `tenant-A`, client C ở `tenant-B`, session sống ⇒ `/authorize` trả 302 `error=access_denied` kèm `state`/`iss`. Redis không có code/context mới. Audit có `outcome:'not_member'`, `tenantId:'tenant-B'`.
  - MT1 (prompt=none): như trên kèm `prompt=none` ⇒ `access_denied` (không phải `consent_required`).
  - MT1 (consent cũ): U có `Consent` cho C còn hiệu lực (seed trực tiếp) nhưng không phải member ⇒ vẫn `access_denied`, không có code.
  - Membership `suspended` ở `tenant-B` ⇒ `access_denied`.
  - MT2: U mở trang consent khi còn là member, rồi membership chuyển `suspended`, rồi POST approve ⇒ 302 `access_denied`. Collection `consents` không có document mới hoặc cập nhật cho (U, C), không có code.
  - Đối chứng dương: U là member `active` của `tenant-B` ⇒ 200 consent, sau đó code như cũ.
  - User mới đăng ký (membership duy nhất là `default-tenant`) với client `default-tenant` ⇒ luồng bình thường. Với client `tenant-B` ⇒ `access_denied` và **không** có `UserTenant` mới cho `tenant-B` (đếm document trước/sau).
  - Lỗi DB ở `isActiveMember` (stub ném) ⇒ 500 trang lỗi chung, không code, không context.
  - Toàn bộ `pnpm -C be test:int` xanh sau khi cập nhật fixture. E2E (`default-tenant`) không đổi.
- **Test âm + mutation**: (a) xoá kiểm ở `handle` ⇒ MT1 nhận 200/code (RED). (b) xoá kiểm ở `decideConsent` ⇒ MT2 ghi consent và cấp code (RED). (c) đổi tenant sang `session`/`DEFAULT_TENANT_ID` thay cho `client.tenantId` ⇒ đối chứng tenant-B member hoặc MT1 đỏ.
- **Security invariants**:
  - *Tài sản*: code/consent cho client tenant B.
  - *Actor*: user tenant A (owner của chính mình nhưng khác tenant), RP tenant B, attacker điều khiển RP.
  - *Invariant*: không có code hay consent cho (user, client) khi user không `active` ở `client.tenantId`. Tenant chỉ lấy từ client document.
  - *State*: session sống ⇒ `/authorize` ⇒ kiểm membership ⇒ (fail) redirect `access_denied`, không ghi. Context consent tồn tại ⇒ membership đổi ⇒ POST ⇒ kiểm lại ⇒ không ghi.
  - *Abuse*: IDOR/cross-tenant qua `client_id` của tenant khác. Race "suspend giữa render và POST" do kiểm lại ở POST xử lý. Enumeration: `access_denied` trùng mã với user tự từ chối nên RP không học được gì ngoài user của chính nó.
  - *Exposure*: không đưa `tenantId` hay lý do vào URL redirect hay `error_description`. Lý do chỉ ghi ở audit.
- **Phụ thuộc**: Task 1 (cùng sửa `handle`; làm tuần tự để tránh conflict).

### [x] Task 3 [BE]: Gom kiểm lại ở code grant `/token` vào một chỗ (DEBT-116 phần /token, DEBT-128, DEBT-144, DEBT-156, DEBT-141 phần code grant)

- **Liên quan**: spec §9.2 bước 5, §9.4, §9.5, §9.10, INV-13, INV-24, INV-29.
- **Thiết kế**:
  - Thêm **một** hàm duy nhất (vd. `CodeGrantRecheck.check(clientId, data): Promise<RecheckFailure | null>`, đặt trong `oauth/token/`). Hàm đọc trạng thái **hiện tại** và trả lý do fail đầu tiên theo thứ tự cố định:
    1. `client_disabled`: `clients.findByClientId(clientId)` trả null (đã lọc `disabledAt:null`).
    2. `redirect_uri_unregistered`: `!isRegisteredRedirectUri(fresh.redirectUris, data.redirectUri)`.
    3. `user_locked`: `users.findById(data.userId)` null, hoặc `lockedUntil > now`.
    4. `not_member`: `!memberships.isActiveMember(data.userId, fresh.tenantId)` (tenant lấy từ client **vừa đọc lại**).
    5. `consent_revoked`: `!consents.isCovered(await consents.find(userId, clientId, data.resource), scopes(data.scope), consents.currentVersions())` (Q35.5).
  - Gọi hàm này **đúng một lần, sau** `issueForAuthorizationCode` (sau khi insert family), ngay sau khối kiểm lại session hiện có (`token.controller.ts:197-238`, giữ nguyên ngữ nghĩa và audit `session_ended`/`session_check_failed`). Lý do chọn "sau insert": phía huỷ (disable/lock/revoke consent) đều ghi trạng thái trước rồi mới quét family. Do đó "insert rồi đọc lại" bảo đảm mọi interleaving đều có một bên bắt được (cùng lập luận với DEBT-051/INV-29). Không thêm pre-check trùng lặp. Pre-check session (`:177-182`) giữ nguyên vì INV-29 yêu cầu.
  - Fail ⇒ nếu có `familyId` thì `refresh.revokeFamily(familyId, client.clientId, now)`, sau đó **đúng một** `TOKEN_ISSUED failure` với `reason` = lý do, rồi `TokenError('invalid_grant')`. Lỗi hạ tầng trong hàm ⇒ revoke family best-effort, ghi `TOKEN_ISSUED failure reason:'recheck_failed'` best-effort, ném lại lỗi ⇒ 500 (copy mẫu `session_check_failed`).
  - Code đã consume trước đó nên vẫn single-use (INV-1/INV-13 không đổi).
- **Acceptance** (int, `be/test/token-code-recheck.int-spec.ts`). Mỗi case: `/authorize` cấp code hợp lệ (có `offline_access` để có family) ⇒ thay đổi trạng thái ⇒ `/token`:
  - DEBT-156: disable client (qua admin API hoặc `updateOne disabledAt`) trước `/token` ⇒ `invalid_client` hoặc `invalid_grant` do client auth (hành vi hiện có). **Race**: spy `tokens.issueForAuthorizationCode` để chạy disable + `revokeForClient` ngay sau khi insert ⇒ response `invalid_grant`, `refreshtokens` của family đó có `revokedAt != null`, audit `reason:'client_disabled'`.
  - DEBT-128: xoá `redirect_uri` khỏi client sau khi cấp code ⇒ `invalid_grant`, family (nếu đã insert) bị revoke, `reason:'redirect_uri_unregistered'`.
  - DEBT-144: revoke consent (admin `DELETE .../consents/:id`) sau khi cấp code ⇒ `invalid_grant`, `reason:'consent_revoked'`, không family nào sống. Kèm biến thể race qua spy như DEBT-156.
  - DEBT-141 (code): lock user (admin `POST /users/:id/lock`) sau khi cấp code ⇒ `invalid_grant` (lock revoke session nên có thể rơi vào `session_ended`, chấp nhận cả hai `reason`). Biến thể race: spy cho lock **chỉ ghi `lockedUntil`** (chưa sweep) sau insert ⇒ `reason:'user_locked'`, family revoked.
  - DEBT-116 (/token): membership chuyển `suspended` sau khi cấp code ⇒ `invalid_grant`, `reason:'not_member'`.
  - Body lỗi của mọi case trên **giống hệt nhau từng byte** (so chuỗi) và giống `invalid_grant` của code sai.
  - Stub `memberships.isActiveMember` ném lỗi ⇒ 500, không token, family revoked, audit `recheck_failed`.
  - Đối chứng dương: không đổi gì ⇒ 200 như cũ, đúng **một** `TOKEN_ISSUED success`.
- **Test âm + mutation**: vô hiệu từng nhánh (1)–(5) (trả `null`) ⇒ đúng case tương ứng đỏ. Xoá lời gọi `check` ⇒ toàn bộ case race đỏ. Ghi bảng mutation 5 dòng vào log.
- **Security invariants**:
  - *Tài sản*: refresh family/AT/ID token.
  - *Actor*: RP (confidential/public) giữ code ≤60s, admin đang disable/lock/revoke đồng thời.
  - *Invariant*: không có token trả ra và không family nào còn sống nếu tại thời điểm sau insert client đã disabled, redirect_uri đã gỡ, consent đã revoke, user đã khoá, hoặc membership không active.
  - *State*: consume code ⇒ check session ⇒ insert family ⇒ check session ⇒ check (1..5) ⇒ audit success ⇒ 200.
  - *Failure*: Mongo/Redis down ⇒ 500 fail-closed.
  - *Residual chấp nhận*: AT đã phát trước khi disable/lock vẫn verify ở resource ≤15' (DEBT-156 phần 3, giữ mở). Disable rồi enable lại trong ≤60s thì code cũ đổi được (Q35.6).
  - *Exposure*: `reason` chỉ ở audit, không có code/token/secret.
- **Phụ thuộc**: Task 2 (membership fixture + inject `UserTenantService`).

### [ ] Task 4 [BE]: Refresh grant và login kiểm lại sau khi ghi (DEBT-141 phần refresh/login, DEBT-116 phần refresh, race disable ở refresh)

- **Liên quan**: spec §9.5, §9.10, §9.8, INV-10/11/12, INV-24.
- **Thiết kế**:
  - **Refresh**: trong `issueForRefresh`, **sau** `rotate` thành công và **trước** khi sign: đọc lại (a) `findByClientId(clientId)` khác null, (b) user tồn tại và `lockedUntil` không `> now`, (c) `isActiveMember(result.userId, fresh.tenantId)`. Fail ⇒ revoke cả family (`revokeFamily(result.familyId…)`, kiểm tên field trong `rotate`) + audit `TOKEN_REVOKED`/`TOKEN_REFRESH_FAILED` theo enum hiện có với `reason` ∈ {`client_disabled`,`user_locked`,`not_member`} + `RefreshRotationError` ⇒ `invalid_grant` (Q35.3). Lỗi hạ tầng ⇒ revoke best-effort, 500. Có thể tái dùng các nhánh (1)(3)(4) của hàm ở Task 3 nếu tách được gọn. **Không** kiểm consent ở refresh (tránh nâng `policyVersion` làm chết mọi family. Revoke consent đã quét family).
  - **Login (password)**: trong `login`, sau `sessions.establish`: đọc lại user. `lockedUntil > now` ⇒ `sessions.revoke(established.session.id, { tombstone: true })` (dùng đúng id/ref API yêu cầu), audit `AUTH_LOGIN_FAILED reason:'invalid_credentials'` như các nhánh fail khác, `UnauthorizedException(GENERIC_LOGIN_ERROR)`. Không có `SESSION_CREATED`/`AUTH_LOGIN_SUCCESS`.
  - **Login (federation)**: tương tự sau `establish` ở `federation.service.ts:186` ⇒ revoke session + `FederationError('account_locked')` (cùng trang lỗi hiện có cho user khoá).
- **Acceptance** (int):
  - Refresh, race lock: spy `rotate` để sau khi rotate admin ghi `lockedUntil` (không sweep) ⇒ `invalid_grant`, mọi doc của family có `revokedAt != null`, không có AT trả về.
  - Refresh, race disable: spy để `disabledAt` được đặt sau rotate ⇒ `invalid_grant`, family revoked.
  - Refresh, membership `suspended` ⇒ `invalid_grant`, family revoked. Lần refresh tiếp theo bằng token cũ ⇒ `invalid_grant` (không mở lại).
  - Body lỗi giống hệt từng byte giữa ba lý do và giống `invalid_grant` của token rác.
  - Đối chứng dương: refresh bình thường vẫn rotate và trả 200, test `refresh-token.int-spec` R1/R2 xanh.
  - Login race: spy `sessions.establish` để chạy admin lock (ghi `lockedUntil` + `revokeAllUserCredentials`) **trước khi** `establish` trả về ⇒ HTTP 401 thông điệp chung giống hệt sai mật khẩu, `sessions.exists(ref)` false, không có cookie session hợp lệ, không có audit `AUTH_LOGIN_SUCCESS`.
  - Federation race tương tự ⇒ trang lỗi account_locked, session vừa tạo không còn tồn tại.
- **Test âm + mutation**: xoá từng kiểm (refresh-lock, refresh-client, refresh-member, login post-check, federation post-check) ⇒ đúng test tương ứng đỏ. Ghi vào log.
- **Security invariants**:
  - *Tài sản*: session, refresh family.
  - *Actor*: user bị khoá hoặc mất membership, client bị disable, admin thao tác đồng thời.
  - *Invariant*: sau khi admin lock hoặc disable hoàn tất, không còn session hay family nào sống của user/client đó, bất kể interleaving (phía huỷ ghi trước rồi quét; phía cấp ghi trước rồi đọc lại).
  - *Failure*: lỗi DB ⇒ fail-closed (500 cho refresh; login fail ⇒ 401/500 không session).
  - *Enumeration*: login vẫn một thông điệp chung (INV-27).
  - *Exposure*: không log token/mật khẩu (INV-20).
- **Phụ thuộc**: Task 2 (membership). Có thể làm song song Task 3 nếu không chạm cùng file. Nên làm sau Task 3 để tái dùng hàm kiểm.

### [x] Task 5 [BE]: Cập nhật ma trận bảo mật và backlog, chạy toàn bộ suite

- **Liên quan**: `security-matrix.md` (MT1, MT2, dòng 24b, bảng tổng), `backlog.md`.
- **Việc**: chuyển MT1/MT2/INV-24b từ `lỗi sản phẩm` sang `có`, dẫn tên test thật (`file › tên test`). Cập nhật bảng đếm. Thêm cột hoặc ghi chú cho DEBT-128/141/144/156/204/205 trỏ test Task 1/3/4. Đánh dấu các DEBT đã đóng (dev điền). Mở DEBT mới cho: admin API thêm member vào tenant (nếu Q35.2 giữ mặc định), DEBT-156 phần AT ≤15' (giữ mở), residual Q35.6.
- **Acceptance**: `pnpm -C be test` + `pnpm -C be test:int` xanh, số test tăng ≥ tổng test mới ở Task 1–4. `pnpm -C fe-sso-test test` không đổi. E2E `pnpm -C e2e e2e` 16/16 (hạ tầng do người dùng chỉ định, không FLUSH). Ma trận không còn dòng `lỗi sản phẩm` nào trỏ DEBT-116. Mọi test được dẫn trong ma trận tồn tại (grep tên).
- **Security invariants**: N/A, chỉ tài liệu và chạy test, không chạm trust boundary.
- **Phụ thuộc**: Task 1–4.

---

## Việc cần người dùng quyết định (đã có mặc định an toàn, dev làm theo mặc định)

| # | Câu hỏi | Mặc định (đang áp dụng) | Lý do | Phương án khác |
|---|---|---|---|---|
| Q35.1 | User có session nhưng không phải member `active` của `client.tenantId`: lỗi gì, ở đâu? | 302 về `redirect_uri` (đã tin) với `error=access_denied` + `state` + `iss`. Kiểm ngay sau khi có session, trước consent và trước `prompt=none ⇒ consent_required` | `redirect_uri` đã được tin nên redirect là đúng RFC 6749 §4.1.2.1. `access_denied` trùng mã với "user từ chối" nên RP không phân biệt được lý do (không enumeration). RP chỉ biết về user của chính nó | Trang lỗi first-party 400 (user thấy lý do, RP không nhận được phản hồi và treo luồng) |
| Q35.2 | User mới đăng ký/federated chỉ thuộc `default-tenant`. Client tenant khác xử lý ra sao? Có tự cấp membership không? | **Không tự cấp.** Bị `access_denied`. Mở DEBT mới: admin API thêm/mời member vào tenant (hiện chưa có endpoint, nên client tenant ≠ default chỉ dùng được qua seed/DB) | §9.10 cấm cấp quyền cho client tenant khác "dưới bất kỳ hình thức nào". Tự cấp membership theo client tức là tin client quyết định tenant (trái INV-24) | Cho phép tenant bật cờ "open registration" (tenant-level policy) để tự join. Cần sửa spec, ngoài run 35 |
| Q35.3 | Refresh khi user bị khoá, mất membership, hoặc client bị disable | Revoke **cả family** + `invalid_grant` | Fail-closed, đồng nhất với lock/disable (vốn đã quét family). Đơn giản, không để family "ngủ" chờ kích hoạt lại | Chỉ từ chối, không revoke (membership được khôi phục thì family dùng lại được) |
| Q35.4 | `resource` lặp: giữ `invalid_target` hay đổi sang `invalid_request` như tham số khác? | Giữ `invalid_target` | RFC 8707 §2: AS không hỗ trợ nhiều resource thì trả `invalid_target`. Không làm hồi quy test INV-15 run 34 | Thống nhất `invalid_request` (phải sửa test run 34 và ma trận INV-15) |
| Q35.5 | Code grant: consent "còn hiệu lực" có tính `policyVersion`/`termsVersion` không? | Có. Dùng `isCovered` đầy đủ, nên bump version trong ≤60s làm code đang chờ thành `invalid_grant` | Cùng định nghĩa "covered" với `/authorize` (§9.4). Fail-closed. Ảnh hưởng tối đa 60s | Chỉ kiểm `revokedAt` (ít gián đoạn hơn khi deploy bump version) |
| Q35.6 | Residual chấp nhận: disable rồi enable lại client trong ≤60s thì code mint trước disable vẫn đổi được. AT đã phát vẫn verify ≤15' | Chấp nhận, ghi DEBT. Không lưu lịch sử `disabledAt` | Cửa sổ ngắn, cần quyền admin. Đóng hẳn cần so `code.createdAt` với lịch sử disable (thêm schema) | Lưu `disabledEpoch` trên client và nhúng vào code |

---

## Fold tech-lead (2026-10-20) — ưu tiên hơn text cũ ở trên

> Review: `review-techlead.md` (PASS kèm fold). Đối chiếu code `develop` @ `b2694ee`.

**F0. Phạm vi run 35 = Task 1, 2, 3, 5. Task 4 TÁCH sang run 36 (DEBT-207).** Lý do: kiểm lại `user_locked`/`not_member` ở code grant (T3) làm đỏ mọi test đổi code bằng `userId` ngẫu nhiên không có User/UserTenant thật (`token.int-spec` 33 lần mint code + 12 userId ngẫu nhiên, `refresh-token.int-spec` 13 + 15, `session-reflection`, `client-auth-rate-limit`, `admin-*`), cộng ~55 chỗ client tenant ≠ default của T2. T4 thêm `refresh-token.int-spec` (insert family trực tiếp với userId ngẫu nhiên) và hai module khác (authentication, federation). Gộp cả bốn task vượt một run. Thiết kế T4 giữ nguyên làm đầu vào run 36, Q35.3 giữ mặc định.

**F1. Task 0 (gộp vào đầu T2) — helper fixture chung.** Tạo `be/test/oauth-fixtures.ts` (một file, hàm thuần) `seedOAuthUser(models, { tenantId, status?: 'active'|'suspended', lockedUntil?: Date }) => userId` tạo User (email duy nhất, đã verify, không khoá) + UserTenant. Mọi helper `mintCode`/luồng `/authorize` → `/token` code trong int-spec dùng `userId` từ helper với `tenantId = client.tenantId` thay cho `new Types.ObjectId().toHexString()`. Chỉ sửa userId ở các test **đi qua code grant hoặc /authorize có session**; test chỉ chạm service khác (vd. `revokeForSession`, introspect) giữ nguyên. Không đổi tenant của client để né kiểm.

**F2. DI.** `OauthModule.imports` thêm `IdentityModule` (IdentityModule chỉ import SessionsModule ⇒ không vòng). **Không thêm class provider mới** (`CodeGrantRecheck` bỏ): hàm kiểm lại T3 là method private của `TokenController` (vd. `recheckCodeGrant(client, data)`), inject thêm `ClientService`, `UserService`, `UserTenantService`, `ConsentService` vào constructor `TokenController`. `AuthorizeService` inject thêm `UserTenantService`. Các int-spec tự liệt kê `providers` có `TokenController`/`AuthorizeService` mà thiếu `UserService`/`UserTenantService` phải thêm (vd. `token`, `client-auth-rate-limit`, `ui`, `ui-auth`, `session-reflection`); `authorize.int-spec` gọi `new AuthorizeService(...)` thủ công ⇒ thêm tham số.

**F3. T1 — helper tham số lặp.** Hợp lệ khi `v === undefined || typeof v === 'string'`; mọi giá trị khác (mảng, object) ⇒ lặp. Kiểm Phase 2 đặt **đầu** khối `try` (trước `response_type`). Catch ở `handle` chỉ gán `err.state` khi `typeof params.state === 'string'`. Không đổi `error_description` hiện có của các nhánh khác (ngoài phạm vi). `POST /authorize/consent` đã an toàn (`ConsentDto.request_id` có `@IsString()`), `/token` đã an toàn (`parseForm` từ chối tham số lặp) ⇒ không đụng.

**F4. T2 — audit.** Nhánh `not_member` ghi `OAUTH_AUTHORIZE` với `result: 'failure'`, `reason: 'not_member'`, `tenantId: client.tenantId`, `metadata.outcome: 'not_member'` (thêm tham số `result` tuỳ chọn cho `recordAuthorize`, mặc định `'success'`). Dùng cùng audit này cho nhánh `not_member` trong `decideConsent`. Acceptance MT1 kiểm `result:'failure'`.

**F5. T2 — `decideConsent`.** Kiểm membership đặt **sau** khối re-resolve client (giữ nhánh `return null` ⇒ trang lỗi first-party khi client disable/redirect_uri gỡ) và **trước** `consents.grant`, dùng `client.tenantId` của client vừa đọc lại. `approve=false` không đổi.

**F6. T3 — thứ tự và lỗi.** Giữ 5 nhánh theo thứ tự analyst (client → redirect_uri → user → membership → consent), chạy **một lần sau** khối kiểm lại session hiện có. Nhánh fail: revoke family nếu có, ghi **đúng một** `TOKEN_ISSUED failure reason:<lý do>`; nếu revoke ném thì vẫn ghi audit best-effort rồi ném lại (mẫu DEBT-067) ⇒ 500. Nhánh `consent_revoked` cũng bắt trường hợp client mất scope giữa render và POST consent (code mang `ctx.scope`, consent bị `$setIntersection` với `client.scopes`) ⇒ fail-closed đúng ý, không cần test riêng. Kiểm resource còn được phép ⇒ **không** làm ở run này (DEBT-210).

**F7. T3 — fixture race.** Spy `TokenService.issueForAuthorizationCode` lấy từ `app.get(TokenService)`; trong spy gọi bản gốc rồi mới đổi trạng thái (để family đã insert). Biến thể lock "chỉ ghi `lockedUntil`" dùng `updateOne` trực tiếp, không qua admin API.

**F8. Task 5 — điều chỉnh.** MT1/MT2/24b ⇒ `có` (authorize + consent + code grant), ghi chú "refresh → DEBT-207 (run 36)". DEBT-116: đóng phần authorize/consent/code grant, phần refresh trỏ DEBT-207. DEBT-141: đóng phần code grant, phần refresh/login trỏ DEBT-207. DEBT-156: đóng phần race insert family; phần AT ≤15' giữ mở; re-enable ≤60s ⇒ DEBT-209. DEBT-128/144/204/205: đóng nếu test xanh. Mở DEBT mới đã được tech-lead tạo sẵn: 207 (T4), 208 (admin API member, Q35.2), 209 (Q35.6), 210 (resource ở code grant). Acceptance "không còn dòng `lỗi sản phẩm` trỏ DEBT-116" thay bằng "MT1/MT2/24b `có`; mọi tham chiếu DEBT-116 còn lại trỏ DEBT-207".

**F9. Quyết định Q35.x.** Chấp nhận mặc định Q35.1, Q35.2, Q35.4, Q35.5, Q35.6. Q35.3 giữ mặc định cho run 36. Không mục nào cần người dùng quyết định (đều suy ra từ spec §9.10/§9.4, RFC 6749 §4.1.2.1, RFC 8707 §2). Thông báo cho người dùng hệ quả Q35.2 (DEBT-208).
