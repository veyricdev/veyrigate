# Tasks — run 75 — thực thi `Resource.scopes` + thu hẹp scope khi refresh (M7, lane BE + FE)

> Nguồn: `backlog.md` DEBT-321 (BE không dùng `Resource.scopes` khi cấp token) + DEBT-512 (bỏ scope không ảnh hưởng refresh token đã cấp); quyết định đã chốt `plan.md` §12: "DEBT-321 (chốt 2026-11-07)" (giao `Client.scopes` ∩ `Resource.scopes`, scope OIDC chuẩn chỉ so `Client.scopes`, ngoài giao ⇒ `invalid_scope`) và "DEBT-512 (chốt 2026-11-07)" (refresh thu hẹp scope về giao hiện hành; giao rỗng ⇒ `invalid_grant` + revoke). **Thiết kế T3 đã được tech-lead review ở run 74** — `runs/74-sweep-be1/tasks.md` § Fold tech-lead phần T3/DEBT-321 (ca a–g, mutation, guard resource `admin` không được mất `admin.read`/`admin.write`, ≥ 6 fixture int, copy fe-admin, kiểm DB trước deploy) — dùng lại, bổ sung DEBT-512.
>
> Tech-lead: xác nhận lại thiết kế run 74 còn đúng với code hiện tại (sau run 74), bổ sung DEBT-512 (refresh: tính giao hiện hành, phát token scope hẹp hơn, consent/scope family có cần cập nhật không; giao rỗng ⇒ revoke), tác động discovery/consent/fe-admin (A6.2 copy: scopes giờ được thực thi; guard xoá `admin.*` khỏi resource `admin` ⇒ lỗi rõ ràng), script/lệnh kiểm DB trước deploy (read-only) + runbook. Cách chứng minh: int ca a–g + ca refresh thu hẹp/rỗng, mutation ⇒ RED, int full, unit be, fe-admin, E2E 37, X3 nếu chạm luồng authorize (không song song).
>
> Ràng buộc: KHÔNG compose up/FLUSH/drop `aegate-*`; không seed/sync DB dev `sso-idp`; KHÔNG `drop-int-orphans.mjs`; không sửa hosts/kho chứng chỉ; không tải gì; không đụng `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `be/keys`, `be/.env`; `vg-test-*` chỉ `docker start`; mutation: backup NGAY trước mutate, restore xong so `git diff`; không kill/Stop-Process/taskkill PID nào (chỉ TaskStop task của mình); không dừng `pnpm dev` người dùng (kiểm cổng trước E2E/X3); không commit.

### [x] Task 1 [BE]: DEBT-321 — `/authorize` + `/token` cấp scope = giao với `Resource.scopes`; guard resource `admin`.
### [x] Task 2 [BE]: DEBT-512 — refresh thu hẹp scope về giao hiện hành; rỗng ⇒ `invalid_grant` + revoke.
### [x] Task 3 [FE]: fe-admin copy/thông điệp A6.2 + lỗi guard `admin.*`.
### [x] Task 4 [docs/ops]: spec §7, runbook (kiểm DB read-only trước deploy).

## § Fold tech-lead (2026-11-07) — BẮT BUỘC

**Kết luận: PASS.** Thiết kế T3 run 74 vẫn khớp code sau run 74. Hiện trạng: `validateScope` (`authorize.service.ts:519`) chỉ so `client.scopes`. `resolveResource` (`:535`) có gọi `resolveForClient` nhưng chỉ trả `identifier`, bỏ `Resource.scopes`. `decideConsent` (`:399-406`) chặn trên bằng `client.scopes`. `recheckCodeGrant` (`token.controller.ts:383`) và callback recheck refresh (`:449`) chỉ kiểm `isCovered`. `PATCH /admin/resources/:id` (`admin-resources.controller.ts:110`) chưa có guard.

Quyết định DEBT-512 chọn B (thu hẹp) là đúng về kỹ thuật và bảo mật: chỉ lấy giao nên không leo thang được, và việc thu hồi có hiệu lực ngay ở lần refresh kế tiếp. Kèm hai điều kiện bắt buộc:
- Thu hẹp phải tính **trước khi ký**, vì DEBT-388 ký trước khi swap (xem T2).
- Kết quả thu hẹp phải **lưu vào RT kế nhiệm**. Nếu không, khi admin thêm lại scope thì quyền tự sống lại.

Thứ tự task: 1 → 2 → 3 → 4. Hành vi mới nào cũng viết test RED trước. Mutation: backup ngay trước khi sửa, restore xong thì `git diff` chỉ còn thay đổi chủ đích.

### Quy tắc chung (viết một chỗ, dùng ở 4 nơi)
- Tạo file mới `be/src/modules/oauth/scope-policy.ts` gồm:
  - `OIDC_SCOPES = ['openid','profile','email','offline_access']`.
  - Hàm thuần `grantableScopes(clientScopes, resourceScopes | undefined): Set<string>`, trả về `client ∩ (OIDC ∪ resource)`. Khi không có resource thì trả về `client`.
- Unit test `scope-policy.spec.ts`, 4 ca:
  - Là giao chứ không phải hợp.
  - Scope OIDC vẫn qua khi resource là `[]`.
  - Không có resource thì chỉ còn scope của client.
  - Scope có ở resource nhưng client không có thì bị loại.
- Dùng ở 4 nơi: `/authorize` `handle`, chặn trên của `decideConsent`, `recheckCodeGrant`, `issueForRefresh`. Không đổi discovery `scopes_supported` (sửa tối thiểu).
- Nguyên tắc nhất quán: **yêu cầu mới (authorize, đổi code) thì từ chối; grant sống lâu (refresh) thì thu hẹp.**
  - Code chỉ sống ≤ 60 s. RP gọi lại `/authorize` và nhận `invalid_scope` rõ ràng.
  - Family sống tới 30 ngày. Nếu từ chối thì mỗi lần admin chỉnh cấu hình là đăng xuất hàng loạt, đúng lý do đã chốt B.

### Task 1 [BE] DEBT-321 — giữ thiết kế run 74, bổ sung các điểm sau
- `resolveResource` trả `Resource | undefined`. `handle` lấy `.identifier` để ghi context/code.
- Thứ tự lỗi giữ nguyên:
  1. `validateScope` (theo client) ⇒ `invalid_scope`.
  2. `resolveResource` ⇒ `invalid_target`.
  3. Kiểm `grantableScopes` ⇒ `invalid_scope` (redirect, không tạo context/code).
- `resume` đi qua `handle` nên tự được áp.
- `decideConsent`: giữ lại kết quả `resolveForClient` (hiện bị bỏ ở `:382`) và đặt `allowedScopes = [...grantableScopes(client.scopes, resource?.scopes)]`.
- **`recheckCodeGrant` (ngữ nghĩa code grant)**:
  - Giữ `Resource` trả về từ `resolveForClient` (`:396`).
  - Kiểm `data.scope ⊆ grantableScopes(fresh.scopes, resource?.scopes)`, đặt sau `resource_not_allowed` và trước `subjectFailure`.
  - Sai ⇒ reason mới `'scope_not_allowed'`, đi đường reason hiện hành ⇒ `invalid_grant` + audit. Chưa có family nên không cần revoke.
  - Bước này đóng luôn nửa "code" của DEBT-512 cho cả `Client.scopes`. Hiện ở đường covered, consent cũ còn chứa scope admin đã gỡ nên `isCovered` vẫn đúng và code vẫn đổi được token.
- **Guard resource `admin`**:
  - Controller đọc trước bằng `findByResourceId`.
  - Nếu `identifier === adminResourceIdentifier(issuer)` (lấy `TokenService.adminResource` hoặc inject issuer) và `dto.scopes` thiếu `admin.read` hoặc `admin.write` ⇒ trả `AdminAuthError.invalidRequest('The admin resource must keep the admin.read and admin.write scopes.')`, tức 400, DB không đổi.
  - Không ghi audit, giống lỗi validate DTO hiện hành. Đây là điểm sửa so với run 74: ý "audit failure" ở run 74 không đúng vì 400 validate hiện không có audit.
  - `identifier` bất biến nên đọc rồi ghi là an toàn. `resourceId` không unique (DEBT-077), nên `updateScopes` lọc thêm `identifier` của doc vừa đọc để ghi đúng doc đã kiểm (dev chọn cách ít diff nhất).
- Fixture: quét `grep -rln "resources.create\|createResource" be/test`. Có 13 file: `admin-api`, `admin-keys`, `admin-users`, `admin`, `authorize`, `clients`, `demo`, `full-app.ts`, `introspect`, `refresh-token`, `session-reflection`, `token-code-recheck`, `userinfo`, cộng `federation` theo run 74. Sửa resource để có đúng scope mà test xin. KHÔNG nới check, KHÔNG thêm cờ tắt.

### Task 2 [BE] DEBT-512 — refresh thu hẹp scope (B)
- **Vị trí**: phần pre-check của `issueForRefresh`, **TRƯỚC** `signTokensForRefresh` (`refresh-token.service.ts:180-212`). Thu hẹp sau rotate là quá muộn vì AT đã ký bằng scope cũ (DEBT-388).
  - Thêm `'scopes'` vào `Pick<Client,…>`. `handleRefreshGrant` truyền `client.scopes`; client vừa authenticate chính là bản đọc hiện hành.
  - Đọc `Resource` của `original.resource` bằng `findByIdentifier`. Kết quả null thì coi như mất resource: không thu hẹp ở đây, để rotate/classify xử lý như hiện hành.
- Tính `kept = original.scope ∩ grantableScopes(client.scopes, resource.scopes)`.
- **Từ chối** (⇒ `invalid_grant` + revoke family, reason `scope_not_allowed`) khi gặp một trong ba trường hợp:
  - (i) `kept` rỗng.
  - (ii) family có ≥ 1 scope ngoài OIDC nhưng `kept` không còn scope ngoài OIDC nào. Đây là cách hiểu "không còn scope nào của resource" trong chốt §12.
  - (iii) `offline_access ∈ original.scope` nhưng đã bị gỡ khỏi `client.scopes`, tức quyền truy cập offline đã bị rút.
- Family chỉ có scope OIDC (ví dụ demo, resource `scopes: []`) không bị (ii) chặn.
- Cách thực thi từ chối:
  - Gọi `revokeFamily(original.familyId, clientId, now)`, ghi audit `TOKEN_REFRESHED failure reason:'scope_not_allowed' metadata {resource, familyId}`, rồi `throw new RefreshRotationError()`.
  - Nếu revoke lỗi: ghi audit (best effort) rồi ném lại lỗi ⇒ 500, theo mẫu DEBT-067 (`classifyMiss:511-516`).
  - Không rotate, không tạo successor. Doc bị revoke có `replacedBy: null`, nên gửi lại RT chỉ ra `invalid_grant` thường, không bắn `TOKEN_REUSE_DETECTED` giả.
- **Thu hẹp**:
  - `accessScope = (requested ?? original.scope) ∩ kept`.
  - `requested ⊄ original.scope` ⇒ `invalid_scope`, như hiện hành.
  - `requested` hợp lệ nhưng giao với `kept` rỗng ⇒ `invalid_scope`. Không rotate, không revoke vì family vẫn hợp lệ.
- **RT kế nhiệm lưu `kept`, không lưu `accessScope`**:
  - Thêm tham số `successorScope` cho `rotate` (mặc định `old.scope`), dùng cho `insertRefreshToken` và `RotationResult.scope`.
  - Lý do: admin thêm lại scope thì family KHÔNG sống lại quyền (nhất quán với DEBT-415). Muốn lấy lại scope thì phải `/authorize` mới.
  - Thu hẹp theo yêu cầu của RP (`scope=` trong body, RFC 6749 §6) vẫn giữ nguyên scope family như cũ.
- **Recheck sau rotate** (`token.controller.ts:449`) nhận `result.scope = kept`, nên `isCovered` kiểm đúng thứ sắp phát.
  - Không thêm bước kiểm scope sau rotate.
  - Chấp nhận race "admin bớt scope giữa pre-check và rotate": AT đã ký sống tối đa TTL access (15') giống AT phát ngay trước khi đổi cấu hình, và lần refresh kế tiếp sẽ thu hẹp lại. Ghi rõ trong comment và spec §7.
- **Consent**: không đổi. Consent là việc người dùng đã đồng ý, thu hẹp scope không cần đồng ý mới. Thêm lại scope cũng không bắt đồng ý lại vì người dùng đã đồng ý trước đó. Code grant vẫn được chặn bởi T1.
- **`id_token`**: `signTokensForRefresh` theo `effectiveScope`, nên khi client bị gỡ `openid` thì không phát `id_token`. Response luôn trả `scope` đã thu hẹp (RFC 6749 §5.1).

### Task 3 [FE] fe-admin
- Đổi hint ở `resource-form.tsx:25` thành: "Separated by spaces or new lines. Enforced: a token for this resource only gets scopes listed here and on the client (standard OIDC scopes excepted). Removing a scope narrows existing sessions at their next refresh." Thêm test fe-admin assert đúng chuỗi này (đã grep: không test/E2E nào khớp chuỗi "Informational").
- Lỗi guard: `server/admin-api/client.ts:176` đã map `400 invalid_request` + `error_description`, và `$resourceId.tsx` hiển thị qua `failureMessage`. Chỉ thêm 1 test: PATCH nhận 400 kèm mô tả của guard ⇒ form hiện đúng thông điệp, không chuyển `unsure`. Test xanh ngay thì không thêm code FE; đỏ thì sửa tối thiểu.

### Task 4 [docs/ops]
- `spec.md` §7:
  - Sửa quy tắc 4 (hiện ghi "token mới phải giữ nguyên scope") thành: refresh **không bao giờ mở rộng scope**. Scope phát ra = family ∩ `Client.scopes` ∩ (OIDC ∪ `Resource.scopes`) hiện hành và được lưu vào RT kế nhiệm. Ba trường hợp (i)–(iii) ⇒ `invalid_grant` + revoke.
  - Thêm quy tắc 5 (DEBT-321): authorize, consent và đổi code đều dùng phép giao; scope OIDC chỉ so với client. Scope ngoài giao ⇒ `invalid_scope` ở authorize, `invalid_grant` khi đổi code.
  - Ghi rõ AT đã phát giữ nguyên scope tới khi hết hạn (≤ 15'), và có guard cho resource `admin`.
- `security-matrix.md`: thêm test mới vào R3 và dòng 12.
- `runbook-deploy.md` thêm **§12 "Trước deploy run 75 — `Resource.scopes` được thực thi"**, gồm các lệnh `mongosh` **chỉ đọc** (dev tự kiểm tên collection thật):
  - (q1) Resource có `identifier = <ISSUER>/admin/` phải có cả `admin.read` và `admin.write`. Thiếu thì sửa trước khi deploy, nếu không fe-admin bị khoá.
  - (q2) Chạy `aggregate` trên `clients`, `$lookup` sang `resources` theo `allowedResources`. Client nào có `$setDifference(scopes, OIDC ∪ ⋃res.scopes)` khác rỗng thì liệt kê `clientId` cùng các scope sẽ bị `invalid_scope` sau deploy.
  - (q3) Đếm RT đang active (`revokedAt:null`, `expiresAt>now`) có scope nằm ngoài giao hiện hành, chia hai nhóm "sẽ thu hẹp" và "sẽ bị revoke" theo (i)–(iii).
  - Hành động: thêm scope còn thiếu vào resource TRƯỚC khi deploy, hoặc chấp nhận và báo trước cho RP.
- Chạy thử q1–q3 ở chế độ read-only trên DB `sso-idp-e2e` (KHÔNG chạy trên DB dev `sso-idp`, KHÔNG ghi). Kỳ vọng: q1 đủ cả hai scope, q2 và q3 rỗng. Dán kết quả vào log.

### Cách chứng minh (int, Mongo thật)
- **Ca a–g của run 74 giữ nguyên**, riêng (f) thêm assert DB: `consents.grantedScopes` không chứa scope đã gỡ. Lý do: với check mới ở `recheckCodeGrant`, (f) đằng nào cũng ra `invalid_grant`. Nếu không có assert DB, mutation "bỏ chặn trên ở `decideConsent`" sẽ không RED.
- (g2) PATCH resource `admin` giữ đủ `admin.read admin.write` và thêm scope khác ⇒ 200. PATCH resource khác về `[]` ⇒ 200. Sau (g), assert DB không đổi.
- (c1) Consent cũ phủ `api.write` và code đã cấp; admin gỡ `api.write` khỏi resource rồi gọi `/token` ⇒ 400 `invalid_grant`, không có token, audit reason `scope_not_allowed`.
- (c2) Như c1 nhưng gỡ scope khỏi `Client.scopes`.
- Các ca refresh (r1)–(r7) dùng family `openid offline_access api.read api.write`:
  - (r1) Đổi resource về `[api.read]` rồi refresh ⇒ 200. `scope` trong response, claim `scope` trong AT và `scope` của doc RT kế nhiệm đều không còn `api.write`; family vẫn sống. Sau đó thêm lại `api.write` vào resource và refresh lần 2 ⇒ vẫn không có `api.write` (không sống lại).
  - (r2) Gỡ `api.read` khỏi `Client.scopes` ⇒ thu hẹp tương tự r1.
  - (r3) Đổi resource về `[]` ⇒ 400 `invalid_grant`. Mọi doc của family bị revoke, có đúng 1 audit `scope_not_allowed`, 0 `TOKEN_REUSE_DETECTED`. Gửi lại đúng RT đó ⇒ `invalid_grant`, vẫn 0 reuse.
  - (r4) Family chỉ có `openid offline_access` trên resource `scopes: []` ⇒ 200, không đổi gì (hồi quy cho demo/E2E).
  - (r5) Gỡ `offline_access` khỏi `Client.scopes` ⇒ `invalid_grant` + revoke.
  - (r6) Sau r1, gửi body `scope=api.write` ⇒ 400 `invalid_scope`, RT vẫn active.
  - (r7) Như r3 nhưng spy cho `revokeFamily` reject 1 lần ⇒ 500, body không lộ chi tiết, có audit `scope_not_allowed`. Sau khi restore spy, gọi lại ⇒ `invalid_grant` và family bị revoke.
- Mutation (chạy từng cái riêng):

  | Mutation | Ca phải RED |
  |---|---|
  | Bỏ kiểm resource ở `handle` | a, d, e |
  | Dùng hợp thay giao | d |
  | Bỏ chặn trên ở `decideConsent` | f |
  | Bỏ guard resource `admin` | g |
  | Bỏ check ở `recheckCodeGrant` | c1, c2 |
  | Ký AT bằng `original.scope` | r1, r2 |
  | Successor lưu `old.scope` | r1 (lần refresh 2) |
  | Bỏ điều kiện (ii) | r3 |
  | Bỏ điều kiện (iii) | r5 |

- Cổng kiểm, chạy tuần tự (không song song, không retry, không nới assert):
  1. typecheck + lint.
  2. `pnpm -C be test`.
  3. Int full `test:int`: 1477 + N, không thêm DB mồ côi.
  4. `pnpm -C fe-admin test`.
  5. E2E 37 (kiểm cổng 5173/BE trước khi chạy).
  6. X3 `pnpm -C e2e e2e:x3`: 42 (bắt buộc vì `/authorize` đổi).
- Diff dự kiến:
  - Code: `scope-policy.ts` (mới), `authorize.service.ts`, `token.controller.ts`, `refresh-token.service.ts`, `admin-resources.controller.ts`, `resource.service.ts` (nếu thêm filter), `resource-form.tsx`.
  - Test: các int-spec ở trên, unit `scope-policy.spec.ts`, test fe-admin.
  - Docs: `spec.md` §7, `runbook-deploy.md` §12, `security-matrix.md`, các file của run 75.
- Debt mở ở review này: DEBT-515 (`backlog.md`).
