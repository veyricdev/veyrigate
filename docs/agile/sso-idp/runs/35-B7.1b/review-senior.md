# Senior Review — 2026-10-20

Run 35 (B7.1b), diff chưa commit kể từ `b2694ee` trong `be/` + docs (bỏ qua `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`). Đọc qua CodeGraph: `AuthorizeController.handle/consent/handleError/buildRedirect/buildErrorRedirect`, `AuthorizeService.handle/resume/decideConsent/assertMember/recordAuthorize`, `repeatedParam`, `TokenController.handleAuthorizationCodeGrant/recheckCodeGrant`, `ConsentService.find/isCovered`, `UserService.findById`, `UserTenantService.isActiveMember`, `AdminTokenGuard`, `isAccessTokenLive`, `RefreshTokenService.revokeFamily`; fixture `be/test/oauth-fixtures.ts` và diff của 13 int-spec, 3 int-spec mới, 1 unit spec.

Kiểm chứng tự chạy: `pnpm -C be typecheck` OK; `pnpm -C be test` 317/317 (26 suites); `pnpm -C be test:int` lọc 8 suite (`oauth-tenant-isolation|token-code-recheck|authorize-params|authorize.int|federation|admin.int|admin-users|admin-keys`) 279/279. Không chạy E2E.

## Kết luận: PASS

Không có 🔴. Còn 3 🟡 (ghi vào backlog DEBT-211…213) và vài 💭.

## Tổng quan (ấn tượng chung + điểm tốt)

- T1 đặt mỗi lần kiểm đúng phía của ranh giới tin `redirect_uri`. `request_id` lặp bị chặn ở controller trước `resume` nên `consume` không bao giờ nhận mảng. `client_id`/`redirect_uri` lặp bị chặn trước `findByClientId`, nên Mongoose không cast mảng thành `$in` và không có redirect khi chưa tin được `redirect_uri`. Các tham số còn lại bị chặn ở đầu Phase 2 (trước `response_type`), nên `scope`/`prompt` lặp không còn gây 500, và `nonce`/`state` dạng mảng không đi vào context hay code. Catch chỉ gắn `state` khi là string, nên IdP không chọn hộ RP một trong hai giá trị `state`. `resume` dựng params từ context (toàn string), nên Phase 2 trên đường resume không bao giờ thấy mảng.
- T2 lấy tenant **chỉ** từ document client (`client.tenantId`): ở `handle` là client vừa lookup, ở `decideConsent` là client vừa re-resolve. `session.tenantId` không được dùng. Kiểm membership nằm sau quyết định login và **trước** `consents.find`, nhánh covered và nhánh `prompt=none ⇒ consent_required`, nên mọi đường cấp code ở `/authorize` (covered, `prompt=none`, resume sau login) đều đi qua nó. Ở `decideConsent`, kiểm nằm sau khối re-resolve (giữ trang lỗi first-party khi client bị disable hoặc `redirect_uri` bị gỡ) và trước `consents.grant`. Không có chỗ nào tự cấp membership. Lỗi DB ở `isActiveMember` lan ra thành 500 (fail-closed), có test.
- T3 dùng đúng mẫu stamp-first: phía huỷ ghi trạng thái trước rồi quét family (disable `disabledAt` ⇒ `revokeForClient`, lock `lockedUntil` ⇒ `revokeAllUserCredentials`, revoke consent `revokeById` ⇒ `revokeForConsent`), phía cấp insert family trước rồi đọc lại. Nên với mọi interleaving, hoặc sweep bắt được family, hoặc lần đọc lại thấy trạng thái mới. Kiểm lại chạy sau khối session INV-29 có sẵn, theo thứ tự cố định. Tenant lấy từ client vừa đọc lại. Consent dùng `isCovered` đầy đủ (Q35.5). Mọi lý do đều trả `TokenError('invalid_grant')`, cùng lớp lỗi với code sai, và có test so body từng byte. Lỗi hạ tầng thì revoke best-effort, ghi audit `recheck_failed` best-effort, rồi 500. Nhánh fail giữ audit cả khi revoke ném (mẫu DEBT-067).
- Test có giá trị phòng thủ thật: race qua spy `issueForAuthorizationCode` (gọi bản gốc rồi mới đổi trạng thái), có biến thể chỉ ghi trạng thái mà không sweep để chứng minh chính lần kiểm lại revoke family, có test lock đã hết hạn không chặn, có test code vẫn single-use sau khi bị từ chối, và log ghi mutation đầy đủ cho từng nhánh.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| Không cấp code cross-tenant ở `/authorize`: phiên mới, consent có sẵn (covered), `prompt=none`, resume sau login | Đạt | `assertMember` ở `authorize.service.ts:274` đứng trước `consents.find` (`:280`), trước nhánh covered (`:283`) và `prompt=none` (`:292`). `resume` gọi lại `handle`. Test: `oauth-tenant-isolation › MT1`, `› MT1 + prompt=none`, `› MT1 with a still-valid consent`, `› SUSPENDED membership` |
| Không ghi consent hay cấp code ở POST consent khi membership mất giữa render và submit | Đạt | `authorize.service.ts:377-387`, trước `consents.grant` (`:390`). Test `› MT2` đếm consent, code và audit |
| Không có token hoặc family sống ở code grant cross-tenant hay sau disable/lock/revoke consent/gỡ redirect_uri | Đạt | `token.controller.ts:257-285` + `recheckCodeGrant:307`. Test `token-code-recheck` (16 case, có race) |
| Tenant chỉ từ client document | Đạt | `client.tenantId` (handle), client re-resolve (decideConsent), `fresh.tenantId` (recheck). Mutation "tenant=default" ⇒ 3 RED (log) |
| Không tự cấp membership | Đạt | Không có lời gọi `addMembership` mới. Test `› a new user (default-tenant only) …` đếm `UserTenant` |
| Fail-closed khi hạ tầng lỗi | Đạt | `/authorize`: `isActiveMember` ném ⇒ 500, không code/context (test). `/token`: ném ⇒ revoke family + `recheck_failed` + 500 (test) |
| Oracle `/token`: `invalid_grant` giống nhau mọi lý do | Đạt | Một `TokenError('invalid_grant')`. Test `› every refusal body is byte-identical …` |
| Oracle `/authorize`: `access_denied` không phân biệt với user tự từ chối | **Một phần** (🟡 DEBT-211) | Mã lỗi trùng, nhưng `error_description` khác (xem 🟡 1) |
| Ranh giới tin `redirect_uri` (Phase 1 trang 400, Phase 2 302) | Đạt | `authorize-params › client_id repeated`, `› redirect_uri repeated` (không có `Location`), `› request_id repeated` (spy `consume`) |
| `state` lặp không bị echo | Đạt | `authorize.service.ts:319`. Test `› state=a&state=b … WITHOUT any state` |
| Exposure: tenant/lý do không lộ trong redirect/body | Đạt | `expectAccessDenied` loại trừ `tenant-B`/`member`. Lý do chỉ ở audit (`reason`/`metadata.outcome`). Body 500 không chứa chi tiết lỗi |
| Audit `not_member` | Đạt | `OAUTH_AUTHORIZE result:'failure' reason:'not_member' tenantId` (F4) |

Fixture có che lỗi thật không:
- `admin.int-spec` dùng token ký tay cho suspended/outsider: hợp lệ về ngữ nghĩa. Helper `signed` ký đúng `typ at+jwt`, `aud=admin`, `client_id=CLIENT_A`, `sid` 64-hex. Liveness chỉ từ chối `sid` có tombstone, không đòi session tồn tại. Test đối chứng cùng shape với admin trả 200 (`admin.int-spec.ts:452`). Do đó 403 đến đúng từ `activeRoles` của guard, tức defence-in-depth vẫn được phủ. Việc `/authorize` không cấp code cho suspended/outsider nay được phủ ở `oauth-tenant-isolation`.
- `federation.int-spec` chuyển RP sang `default-tenant`: không làm mất phủ cross-tenant. Kiểm membership không phụ thuộc user federated hay password (cùng `session.userId`), và cross-tenant đã có ở `oauth-tenant-isolation`. Đây là đúng hệ quả Q35.2 (user provision chỉ thuộc default), không phải "đổi tenant để né kiểm". Xem 💭 1.
- `admin-users` (join B rồi rời B) và `admin-keys` (endUser là member A): mục đích các test này (admin tenant A không thấy/không thao tác được grant của tenant B, phân quyền theo vai trò) giữ nguyên. Lưu ý family CLIENT_B vẫn refresh được sau khi rời B, đã ghi trong DEBT-207.
- `seedCodeGrant` (upsert user/member/consent cho code mint thẳng trong Redis) chạy **trước** `codes.create` và không đụng các kiểm trước consume/bind. Các test âm cũ (code sai, redirect_uri/PKCE/client mismatch, single-use) không bị nới. `createCode` hardcode `'tenant-A'` khớp tenant client của các spec đó (suite xanh xác nhận).

## 🟡 Nên sửa

1. 🟡 **[BE] Oracle: `access_denied` do not_member khác byte với user tự từ chối** (DEBT-211)
   `authorize.service.ts:591` ném `AuthorizeRedirectError('access_denied', 'Access denied.')`. `buildErrorRedirect` (`authorize.controller.ts:235`) luôn thêm `error_description=Access+denied.`. Còn khi user bấm từ chối, `consent()` dùng `buildRedirect(…, { error: 'access_denied' }, state)` (`authorize.controller.ts:125-127`), không có `error_description`.
   Vì sao: tasks/Q35.1 lập luận rằng RP "không phân biệt được lý do" nhờ trùng mã lỗi. Thực tế RP chỉ cần nhìn `error_description` là biết đây là not_member chứ không phải user từ chối. Blast radius thấp: RP chỉ biết user đang đăng nhập (ẩn danh với RP) không phải member tenant của chính RP. Mặt khác `prompt=none ⇒ access_denied` vốn đã lộ điều này theo thiết kế, vì user không thể tự từ chối khi `prompt=none`. Vì vậy mục này không chặn. Dù vậy, hợp đồng "đồng nhất" đang được ghi trong tasks/ma trận mà code chưa đúng.
   Đề xuất: cho hai đường cùng một dạng. Ví dụ để nhánh deny trả cùng `error_description` (hoặc bỏ `error_description` ở nhánh not_member). Thêm assert trong `oauth-tenant-isolation` so `Location` (trừ `state`) của not_member với `Location` của deny thật. Đồng thời sửa câu "không phân biệt được lý do" trong ma trận cho đúng: lý do vẫn suy ra được qua `prompt=none`.

2. 🟡 **[test] Thiếu test resume-sau-login của user không phải member** (DEBT-212)
   MT1 chỉ chạy với session có sẵn. Đường `/authorize` (chưa login) ⇒ login ⇒ `/authorize?request_id=` ⇒ `resume` ⇒ `handle` ⇒ `assertMember` chưa có test riêng. Lỗi trên đường này sẽ redirect bằng `ctx.redirectUri`/`ctx.originalState`.
   Vì sao: hiện được che gián tiếp vì `resume` gọi `handle`. Nếu sau này ai đó tách `resume` thành đường cấp code riêng (như từng xảy ra với `decideConsent`), MT1 sẽ hồi quy mà không test nào đỏ.
   Đề xuất: thêm một case vào `oauth-tenant-isolation`: tạo login context cho CLIENT_B, gắn session của userA (tenant-A), gọi `?request_id=` ⇒ 302 `access_denied`, `state` gốc, không code.

3. 🟡 **[BE] Lặp khối "từ chối grant" ba lần trong `handleAuthorizationCodeGrant`** (DEBT-213, ponytail shrink)
   `token.controller.ts:212-249` (session) và `:257-285` (recheck) lặp cùng mẫu: revoke family best-effort hoặc có audit fallback, `recordIssued(failure, reason)`, rồi `invalid_grant`/rethrow. Có hai biến thể catch-infra và hai biến thể fail.
   Vì sao: hàm đã quá 150 dòng. Mỗi lần thêm một lý do mới (DEBT-210 sắp thêm `resource_unallowed`) lại phải chép mẫu DEBT-067, dễ quên một nhánh audit.
   Đề xuất: tách một private `refuseGrant(client, data, familyId, reason, audit, revoke = revokeFamily)` cho nhánh fail và một `failClosed(…, reason)` cho nhánh lỗi hạ tầng. Có thể gộp luôn `recheckCodeGrant` vào cùng lời gọi.

## 💭 Nit

1. 💭 [test] `federation.int-spec` không còn luồng federated nào đi vào client tenant ≠ default. Nếu muốn giữ phủ end-to-end cho user federated, thêm một case "user federated + client tenant-B ⇒ access_denied" (rẻ, dùng mock provider có sẵn). Không bắt buộc, vì kiểm không phụ thuộc kiểu user.
2. 💭 [BE] `repeatedParam(params, keys = AUTHORIZE_PARAM_KEYS)`: tham số mặc định chỉ unit test dùng, mọi call site production đều truyền `keys`. Có thể bỏ giá trị mặc định (unit test truyền `AUTHORIZE_PARAM_KEYS`).
3. 💭 [BE] Nhánh fail của recheck revoke family bằng `revokeFamily` (không ghi `TOKEN_REVOKED`), khác nhánh `session_ended` (`revokeFamilyForEndedSession` có ghi). `TOKEN_ISSUED failure refresh:true reason:<x>` đủ để truy vết, nhưng nên ghi một dòng chú thích ở đó để người sau không nghĩ là thiếu.
4. 💭 [BE] `controller.ts:74` comment còn mojibake `Â§9.1` (có từ trước, không thuộc diff run này).

## ✂️ Ponytail

- be/src/modules/oauth/token/token.controller.ts:L257: shrink: hai khối try/catch revoke+audit lặp lại mẫu của khối session (L212-249). Thay bằng một helper `refuseGrant(reason)` / `failClosed(reason)` dùng chung cho cả 3 nhánh.
- be/src/modules/oauth/authorize/authorize.service.ts:L104: yagni: default `keys = AUTHORIZE_PARAM_KEYS` không có call site production. Bỏ default, unit test truyền tường minh.
- be/src/modules/oauth/authorize/authorize.service.ts:L111: shrink: `PHASE2_PARAM_KEYS` lọc lại `client_id`/`redirect_uri`, hai khoá đã chắc chắn là string sau Phase 1 nên lọc chỉ để rõ ý. Giữ được. Có thể dùng thẳng `AUTHORIZE_PARAM_KEYS.filter(k => k !== 'resource')`.
net: -25 lines possible.
