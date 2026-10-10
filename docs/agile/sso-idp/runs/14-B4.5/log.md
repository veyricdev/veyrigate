# Log — run 14 — B4.5 (refresh grant + rotation + reuse detection + /revoke)

## 2026-10-10 — analyst

- Preflight CodeGraph: `codegraph 1.6.2`, status "Index up to date" (167 files, 2549 nodes), `codegraph sync` → already up to date. (⚠ index built by v1.5.0 — không block analyst, ghi lại cho dev.)
- Đọc trước: STATUS.md, `runs/13-B4.4/summary.md` (ranh giới B4.4↔B4.5), plan.md §5 (dòng B4.5) + §12 (D7/Q4/Q6), spec §9.5 + INV-10/11/12 + §10 + §endpoints `/revoke`, backlog.md (DEBT-025/026/027...).
- Khảo sát code thật: `RefreshTokenSchema` đã B4.5-ready (đủ `parentId/revokedAt/replacedBy/reuseDetectedAt/deviceId/ip/userAgent`, index unique `tokenHash` + `familyId` + TTL). `TokenService.mintRefreshToken` (B4.4) insert tối thiểu (familyId mới, parentId=null, **chưa** ghi device/ip). Controller `/token` chỉ xử lý `authorization_code`. Audit enum đã có `TOKEN_REFRESHED/TOKEN_REUSE_DETECTED/TOKEN_REVOKED`. **Chưa** có `/revoke`.
- **spec.md / plan.md KHÔNG sửa** (đã tồn tại, không có REJECT yêu cầu đổi).
- Viết `runs/14-B4.5/tasks.md`: 5 task [BE] (atomic, acceptance đo được, security invariants trỏ INV-10/11/12 + exposure budget + failure cases), kéo DEBT-025 vào phạm vi.
- **❗ Quyết định chưa chốt (chặn một phần Task 4)**: `/revoke` "theo thiết bị" — **không có nguồn `deviceId` tin cậy** tại `/token`/`/revoke` (server-to-server, code data không mang deviceId). Đề xuất MVP: `/revoke` làm **token + family**, **hoãn device-revoke** (Task 5 ghi DEBT-device-revoke). → cần tech-lead xác nhận trước khi dev làm Task 4.
- Cổng: analyst ✅ → đề nghị chuyển **tech-lead**.

## 2026-10-10 — tech-lead

- Preflight CodeGraph: 1.6.2, index up to date, `sync` → already up to date.
- Đối chiếu code: `token.service.ts` (`mintRefreshToken`, `signIdToken(AuthorizationCodeData)`), `token.controller.ts` (`grant_type` chặn trước client auth), `token.errors.ts` (chưa có `invalid_scope`), `refresh-token.schema.ts` (`replacedBy: ObjectId`), `client-authentication.service.ts`, logger redact (`token`/`refresh_token` đã có).
- **Kết luận: PASS (có fold)**. Đã fold vào `tasks.md`: thứ tự 2→1→3→4→5; `replacedBy` ObjectId; bind `clientId` + `allowedResources` (INV-14) vào filter atomic; phân loại sau `null` (khác client/hết hạn/đã `/revoke` ≠ reuse); `unauthorized_client`; thêm `invalid_scope`; refactor dispatch; kiểm scope trước rotate; ID/access token từ refresh không `nonce`/`auth_time`; failure semantics không transaction; `/revoke` = revoke family (bỏ `revoke_scope`), dùng chung parse/auth, audit khi `modifiedCount>0`.
- **Chốt câu hỏi mở**: device-revoke **hoãn** → DEBT-031. Thêm DEBT-032 (transaction rotation, B7), DEBT-033 (discovery revocation_endpoint, B4.6).
- Ghi `review-techlead.md`. Cổng: tech-lead ✅ → **backend-dev**.

## 2026-10-10 — backend-dev

- Preflight CodeGraph: 1.6.2, index up to date, `sync` → already up to date. Hạ tầng test: khởi động lại `vg-test-mongo@27117` (rs0, rs.status().ok=1) + `vg-test-redis@6479` (đang Exited → `docker start`).
- Task 2: gộp mint về 1 helper `TokenService.insertRefreshToken` (nhận `familyId/parentId/expiresAt/_id?/ip?/ua?`); B4.4 first-token + B4.5 hậu duệ chung đường. Nới chữ ký `signIdToken({userId,nonce?})` + thêm `signTokensForRefresh`/`accessTokenLifetime`.
- Task 1: `refresh-token.service.ts` mới — `rotate` 1 lệnh `findOneAndUpdate` atomic (filter bind `tokenHash`+`clientId`+`revokedAt:null`+`expiresAt>now`+`resource∈allowedResources` INV-14), sinh trước `successorId` cho `replacedBy`; `classifyMiss` chỉ coi là reuse khi `revokedAt`&&`replacedBy` → `revokeFamily` + audit `TOKEN_REUSE_DETECTED`; `revokeByToken` cho /revoke.
- Task 3: controller tách dispatch (client auth chung cho `authorization_code`+`refresh_token`, khác → `unsupported_grant_type`); nhánh refresh: thiếu grant → `unauthorized_client`, thiếu param → `invalid_request`, scope leo thang → `invalid_scope` (đọc trước, không rotate), resource lệch → `invalid_target`, reuse/concurrency → `invalid_grant`; thêm `invalid_scope` vào `TokenErrorCode`.
- Task 4: `POST /revoke` (RFC 7009) dùng chung parse/auth với `/token`; revoke cả family bind `clientId` (IDOR), bỏ qua `token_type_hint`, luôn 200 trừ auth-fail 401 / DB-fail 500; audit `TOKEN_REVOKED` chỉ khi `modifiedCount>0`.
- Task 5: thêm `test/refresh-token.int-spec.ts` (22 test real Mongo: concurrent→đúng 1 hậu duệ + family revoked, reuse→family revoked+alert, scope escalation từ chối, cross-client guard, /revoke idempotent & IDOR, fail-closed 500). DEBT-031 đã có; DEBT-025 cập nhật "không phát sinh" (rotation dùng `findOneAndUpdate`, không thêm Lua/ioredis cmd). Sửa wiring test B4.4 (thêm provider `RefreshTokenService`).
- Verify (thật): typecheck EXIT=0 · lint EXIT=0 · `pnpm test` **80/80** · `pnpm test:int` **252/252** (230 cũ + 22 mới, 15 suites, không regress). Tổng **332**.
- Cổng: backend-dev ✅ → đề nghị chuyển **senior-reviewer**.

## 2026-10-10 — senior-reviewer (lượt 1)

- Preflight CodeGraph: 1.6.2, `sync` OK (2 added / 5 modified). Đọc STATUS, tasks.md, review-techlead.md, diff + `refresh-token.service.ts`, `refresh-token.int-spec.ts`. Tự verify: typecheck EXIT=0, `test:int -- refresh-token` 22/22.
- **Kết luận: REJECT** (1 🔴): race giữa `rotate` (insert hậu duệ sau swap) và nhánh reuse `revokeFamily` → hậu duệ có thể mint SAU `updateMany`, nên còn sống trong family đã báo reuse (INV-11). Test concurrent chỉ xanh nhờ timing → cần fix (đánh dấu-rồi-kiểm hoặc insert-trước-swap) + test race deterministic.
- 🟡: pre-check scope không lọc active (replay R đã rotate + scope sai → né reuse detection); scope rỗng/lặp; thiếu test retry sau fail-closed; file ngoài phạm vi `.vscode/mcp.json`/`.mcp.json`; hỏng encoding log/comment. ✂️ net -12.
- Ghi `review-senior.md`. Cổng: senior ❌ → **backend-dev**.
## 2026-10-10 — backend-dev (retry 1)

- Preflight CodeGraph: 1.6.2, status up to date, `sync` → already up to date. Containers `vg-test-mongo@27117` (rs0) + `vg-test-redis@6479` đang Up.
- 🔴 Race INV-11 (mark-then-check, không transaction): `revokeFamily` nhánh reuse stamp `reuseDetectedAt` **trước** `updateMany` revoke; `rotate` sau khi insert hậu duệ S re-read `reuseDetectedAt` của parent → nếu đã stamp thì self-revoke S + ném `RefreshRotationError`. Bảo đảm S không sống sót dù mint trước/sau revoke của nhánh reuse.
- 🟡1 pre-check scope lọc `revokedAt:null, expiresAt>now` → replay R đã rotate kèm scope sai vẫn kích hoạt reuse (invalid_grant + family revoked + alert), không né bằng invalid_scope. 🟡2 dedupe scope; `scope=` rỗng → giữ scope gốc (RFC 6749 §6). 🟡3 test retry sau fail-closed → invalid_grant + family revoked. 🟡5 encoding log/comment về UTF-8.
- Ponytail: bỏ `RotationFailure`+field `failure`; bỏ `userId` thừa trong `revokeFamily`; gom `AuditCtx`; bỏ `issuedAt` thừa; bỏ `deviceId?` chưa dùng; đổi mô tả `invalid_grant`. KHÔNG đụng `.vscode/mcp.json`/`.mcp.json` (ngoài phạm vi).
- Verify (thật): typecheck EXIT=0 · lint EXIT=0 · `pnpm test` **80/80** · `pnpm test:int` **256/256** (15 suites; refresh-token 26/26 gồm test race deterministic). Không regress. Không commit.
- Cổng: backend-dev ✅ retry 1 → đề nghị chuyển **senior-reviewer** (lượt 2).

## [2026-10-10 11:30] senior-reviewer (lượt 2)
- Đã làm: Preflight CodeGraph 1.6.2 + sync. Rà mọi interleaving của mark-then-check (stamp/updateMany/insert S/re-read). Tự verify: typecheck EXIT=0, `test:int -- refresh-token` 26/26.
- Kết quả: **REJECT** — 🔴 lượt 1 (rotate↔reuse) ĐÃ ĐÓNG. 🔴 MỚI: rotate↔`/revoke` song song. `revokeByToken` không stamp nên S mint sau `updateMany` vẫn sống dù `/revoke` đã trả 200 (bypass revoke/logout; B4.7/B6.3 dùng lại `revokeFamily`).
- 🟡: test "deterministic" còn `setTimeout(150)` + assert lỏng nhánh A. 🟡 lượt 1 (1,2,3,5) + ponytail đã xong; `.mcp.json` đóng (ngoài phạm vi).
- File đổi: `runs/14-B4.5/review-senior.md`, `log.md`, `STATUS.md`.
- Bàn giao: **backend-dev** — luôn stamp marker (vd `familyRevokedAt`) trong `revokeFamily` + rotate đọc lại cả hai dấu, HOẶC insert-trước-swap; kèm test gate `/revoke`.

## 2026-10-10 — backend-dev (retry 2, CUỐI)

- Preflight CodeGraph 1.6.2, sync → already up to date. Containers vg-test-mongo@27117 (rs0) + vg-test-redis@6479 Up.
- 🔴 race rotate↔/revoke (cùng lớp INV-11): `revokeFamily` giờ LUÔN stamp field mới `familyRevokedAt` TRƯỚC `updateMany(revokedAt)` cho MỌI đường (reuse + /revoke); reuse stamp thêm `reuseDetectedAt`. `rotate` re-read `familyRevokedAt` của parent sau khi insert S → nếu set thì self-revoke S + fail closed. Bất biến đóng với mọi interleaving: re-read trước stamp ⟹ updateMany (sau stamp, sau re-read, sau insert S) thấy S; re-read sau stamp ⟹ rotate tự revoke S. Thêm `familyRevokedAt` vào RefreshTokenSchema + RefreshDoc. Giả định đọc/ghi trên primary (không override readPreference/writeConcern) — ghi comment.
- 🟡-L2-2: test DETERMINISTIC reuse bỏ setTimeout(150), đồng bộ bằng promise `inserted` + assert chặt A = 400 invalid_grant. Thêm test mới DETERMINISTIC /revoke: gate A trong insertRefreshToken, /revoke parent → 200, nhả A → A = 400 invalid_grant, cả family (gồm S) revoked.
- 💭: pre-check thêm resource ∈ allowedResources cho nhất quán với filter rotate; comment giả định primary read/write. KHÔNG đụng .vscode/mcp.json / .mcp.json.
- Regression-probe: tắt stamp familyRevokedAt → 3 test race (reuse + /revoke + concurrent) FAIL; bật lại → xanh. Chạy test:int refresh-token 4 lần đều 27/27, không flaky.
- Verify (thật): typecheck EXIT=0 · lint EXIT=0 · pnpm test 80/80 · pnpm test:int 257/257 (15 suites; refresh-token 27/27). Không regress, không commit.
- Cổng: backend-dev ✅ retry 2 → đề nghị chuyển senior-reviewer (lượt 3).
## 2026-10-10 11:39 — senior-reviewer (lượt 3) — PASS
- Preflight CodeGraph: sync OK. Đọc STATUS + review lượt 2 + diff efresh-token.service.ts, schema, efresh-token.int-spec.ts.
- 🔴 lượt 2 (rotate↔/revoke) ĐÓNG: evokeFamily stamp amilyRevokedAt (bind clientId) trước revoke updateMany cho mọi đường; otate re-read dấu của cha sau insert → self-revoke. Lập luận: (c) sau stamp → self-revoke; (c) trước stamp → revoke-pass bắt hậu duệ. Đúng cho reuse‖/revoke, /revoke bằng member bất kỳ, rotate lồng nhau (quy nạp), lỗi giữa chừng (fail closed). Không còn writer evokedAt nào khác trong be/src.
- Tự verify: typecheck EXIT=0, lint sạch, test:int refresh-token 27/27, full test:int 257/257.
- 🟡 → backlog DEBT-034 (bất biến stamp-trước chỉ giữ bằng quy ước; B4.7/B6.3), DEBT-035 (thiếu test tất định nhánh revoke-pass bắt hậu duệ + /revoke bằng con active), DEBT-036 (JSDoc/spec lệch amilyRevokedAt, ponytail -35 dòng, guard parent null).
- Cổng: senior ✅ PASS → **tester**.
## 2026-10-10 11:46 — tester — PASS (342/342)

- Preflight CodeGraph 1.6.2, `sync` → already up to date. Containers vg-test-mongo@27117 (rs0) + vg-test-redis@6479 Up. Terminal = Git Bash.
- Đối chiếu acceptance Task 1–5 (gồm tech-lead fold) với test hiện có: dev đã phủ gần như toàn bộ với test chất lượng cao (deterministic, dùng gate promise cho race — KHÔNG hard sleep; setup qua API/factory; selector/assert theo kết quả DB+audit).
- Bổ sung **5 test QA** vào `be/test/refresh-token.int-spec.ts` (27→32) cho các tổ hợp rủi ro dev chưa phủ riêng: (1) `grant_type=password`/rỗng/absent → unsupported_grant_type (dispatch, fold Task 3; dev chỉ có `client_credentials`); (2) invalid_scope KHÔNG phát audit reuse (exposure/false-alarm budget); (3) CONCURRENT /revoke (Promise.all) → 2×200, đúng 1 audit (atomic idempotency, dev chỉ có sequential); (4) /revoke token hết hạn → 200 (RFC 7009 no-leak); (5) resource mismatch bị chặn trước khi burn token (non-destructive). KHÔNG sửa code sản phẩm.
- Chạy thật: typecheck EXIT=0 · lint EXIT=0 · `pnpm test` 80/80 · `pnpm test:int` **262/262** (15 suites; refresh-token 32/32). Verbose xác nhận 5 QA test ✓. Grep: không literal TTL hard-code trong src (chỉ test const).
- INV-10/11/12/14 đều có ≥1 test đo được; /revoke RFC 7009 (enumeration/IDOR/idempotent/fail-closed) phủ đủ; fail-closed Redis/Mongo/audit/signer assert 500 + body không leak token/secret (sentinel `SECRET-detail` chỉ ở server log, sink được phép).
- Lưu ý KHÔNG chặn: DEBT-035 (test tất định nhánh "rotate re-read TRƯỚC stamp → revoke-pass bắt hậu duệ" + /revoke bằng con active) hoãn B4.6 — INV-11 hiện đã có 1 random + 2 deterministic + QA concurrent /revoke, đủ cho acceptance B4.5.
- Output đầy đủ: `runs/14-B4.5/test-report.md`. Cổng: **tester ✅ PASS** → orchestrator đóng run (code chưa commit).