# Log — run 17 — introspect-hardening (DEBT-037/040/041/043/045/046)

## analyst — 2026-10-12
- Preflight CodeGraph: v1.6.2, status OK, `codegraph sync` (1 file, 14 nodes). (Cảnh báo index v1.5.0 — không chặn; để dev/tech-lead re-index nếu cần.)
- Đọc bối cảnh: STATUS.md, backlog.md (DEBT-037/040/041/043/044/045/046), summary run 15 (OPEN-1 access token exp-only) + run 16 (`sessionRef` lan session→code→token→rotate; `sess:{ref}`; `sess_rp:{ref}`).
- Khám phá code qua Git Bash: introspect.controller.ts (liveness ĐANG chạy TRƯỚC authz → DEBT-040), access-token-liveness.ts (port `ClientLookup`/`UserExistence`), token.service.ts (`signAccessToken` chưa set `sid`; authorization_code grant đã có `data.sessionRef`, refresh grant đọc được `sessionRef` từ doc), token-verifier.ts (`AccessTokenClaims` — thêm `sid?`), token-signer.ts, authorization-code.service.ts (`authz_code:{sha256(code)}`, consume-with-binding), logout.service.ts (`verifyHint` gọi `findByClientId` 2 lần → DEBT-046), session.service.ts (`sess:{ref}` = sha256(cookie id) = `sessionRef`; cần port `alive(ref)`), userinfo.controller.ts (dùng chung `isAccessTokenLive`), be/package.json (`lint` = `eslint src`).
- Viết `runs/17-introspect-hardening/tasks.md`: 4 task [BE], acceptance đo được, security invariants, § trỏ spec/plan/backlog.
  - T1: DEBT-040+041 (authz caller TRƯỚC liveness; sửa caller test `aud`).
  - T2: DEBT-037 (claim `sid` vào access token; introspect+userinfo phản ánh logout/revoke tức thời qua session liveness). Nêu Q-A/Q-B/Q-C mở, đề xuất phương án an toàn (fail-closed).
  - T3: DEBT-043 (`/token` kiểm session sống trước khi mint refresh; đóng cửa sổ ≤60s của authorization code sau logout).
  - T4: DEBT-044 (chỉ nếu ID token có `sid`, nếu không → hoãn) + DEBT-045 (lint phủ `test/` + 2 lỗi prettier) + DEBT-046 (nit, net ≈ -5 dòng).
- **HỢP ĐỒNG SPEC**: DEBT-037 thay đổi **spec §214** (hiện khẳng định introspect KHÔNG phản ánh logout/revoke cho access token). Chưa sửa spec.md/plan.md trong lượt này (giao thức: không ghi đè); ghi rõ cần cập nhật §214 (+ §444/§453 nếu cần) SAU khi tech-lead chốt Q-A/Q-C.
- Đề nghị chuyển **tech-lead**.

## tech-lead — 2026-10-12
- Preflight CodeGraph v1.6.2: status OK, `sync` → Already up to date. Đọc code qua `codegraph node/callers/files`.
- Đối chiếu: introspect.controller.ts:132, access-token-liveness.ts:31, token.service.ts (76/161/186), refresh-token.service.ts (`rotate`, `RotationResult` thiếu `sessionRef`), session.service.ts (`revokeRef`, Lua revokeAll, `get` absolute), ui.controller.ts:214, authentication.service.ts:179, authorize.service.ts:306/327, token.controller.ts:134, logout.service.ts:91, userinfo.controller.ts:70.
- **Kết luận: PASS kèm fold** → `review-techlead.md`; fold vào `tasks.md` (T1 spy theo đối số; T2 bản chốt tombstone; T3 fail-closed khi thiếu `sessionRef`; T4 bỏ DEBT-044; mục "Cập nhật spec.md" với văn bản chốt §8/§9.8/§11/§14/§15).
- Chốt: Q-A `sid=sessionRef` (lộ trong JWT, chấp nhận — không phải capability); Q-B tombstone `sess_end:{ref}` TTL accessTTL+60s — chỉ chấm dứt chủ động giết AT, idle-expire không (giữ `offline_access`); Q-C giữ hành vi cũ (cửa sổ thật ≤30d theo family pre-B4.7, mỗi AT ≤15'); DEBT-044 hoãn; userinfo Redis lỗi → 500.
- Backlog: cập nhật DEBT-044 (đích), DEBT-013 (ghi chú `sess_end`); thêm DEBT-047/048/049.
- Chuyển **backend-dev** (Task 1 → 2 → 3 → 4).

## backend-dev — 2026-10-12
- Preflight CodeGraph v1.6.2 OK (index 154 files, fresh). Đọc code qua Git Bash. Làm T1→T4 theo bản fold.
- T1 (DEBT-040/041): đảo thứ tự ở `introspectAccessToken` — authz caller TRƯỚC `isAccessTokenLive`; sửa comment lớp + hàm. DEBT-041: test `aud no longer` đổi caller→TOKEN_CLIENT + thêm control active:true; thêm spy test chứng minh unrelated caller ⇒ `users.exists`/`isEnded` 0 lần, `findByClientId` không gọi với token's client_id.
- T2 (DEBT-037): `AccessTokenClaims.sid?`; verifier throw nếu `sid` non-string. `isAccessTokenLive(+SessionEndLookup)`: sid malformed(64-hex)⇒false (no Redis); `isEnded`⇒false; trước Mongo. `signAccessToken(+sessionRef)` set `sid` (code: `data.sessionRef`; refresh: `RotationResult.sessionRef` ← `rotate` trả `old.sessionRef`). `SessionService.isEnded` = EXISTS `sess_end:{ref}`; tombstone `SET sess_end:{ref} PX accessTTL*1000+60000` ở `revokeRef` (MULTI) + Lua `sessionRevokeAll` (ARGV TTL). introspect+userinfo inject SessionService; Redis lỗi ⇒ 500 (userinfo cũng 500, không 401). Sửa comment `refresh-token.schema.ts` (sid lộ qua JWT, không phải credential).
- T3 (DEBT-043): `AuthorizationCodeData.sessionRef` thành **bắt buộc**; `/token` code-grant: sau consume+resource, `!sessionRef`⇒invalid_grant, `SessionService.exists(sess:{ref})` false⇒invalid_grant (Redis lỗi⇒500). Fixture: token.service.spec + authorization-code.int-spec thêm sessionRef.
- T4: DEBT-045 `lint`=`eslint src test` + `--fix` (prettier refresh-token.int-spec/ui.int-spec). DEBT-046: gỡ `forwardRef` thừa (ui.module, không cycle), `verifyHint` trả `client` (bỏ findByClientId 2nd), xoá early-return `clientsForUser`, `defaultRedirect`→const module, sửa comment ui.controller/refresh-token.service, doc `gateInsert`. DEBT-044 HOÃN (ID token chưa có sid).
- Fix hồi quy do `sessionRef` bắt buộc + SessionService đọc `accessTokenTtl`: thêm `accessTokenTtl` vào cfg `token` ở authorize/ui-auth/tenant-context int-spec; refresh-token & token int-spec seed/bind live session cho mọi code exchange.
- Spec.md áp bản fold: §8 (ví dụ AT + bullet `sid` + thay đoạn revocation strategy), §9.8 (tombstone + front-channel iss), §11 (bảng `/userinfo`+`/introspect`), §14 (dòng Session), §15 (invariant 28,29).
- Verify (Git Bash, Mongo rs0@27117 + Redis@6479): `pnpm typecheck` 0; `pnpm lint` (src+test) 0 lỗi/0 warning; `pnpm test` **127/127**; `pnpm test:int` **376/376** (19 suites; mới: introspect 24→32, userinfo 19→25, sessions 15→20, token 25→30, refresh 41 giữ, +session-reflection.int-spec 5). Tổng **503** (473→503, +30). Không regress.
- Đề nghị chuyển **senior-reviewer**.

## [2026-10-12 12:30] senior-reviewer
- Đã làm: Preflight CodeGraph (sync OK); review diff T1–T4 + spec; dùng CodeGraph callers kiểm mọi đường chấm dứt phiên (đều ghi tombstone); tự chạy typecheck/lint/unit (0/0/127); mutation M1–M5 trên int suite (authz-order, Lua tombstone, `/token` exists, nuốt lỗi isEnded, refresh `sid`) đều bị test bắt, đã khôi phục byte-identical (sha256); probe tạm (đã xoá) cho thấy reset mật khẩu không revoke refresh.
- File đổi: runs/17-introspect-hardening/review-senior.md, backlog.md (DEBT-050…053), STATUS.md
- Kết quả: PASS — 0 🔴; 🟡: reset mật khẩu không revoke family (có từ trước, ưu tiên cao), TOCTOU `/token` exists→insert, tombstone ở establish/absolute lệch với family, spec §11 dòng trùng.
- Bàn giao: tester — kiểm acceptance T1–T4 (xem review-senior "Security invariants").

## [2026-10-12 13:00] tester (QA / Test Automation)
- Đã làm: Preflight CodeGraph (sync OK, index up-to-date); đọc STATUS + tasks.md (gồm tech-lead fold) + review senior/techlead; đối chiếu acceptance T1–T4 với test hiện có qua CodeGraph/grep.
- Verify THẬT (Git Bash, Mongo rs0@27117 + Redis@6479): `pnpm typecheck` 0; `pnpm lint` (src+test) 0; `pnpm test` **127/127**; `pnpm test:int` **379/379** (baseline 376 + 3 QA).
- Thêm 3 test QA vào `be/test/session-reflection.int-spec.ts` (Redis+Mongo thật, KHÔNG sửa code sản phẩm): (a) AT sau refresh-rotate mang `sid===sessionRef` ở mức endpoint (baseline chỉ assert doc); (f) AT legacy không `sid` vẫn active + userinfo 200 **sau** `revokeAllForUser` (tombstone không over-block); exposure `sid` không vào body /introspect (e2e, cả JSON string). Suite 5→8, pass.
- Flakiness: lượt `test:int` ĐẦU (reporter tương tác) báo *transient* 3 suites/15 fail + "Jest did not exit" (open handles treo); chạy lại CI reporter trên cùng container → xanh. Kết luận nhiễu môi trường, không regression. Ghi **DEBT-054** (không chặn).
- File đổi: runs/17-introspect-hardening/test-report.md (mới), be/test/session-reflection.int-spec.ts (+3 test), backlog.md (DEBT-054), STATUS.md, log.md.
- Kết quả: **PASS — 506/506** (unit 127 + int 379). Mọi acceptance T1–T4 + spec §8/§9.8/§11/§14/§15 có ≥1 test; risk matrix (authz/credential/input/state/dependency/request-chain/exposure) phủ; fail-closed xác nhận; không bypass/cross-tenant/replay/rò secret ẩn.
- Bàn giao: **orchestrator** — đóng run 17 (code chưa commit, chờ orchestrator).

## [2026-10-12] orchestrator
- Đã làm: commit code `70842e0`; viết `summary.md`; cập nhật `STATUS.md` (đóng run 17, thêm dòng Tiến độ).
- Kết quả: DONE — run 17 đóng.
