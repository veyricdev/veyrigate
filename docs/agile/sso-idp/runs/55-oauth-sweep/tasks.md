# Tasks — run 55 — sweep debt bảo mật OAuth (M7, lane BE)

> Nguồn: `backlog.md` (đọc nguyên văn từng dòng + run gốc): DEBT-123 (consent context không gắn phiên tạo ra nó), DEBT-130 (`decideConsent` deny/continue không kiểm lại client/redirect_uri/resource), DEBT-177 (`isAccessTokenLive` không áp invariant admin-capable DEBT-174 cho `/introspect`/`/userinfo`/demo), DEBT-216 (refresh `recheck` không kiểm `result.resource` ∈ `fresh.allowedResources`), DEBT-409 (`/token` không có deadline tổng khi Vault hố đen), DEBT-410 (admin keys `listKeys`/`rotate` 500 khi Vault down). Spec/plan liên quan: §9 (authorize/consent/token), §6.2, §6.4, `security-matrix.md`.
>
> Tech-lead: xác minh từng debt còn đúng với code HEAD (có thể đã được sửa gián tiếp), loại cái đã xong, tách run nếu >1 run. Hạ tầng: KHÔNG compose up/FLUSH/drop; Vault tạm chỉ `vg-b73-vault`; không đụng `be/keys`, `be/.env`. Không kill process (chỉ TaskStop tác vụ của chính agent).

### [x] Task 1 [BE]: DEBT-123 + DEBT-130 — consent context gắn phiên; mọi nhánh `decideConsent` kiểm lại client/redirect_uri/resource trước khi redirect.
### [x] Task 2 [BE]: DEBT-177 — invariant admin-capable ở `isAccessTokenLive`.
### [x] Task 3 [BE]: DEBT-216 — refresh kiểm resource còn được phép.
### [x] Task 4 [BE]: ~~DEBT-409~~ (rút, giữ mở) + DEBT-410 — deadline tổng cho ký ở `/token`; admin keys 503 khi Vault down.

## Fold tech-lead (2026-10-26) — ƯU TIÊN hơn text ở trên khi mâu thuẫn

Kết luận: **PASS có fold**. Không tách run (4 task nhỏ, cùng lane BE). Thứ tự: **Task 4 → Task 2 → Task 3 → Task 1** (nhỏ/độc lập trước, Task 1 chạm nhiều nhánh nhất). Chi tiết và bằng chứng ở HEAD `e94267b`: `review-techlead.md`.

Xác minh ở HEAD: DEBT-123, 130, 177, 216, 410 **còn mở** (không có cái nào "đã xong gián tiếp"). **DEBT-409 rút khỏi run 55** (giữ mở, lý do ghi ở backlog). Task 4 chỉ còn DEBT-410.

Ràng buộc chung (không được phá run 54): `/token` vẫn là **ký trên bản đọc → commit nguyên tử cũ (`consume` Lua / `rotate`) → bất biến `rotatedFromId` → re-check → audit → trả**. Không thêm bước ký, không dời re-check lên trước `rotate`, không đổi `peek`/`consume`/`rotate`/Lua. Test run 54 (`run54-tester.int-spec.ts`, `token-code-recheck.int-spec.ts`, `b73*-tester.vault-spec.ts`, `run54-tester.vault-spec.ts`) phải xanh, không sửa kỳ vọng.

### F4 (Task 4, DEBT-410) — làm trước

1. `VaultTransitKeyProvider.listKeys`: bọc như `getPublicKeys` (`try { … } catch (err) { throw asUnavailable(err); }`). Không đổi `rotate` (giữ 500: mutation có thể đã chạy, không gợi ý retry), không đổi `LocalKeyProvider`, `KeyRotationService`, controller. `AdminAuthErrorFilter` chỉ `@Catch(AdminAuthError)` nên lỗi rơi về `OAuthExceptionFilter` toàn cục ⇒ 503 + `Retry-After: 5` + `no-store` sẵn có.
2. Test bắt buộc:
   - Unit `vault-transit-key-provider.spec.ts` (fetchFn giả, cache hết hạn): network error, AbortError, 500, 503, 429 ⇒ `listKeys` ném `KeyProviderUnavailableError` (`cause` = lỗi gốc, message không chứa addr/path/tên key/token); 400, 403 (sau reload token), metadata sai hình ⇒ **không** phải `KeyProviderUnavailableError`. Cache còn hạn ⇒ không gọi fetch.
   - Pin quyết định: `rotate` với Vault lỗi mạng ⇒ **không** phải `KeyProviderUnavailableError`.
   - Int `admin-keys.int-spec.ts` (override `KEY_PROVIDER` bằng provider giả: ký/JWKS dùng key thật, `listKeys`/`rotate` ném theo case): `GET /admin/keys` super_admin ⇒ 503, `retry-after: 5`, `cache-control: no-store`, body `{error:'temporarily_unavailable', error_description:<câu outage>}`, không `kid`/`kty`. Âm: tenant_admin vẫn 403 (authz trước, thứ tự không đổi). `POST /admin/keys/rotate` với lỗi mạng ⇒ 500 + audit `SIGNING_KEY_ROTATED failure` (giữ).
3. Mutation: bỏ bọc ở `listKeys` ⇒ unit + int RED; bọc thêm `rotate` ⇒ pin rotate RED.

### F2 (Task 2, DEBT-177)

1. `access-token-liveness.ts`: `ClientLookup.findByClientId` trả `Pick<Client, 'allowedResources' | 'clientType' | 'tokenEndpointAuthMethod'> | null` (giữ kiểu hẹp). `isAccessTokenLive` thêm tham số bắt buộc `adminAud: string` (cuối danh sách). Ngay sau `if (!client) return false;`: `if (claims.aud === adminAud && !isAdminCapableClient(client)) return false;` — dùng **đúng** predicate `isAdminCapableClient` (DEBT-174), không viết lại. Không tạo import cycle (nếu có thì dời predicate ra file thuần, không nhân bản).
2. Các nơi gọi truyền `adminResourceIdentifier(issuer)` (tính một lần ở constructor như `AuthorizeService.adminAud`): `introspect.controller.ts`, `userinfo.controller.ts`, `demo.controller.ts`, `tenant-context.ts` (`AdminTokenGuard`), `test/refresh-token.int-spec.ts:1499`, unit spec. `AdminTokenGuard` giữ dòng `isAdminCapableClient(seen.client)` hiện có (không churn).
3. Thứ tự: `sub` shape → `sid` → client → **admin-capable** → `aud ∈ identifiers` → user. Lỗi hạ tầng vẫn propagate (không nuốt thành false).
4. Test bắt buộc:
   - Unit `access-token-liveness.spec.ts` `it.each` các shape như DEBT-174 (`{public,none}`, `{confidential,none}`, `{confidential,client_secret_basic}`, `{confidential,client_secret_post}`, thiếu field, giá trị lạ) × `aud ∈ {admin, resource thường}`: `aud=admin` chỉ live khi admin-capable; `aud` thường **không** bị ảnh hưởng (chống chặn nhầm).
   - Int âm: client admin-capable lấy AT `aud=admin` có `openid` → đổi client trong Mongo sang `{public,none}` rồi `{confidential,none}` (helper của `admin-public-client.int-spec.ts`) → `/userinfo` ⇒ 401 `invalid_token` (không lộ lý do). `/introspect` ⇒ đúng `{active:false}` nếu harness có caller được phép hỏi token đó; không có thì unit + `/userinfo` là đủ (ghi rõ trong log). Đối chứng: client giữ nguyên ⇒ 200.
5. Mutation: bỏ dòng check ⇒ RED; predicate chỉ xét `clientType` ⇒ RED ở `{confidential,none}`.

### F3 (Task 3, DEBT-216)

1. Đổi callback `recheck` của `issueForRefresh` thành `recheck(userId: string, resource: string)`; `recheckAfterRotate` truyền `result.resource` (từ doc đã rotate, **không** từ body). Không sửa `rotate`, pre-check, thứ tự ký (run 54).
2. Callback trong `TokenController.handleRefreshGrant`, sau khi đọc lại `fresh`: `if (adminTargetForbidden(fresh, resource, this.tokens.adminResource) || (await this.resources.resolveForClient(fresh.allowedResources, resource)) === null) return 'resource_not_allowed';` — **cùng predicate và cùng reason** với `recheckCodeGrant` (DEBT-210). Rồi `subjectFailure` như cũ. Không tạo helper chung mới.
3. Khi refuse: đi đường reason sẵn có của `recheckAfterRotate` (revoke family, `unlinkSuccessor`, audit `TOKEN_REFRESHED failure resource_not_allowed`, `invalid_grant` opaque). Mongo lỗi trong callback ⇒ nhánh throw sẵn có (revoke best-effort, `recheck_failed`, 500).
4. Test bắt buộc (`token-code-recheck.int-spec.ts`, harness `afterRotate` + `dropResource` sẵn có):
   - `afterRotate(cid ⇒ dropResource(cid))` ⇒ 400 `invalid_grant`, body không có `access_token`/`refresh_token`/`eyJ`; `familyRevokedAt` set; audit `resource_not_allowed`; retry cùng RT ⇒ `invalid_grant` và **0** `TOKEN_REUSE_DETECTED` (DEBT-215 giữ).
   - Biến thể admin: family `aud=admin` của client admin-capable, `afterRotate` đổi client sang `{confidential,none}` ⇒ `invalid_grant`, reason `resource_not_allowed`.
   - Đối chứng: `afterRotate` gỡ một resource **khác** của client ⇒ 200 (không chặn nhầm).
5. Mutation: bỏ `resolveForClient` ⇒ RED; dùng `client` lúc client-auth thay `fresh` ⇒ RED; bỏ `adminTargetForbidden` ⇒ biến thể admin RED.

### F1 (Task 1, DEBT-123 + DEBT-130)

1. `AuthorizeRequestContext`: thêm `sessionRef?: string` (chỉ context `consent`). `createContext` nhận `sessionRef`, `handle` truyền `session.ref` ở nhánh `consent` (session chắc chắn non-null ở đó). Không render, không log, không đưa vào audit/URL.
2. `decideConsent` — thứ tự **bắt buộc**:
   1. `consume` (giữ single-use; context bị đốt cả khi refuse) → null ⇒ `null`.
   2. `client = findByClientId(ctx.clientId)`; `!client || !isRegisteredRedirectUri(client.redirectUris, ctx.redirectUri)` ⇒ `null` (trang first-party, **mọi** nhánh — DEBT-130).
   3. `ctx.kind !== 'consent'` ⇒ `login_required` redirect (như cũ, nay tới URI đã kiểm lại).
   4. `ctx.sessionRef === undefined || ctx.sessionRef !== session.ref` ⇒ `null` (DEBT-123: không redirect, không ghi consent, không code). **Đặt TRƯỚC nhánh deny** — đặt sau thì phiên lạ bấm "Từ chối" vẫn nhận 302 kèm `state` của nạn nhân. Không dùng `login_required` redirect như gợi ý cũ trong backlog (cũng lộ `state` cho phiên lạ).
   5. `!approve` ⇒ audit denied + redirect `access_denied` (như cũ).
   6. Kiểm resource/admin-forbidden (chỉ approve, như cũ, dùng `client` của bước 2 — không gọi `findByClientId` lần 2).
   7. `assertMember`, grant, code: không đổi.
3. `resume` (cùng lớp lỗi DEBT-130): nhánh `reauthAfter` ⇒ `login_required` redirect phải kiểm lại client + `isRegisteredRedirectUri` trước; sai ⇒ `null`. Nhánh resume bình thường đi qua `handle` (đã kiểm). Một helper private nhỏ dùng chung 2 chỗ là chấp nhận được.
4. Tương thích triển khai: context `consent` tạo trước bản mới (không `sessionRef`, TTL ≤ 10') ⇒ trang hết hạn (fail-closed, chấp nhận; ghi trong summary). Không giảm UX hợp lệ: phiên đổi giữa render và POST vốn đã bị `CsrfGuard` chặn (CSRF identity = cookie phiên).
5. Lỗi hạ tầng: `findByClientId` lỗi ở nhánh deny/login_required (trước đây không chạm Mongo) ⇒ propagate ⇒ `HtmlExceptionFilter` (503/500), không redirect. Chấp nhận (fail-closed).
6. Test bắt buộc (int, HTTP thật, CSRF thật):
   - **Transplant**: A mở consent (request_id R, phiên A). B (phiên B, CSRF hợp lệ của B) POST R `approve=true` ⇒ 400 trang lỗi, không `Location`, 0 khoá `auth_code:*` mới, không `Consent` cho B, không audit `granted`. Biến thể B POST R **deny** ⇒ 400, không `Location`. Sau đó A POST R ⇒ trang hết hạn (đã đốt).
   - Context `consent` thiếu `sessionRef` (ghi tay vào Redis) ⇒ 400, không redirect.
   - **DEBT-130**: sau khi render, admin gỡ `redirect_uri` ⇒ POST deny ⇒ 400, không `Location`; client bị disable ⇒ POST deny ⇒ 400; context `login` POST vào cửa consent với URI đã gỡ ⇒ 400 (URI còn ⇒ 302 `login_required` như cũ).
   - `resume` re-auth (`prompt=login`) rồi resume bằng phiên cũ với URI đã gỡ ⇒ trang lỗi, không 302.
   - Đối chứng: cùng phiên approve ⇒ 302 code; cùng phiên deny ⇒ 302 `access_denied` + `state` + `iss`.
7. Mutation: bỏ so `sessionRef` ⇒ transplant RED; kiểm `sessionRef` sau nhánh deny ⇒ biến thể deny RED; đưa kiểm client/URI về chỉ nhánh approve ⇒ DEBT-130 RED; coi `sessionRef` undefined là khớp ⇒ case "thiếu sessionRef" RED.

### Cổng security (đủ 5 điểm)

- **Tài sản / actor / trust boundary**: code + `state` của RP (F1), trạng thái live của AT `aud=admin` (F2), family RT (F3), metadata key (F4). Actor: chủ phiên, phiên khác có `request_id` lộ, admin đổi client/resource giữa chừng, RS/client gọi introspect, super_admin/tenant_admin.
- **Invariant / chuyển trạng thái**: chỉ phiên đã mở màn consent mới quyết được context đó; không 302 tới URI không còn đăng ký; AT `aud=admin` chỉ live khi client hiện tại admin-capable; refresh chỉ trả token khi resource còn được phép theo client **đọc lại sau rotate**; ký-trước-commit của run 54 không đổi.
- **Abuse cases**: transplant `request_id` (F1), lộ `state` qua deny/login_required (F1), token admin cũ của client bị hạ cấp (F2, confused deputy), race admin gỡ resource giữa client-auth và rotate (F3), retry RT bị refuse không thành reuse giả (F3).
- **Failure semantics**: mọi lookup mới propagate lỗi (fail-closed 5xx, không redirect, không `active:true`, không token); `listKeys` Vault mạng/timeout/5xx/429 ⇒ 503, 400/403/định dạng ⇒ 500; `rotate` giữ 500.
- **Exposure**: `sessionRef` không ra view/log/audit; refuse không lộ lý do cho RP (trang first-party / `invalid_grant` / `active:false` / 401 opaque); body 503 không chứa key material.

Verify cuối run: `pnpm -C be test` + `test:int` + lint + `tsc`; `test:vault` chỉ khi Vault tạm `vg-b73-vault` sẵn (không bắt buộc cho Task 4). E2E không bắt buộc (không đổi UI/flow hợp lệ); nếu chạy thì 35/35.
