# Tasks — run 36 — B7.1c: refresh + login re-check (DEBT-207) + DEBT-210/211/213 (M7)

> Nguồn: thiết kế **Task 4 run 35** (`runs/35-B7.1b/tasks.md` §"Task 4 [BE]: Refresh grant và login kiểm lại sau khi ghi" + fold F0; Q35.3 mặc định: revoke cả family) = DEBT-207; DEBT-210 (code grant kiểm lại `data.resource` ∈ `allowedResources`), DEBT-213 (gom khối từ chối grant), DEBT-211 (`access_denied` not_member đồng nhất với user tự từ chối). Spec §9.10, §14 (Session/Refresh), §15. Ma trận: chuyển ghi chú "refresh → DEBT-207" thành `có`.
>
> Thứ tự: Task 1 (refactor nhỏ, nền) → 2 → 3 → 4. Hạ tầng: KHÔNG compose up, KHÔNG FLUSH/drop `aegate-*`.

### [x] Task 1 [BE]: DEBT-213 + DEBT-210 — gom từ chối grant, thêm kiểm resource ở code grant
- Một helper từ chối grant trong `TokenController` (revoke family best-effort theo DEBT-067 + 1 audit `TOKEN_ISSUED failure` có reason + `invalid_grant` đồng nhất / rethrow lỗi hạ tầng); thay 3 chỗ lặp.
- `recheckCodeGrant` thêm: `data.resource` còn thuộc `allowedResources` của client đọc lại (dùng predicate/identifier hiện có, không so URI↔resourceId sai — xem run 24).
- **Acceptance**: test hiện có xanh; int: admin gỡ resource giữa mint code và `/token` ⇒ `invalid_grant`, family revoke, audit `resource_not_allowed`; mutation ⇒ RED.

### [x] Task 2 [BE]: DEBT-207a — refresh grant kiểm lại sau `rotate`
- Theo thiết kế T4 run 35: sau `rotate` thành công, kiểm client còn enabled, user không khoá, user còn member active của `client.tenantId` ⇒ không đạt: revoke cả family (Q35.3), audit, `invalid_grant` đồng nhất. Không kiểm consent ở refresh. Lỗi hạ tầng ⇒ 500 fail-closed.
- Fixture: `refresh-token.int-spec` và các spec insert family trực tiếp với userId ngẫu nhiên ⇒ dùng `seedOAuthUser`/`seedCodeGrant` (run 35); không nới check.
- **Acceptance**: int race (spy gọi bản gốc trước rồi đổi trạng thái): lock / suspend membership / disable client xen giữa ⇒ family chết, không token mới dùng được; refresh thường không hồi quy; `admin-users` cross-tenant test cập nhật theo ghi chú DEBT-207; mutation ⇒ RED.

### [x] Task 3 [BE]: DEBT-207b — login password/federation kiểm lại sau `establish`
- Sau `sessions.establish` ở login password và callback federation (+ link): đọc lại `lockedUntil` (và trạng thái cần thiết) ⇒ bị khoá: huỷ session vừa tạo (tombstone theo §9.8), trả lỗi chung như sai mật khẩu / trang lỗi first-party, không tạo code.
- **Acceptance**: int race (lock xen giữa verify và establish) ⇒ không session sống, không code, thông điệp chung; login thường không hồi quy; mutation ⇒ RED. Đóng DEBT-141, DEBT-187 nếu phủ.

### [x] Task 4 [BE]: DEBT-211 + cập nhật ma trận/backlog
- `access_denied` cho not_member giống hệt user tự từ chối (cùng có/không `error_description`) — so `Location` byte-identical trong test.
- Ma trận: dòng refresh/login liên quan ⇒ `có`; backlog đóng DEBT-116/141/207/210/211/213 (và 156/187 nếu phủ). Chạy toàn suite.

## Câu hỏi cho tech-lead
- Q-36.1: Task 3 — kiểm lại ở đâu cho login federation/link (sau `establish` trong service hay controller), và phản hồi khi khoá ở callback federation.
- Q-36.2: Phạm vi vừa 1 run không (fixture refresh).

---

## Fold tech-lead (2026-10-20) — ưu tiên hơn text cũ ở trên

> Review: `review-techlead.md` (PASS kèm fold). Đối chiếu code `develop` @ `29c1a45`.

**G0. Phạm vi (Q-36.2).** Giữ 4 task trong 1 run. Thứ tự 1 → 2 → 3 → 4. Không đổi schema, không thêm class provider/module mới, không thêm enum audit.

**G1. Khoá nào tính là `user_locked` ở grant (abuse case mới, áp dụng Task 1 và Task 2).** Lockout brute-force (`recordFailedLogin`, `lockedUntil = now + N phút`) do **bất kỳ ai biết email** kích được, và theo thiết kế KHÔNG revoke session/family (`login` chỉ audit `AUTH_ACCOUNT_LOCKED`). Nếu refresh coi khoá tạm là `user_locked` thì family chết vĩnh viễn (`rotate` đã tiêu token cũ, successor không được trả về). Kẻ tấn công chỉ cần 5 lần sai mật khẩu là xoá được mọi `offline_access` của nạn nhân. Quyết định:
- Thêm private `subjectFailure(userId, tenantId): Promise<'user_locked' | 'not_member' | null>` trong `TokenController`. `user_locked` khi user không tồn tại **hoặc** `lockedUntil?.getTime() === ADMIN_LOCKED_UNTIL.getTime()` (khoá admin, import từ `identity/user.service`). `not_member` khi `!isActiveMember(userId, tenantId)`. Code grant và refresh dùng chung.
- `recheckCodeGrant` dùng `subjectFailure`. Đây là thay đổi hành vi so với run 35: khoá tạm không còn chặn đổi code (session đang sống vẫn qua được `/authorize`, nên chặn ở `/token` chỉ tạo DoS). Trong `token-code-recheck.int-spec` đổi helper `lockOnly` sang ghi `ADMIN_LOCKED_UNTIL` (thay cho `Date.now() + 3_600_000`). Test "an EXPIRED lock does not refuse the grant" giữ nguyên. Thêm 1 test âm: khoá tạm (`now + 1h`) ⇒ code grant 200, refresh 200, family sống.
- Login (Task 3) vẫn chặn **mọi** khoá (`lockedUntil > now`), giống pre-check hiện có.

**G2. Task 1, DEBT-213 helper.** Hai private method trong `TokenController`, không thêm class:
- `refuseGrant(client, data, familyId, reason, audit, revoke = (id) => this.refresh.revokeFamily(id, client.clientId, new Date()))`. Có `familyId` thì `await revoke(familyId)`. Nếu revoke ném: ghi `recordIssued failure reason` best-effort rồi ném lại (DEBT-067). Nếu revoke xong: ghi `recordIssued failure reason` (không nuốt lỗi), rồi `throw new TokenError('invalid_grant')`. Nhánh `session_ended` truyền `revoke` = `revokeFamilyForEndedSession(...)`, giữ audit `TOKEN_REVOKED session_ended` riêng của hàm đó.
- `failClosed(client, data, familyId, reason, audit, err)`: revoke best-effort, `recordIssued failure reason` best-effort, rồi `throw err`. Dùng cho `session_check_failed` và `recheck_failed`.
- Giữ nguyên nhánh audit success bị lỗi (revoke best-effort, không ghi audit failure). Số audit ở mỗi nhánh KHÔNG đổi, test hiện có làm oracle.

**G3. Task 1, DEBT-210.** Inject `ResourceService` vào `TokenController` (OauthModule đã import ResourcesModule). Int-spec nào tự liệt kê providers có `TokenController` mà thiếu thì thêm. Trong `recheckCodeGrant`, đặt sau `redirect_uri_unregistered` và trước subject: `if (data.resource && (adminTargetForbidden(fresh, data.resource, this.tokens.adminResource) || (await this.resources.resolveForClient(fresh.allowedResources, data.resource)) === null)) return 'resource_not_allowed'`. Đây là cùng predicate với `decideConsent`: so qua `resourceId`, không so URI với `allowedResources`. Reason chuẩn là `resource_not_allowed`.

**G4. Task 2, vị trí kiểm refresh (thay cho "inject vào service").** `issueForRefresh` nhận thêm tham số **bắt buộc** `recheck: (userId: string) => Promise<string | null>`. Không để optional, tránh caller mới quên truyền. Controller truyền `async (userId) => { const fresh = await this.clients.findByClientId(client.clientId); if (!fresh) return 'client_disabled'; return this.subjectFailure(userId, fresh.tenantId); }`. Trong service, ngay sau `rotate` thành công và TRƯỚC `signTokensForRefresh`:
- Nếu `recheck` ném: `revokeFamily(result.familyId, result.clientId, now)` best-effort, ghi audit `TOKEN_REFRESHED result:'failure' reason:'recheck_failed'` best-effort, rồi ném lại (500, fail-closed).
- Nếu trả về reason: gọi `revokeFamily(...)` (nếu ném thì ghi audit best-effort rồi ném lại, DEBT-067), ghi audit `TOKEN_REFRESHED failure reason:<reason>` với metadata `{ resource, familyId }` (không có token/hash), rồi `throw new RefreshRotationError()`. Controller trả `invalid_grant`.
- Không thêm DI vào `RefreshTokenService`. Unit spec `refresh-token.service.spec.ts` và lời gọi trực tiếp ở `refresh-token.int-spec.ts` (~dòng 1911) chỉ cần truyền `async () => null` hoặc dùng fixture thật. Không kiểm consent ở refresh (DEBT-214).
- Race test: `jest.spyOn(app.get(RefreshTokenService), 'rotate')`, gọi bản gốc trước rồi mới đổi trạng thái: lock bằng `ADMIN_LOCKED_UNTIL` qua `updateOne`, suspend `UserTenant`, đặt `disabledAt` cho client. Kiểm: body 400 byte-identical với `invalid_grant` của token rác; mọi doc của family có `revokedAt != null`; refresh lại bằng token cũ ⇒ `invalid_grant`; đúng 1 audit `TOKEN_REFRESHED failure` có reason. Đối chứng: khoá tạm ⇒ 200 (G1).
- Fixture: chỉ những test refresh (qua `/token grant_type=refresh_token` hoặc `issueForRefresh`) mong 200 mới cần userId thật (`seedOAuthUser` với `tenantId = client.tenantId`). Ước lượng: `refresh-token.int-spec` (15 userId ngẫu nhiên), `client-auth-rate-limit` (2); `token.int-spec`/`introspect.int-spec` chỉ khi test đó có refresh. Test mong `invalid_grant` vì lý do khác (token rác, hết hạn, reuse) giữ nguyên. Không đổi tenant của client để né kiểm.
- `admin-users.int-spec › cross-tenant user, step-up and scope on family/consent routes`: bước refresh family CLIENT_B của user đã rời tenant B đổi kỳ vọng sang `invalid_grant` + family revoked. Ghi vào log là thay đổi có chủ đích.

**G5. Task 3, trả lời Q-36.1.** Kiểm trong **service**, không ở controller:
- `AuthenticationService.login`: ngay sau `sessions.establish`, trước 2 audit success, đọc lại `const fresh = await this.users.findById(user.sub)`. Nếu `!fresh || (fresh.lockedUntil && fresh.lockedUntil > new Date())`: `await this.sessions.revoke(established.id)` (raw id, tombstone mặc định true), `recordFailed()`, rồi `UnauthorizedException(GENERIC_LOGIN_ERROR)`. Không gọi `recordFailedLogin` (không tăng counter). Nếu đọc DB lỗi: `sessions.revoke` best-effort rồi ném lại (500, không cookie).
- `completeLink` đi qua `login` nên đã được phủ (401 ⇒ `linkFailed('credentials')`), không cần code riêng. Thêm 1 test race cho link.
- `FederationService.callback`: sau `establish` (~dòng 186), trước audit, kiểm giống trên. Bị khoá: `sessions.revoke(established.id)`, `recordFailed(provider, 'locked', audit, userId)`, rồi `throw new FederationError('account_locked')` (dùng lại trang lỗi của `loginExisting`). Lỗi DB: revoke best-effort rồi ném lại.
- Race test: spy `SessionService.establish` (lấy qua `app.get`), gọi bản gốc rồi ghi lock. Hai biến thể: admin lock (`ADMIN_LOCKED_UNTIL` + `revokeAllUserCredentials`) và chỉ `updateOne lockedUntil`. Kỳ vọng: password ⇒ 401 với thông điệp byte-identical như sai mật khẩu; federation ⇒ trang `account_locked`. `sessions.exists(sha256(id))` false. Response không có `Set-Cookie` session hợp lệ. Không có `AUTH_LOGIN_SUCCESS`/`SESSION_CREATED`.
- Khi test xanh: đóng DEBT-187 (federation) và phần login của DEBT-141.

**G6. Task 4, DEBT-211.** Đổi `AuthorizeRedirectError.errorDescription` thành optional (`errorDescription?: string`). `buildErrorRedirect` chỉ set `error_description` khi có giá trị. `assertMember` ném `new AuthorizeRedirectError('access_denied')` không kèm mô tả. Các lỗi khác giữ mô tả cũ. Test: cùng `state`, so `Location` của not_member (cả `/authorize` lẫn POST consent `approve=true`) với deny thật (POST consent `approve=false`), phải byte-identical. Sửa câu ma trận MT1 về "không phân biệt được lý do".

**G7. Task 4, ma trận/backlog.** MT1/MT2/24b: thêm test refresh, xoá ghi chú "Refresh grant ⇒ DEBT-207". Thêm ghi chú cho G1 (khoá tạm không chặn grant). Đóng DEBT-207, 210, 211, 213, 187. Đóng hẳn DEBT-116 và DEBT-141. DEBT-156: đóng phần "race disable ở refresh", giữ mở phần AT ≤15'. Acceptance: `pnpm -C be test`, `pnpm -C be test:int`, `pnpm -C fe-sso-test test` (không đổi), E2E 16/16 nếu hạ tầng sẵn (không FLUSH, không compose up).

**G8. Mutation (bắt buộc ghi log).** Lần lượt xoá: nhánh resource (G3); `client_disabled`, `user_locked`, `not_member` ở refresh; post-check login; post-check federation; thay điều kiện admin-lock bằng `> now` (test khoá tạm phải đỏ). Mỗi mutation chỉ làm đỏ đúng test tương ứng.
