# Log — run 18 — consent-session-hardening (DEBT-026/027/028/050/051/052)

## 2026-10-12 — analyst — viết tasks.md (cổng analyst)

- Preflight CodeGraph: v1.6.2, `status` OK (155 file, index v1.5.0), `sync` xong (1 file / 48 node). Đọc code qua grep/sed trên Git Bash.
- Đọc bối cảnh: STATUS.md (run 18, cổng analyst), backlog DEBT-026/027/028/050/051/052, summary run 16 (B4.7), spec §9.4/§9.5/§9.6/§9.8/§15.
- Rà soát mã nguồn thực tế:
  - DEBT-050: `authentication.service.ts:172` `resetPassword` chỉ `sessions.revokeAllForUser`, thiếu refresh family.
  - DEBT-051: `token.controller.ts:179` check `sessions.exists` TRƯỚC `issueForAuthorizationCode` (TOCTOU).
  - DEBT-052: `session.service.ts` `establish`→`revoke`→`revokeRef` ghi tombstone; `get()` absolute-expiry cũng `revokeRef` ⇒ tombstone nhưng không revoke family (lệch).
  - DEBT-026: `authorize.service.ts:201-208` nhánh covered ĐÃ gọi thẳng `issueCode` (không còn ctx write/consume thừa) → chỉ cần test hồi quy.
  - DEBT-027: `consent.service.ts` `grant` `findOne` + `findOneAndUpdate` riêng → không atomic.
  - DEBT-028: `consent.schema.ts:15` đã có unique `{userId,clientId,resource}`; cần runbook drop index cũ `{userId,clientId}`.
  - Harness race tất định `gateInsert` đã có sẵn trong `refresh-token.int-spec.ts` → tái dùng cho DEBT-051.
- Viết `tasks.md`: 5 task [BE], acceptance đo được + security invariants + § trỏ; nêu 3 quyết định mở (vị trí re-check DEBT-051; tombstone A/B DEBT-052; xác nhận DEBT-026). KHÔNG ghi đè spec.md/plan.md.
- Ngữ nghĩa cần tech-lead cập nhật spec nếu chốt đề xuất: §15 INV-29 (Task 2), §9.8 + §15(1) (Task 3).
- Đề nghị chuyển **tech-lead**.
## 2026-10-12 — tech-lead — review tasks.md (cổng tech-lead) → PASS (kèm fold)

- Preflight CodeGraph: v1.6.2, `status` OK (155 file), `sync` "Already up to date". Đọc code qua `codegraph node/query/callers`.
- Đối chiếu: `authentication.service.ts:172`, `token.controller.ts:169`, `token.service.ts:76/256`, `refresh-token.service.ts:352-449`, `ui.controller.ts:248-261`, `session.service.ts:145-269`, `authorize.service.ts:204`, `consent.service.ts:100`, `validation.schema.ts:61`, `sync-indexes.ts`, mongoose 9.10.2 `updatePipeline`.
- Quyết định: Q1 re-check ở **controller** (đề xuất B sai chỗ — method ở `TokenService`, gây vòng DI); thêm **SWEEP** (revoke family lần 2 sau revoke session) ở logout + reset để đóng race còn lại; revoke đúng `familyId`, không `revokeForSession`. Q2 **Phương án A** (re-login/`prompt=login`/`max_age`/absolute không tombstone, không revoke family). Q3 DEBT-026 đóng bằng test hồi quy. DEBT-050: setPassword → revoke family → revoke session → sweep → audit; revoke lỗi ⇒ 5xx, không rollback mật khẩu.
- Fold vào `tasks.md` (5 task + "Đã chốt" + "Cập nhật spec.md" §8/§9.8/§14/§15 inv.28-29). Thêm DEBT-055 vào backlog.
- Ghi `review-techlead.md`. Chuyển **backend-dev**.
## 2026-10-12 — backend-dev — triển khai 5 task [BE] (cổng backend-dev)

- Preflight CodeGraph: v1.6.2, status OK (155 file), `sync` Already up to date. Đọc code qua Git Bash (`cat -n`/`grep -e`/`sed`).
- T1 (DEBT-050): `resetPassword` thứ tự setPassword → revoke family → revoke session (MARK) → revoke family (SWEEP) → audit; DI `AuthenticationModule` import `OauthModule`; revoke lỗi ⇒ 5xx, không rollback mật khẩu (unit test `invocationCallOrder` + fail-closed; int `resetPassword` thật: refresh cũ ⇒ `invalid_grant`, `familyRevokedAt != null`, AT `sid` inactive qua `isAccessTokenLive`).
- T2 (DEBT-051): `issueForAuthorizationCode` trả `{response, familyId}`; `TokenController` re-check `exists` SAU insert ⇒ `revokeFamily(familyId)` + `invalid_grant`; SWEEP revoke family lần 2 ở logout local/global. Race tất định: gate insert + logout chen; + fail-closed Redis lỗi ⇒ 500.
- T3 (DEBT-052 PA A): thêm `revokeRef(ref, userId, tombstone=true)` + `revoke(id,{tombstone})`; `establish(oldId)` + nhánh absolute `get()` truyền `false` (xoá phiên, KHÔNG tombstone, KHÔNG revoke family); fix comment `isEnded`/`revokeRef`. Int: absolute dùng clock giả; re-login giữ `offline_access` sống.
- T4 (DEBT-026/027): `grant` 1 update-pipeline atomic (`updatePipeline:true`, `$literal` request/allowed, `$setIntersection` lọc allowed, `grantedAt` chỉ set insert); test union/race ≥20 lần, injection `$grantedScopes`; DEBT-026 covered branch không tạo `authz_ctx:*`.
- T5 (DEBT-028): `docs/agile/sso-idp/runbook-deploy.md` (backfill `resource:''` → kiểm duplicate → `db:sync-indexes` → verify + Redis `noeviction`); int mô phỏng DB cũ: drop index cũ, fail-closed E11000 không xoá doc.
- Áp spec §8/§9.8/§14/§15 inv.28-29: văn bản đã chốt trong tasks.md mục "Cập nhật spec.md"; theo giao thức dev KHÔNG ghi đè `spec.md` → bàn giao senior áp vào `spec.md`.
- Verify: typecheck OK, lint OK, `pnpm test` = **131** (unit, +4), `pnpm test:int` = **393** (int, +14) ⇒ **524** tổng (baseline 506 + 18), không regress. KHÔNG commit. KHÔNG đụng `.vscode/mcp.json`/`.mcp.json`/`.github/agents/*`.
- Bàn giao: **senior-reviewer** — review 5 task + áp §8/§9.8/§14/§15 vào `spec.md`.
## [2026-10-12 14:58] senior-reviewer
- Đã làm: Preflight CodeGraph (v1.6.2, sync OK); review diff 5 task đối chiếu fold; tự chạy mutation M1–M8 trên int/unit (baseline 393/393), khôi phục byte-identical (SHA-256 khớp).
- Mutation: re-check/pre-revoke/tombstone/nuốt-lỗi bị bắt; SWEEP chỉ bị bắt bởi test thứ tự mock; bỏ `$literal` (M6) và `revokeFamily→revokeForSession` (M7) KHÔNG bị bắt.
- File đổi: `runs/18-consent-session-hardening/review-senior.md`
- Kết quả: REJECT — 5 🔴: thiếu audit `TOKEN_REVOKED session_ended`; re-check bỏ qua khi không mint refresh (`familyId &&`); thiếu test idle-expire giữ family cũ; test `$literal` rỗng; spec.md chưa áp (dev phải áp, senior không sửa file).
- Bàn giao: **backend-dev** — sửa 5 🔴 (+ cân nhắc 6 🟡), chạy lại M6/M7 để chứng minh test mới fail khi mutate.
## 2026-10-12 — backend-dev — retry 1: sửa 5 🔴 + 1 🟡 (cổng backend-dev vòng 2)

- Preflight CodeGraph: v1.6.2, status OK. Đọc code qua Git Bash. Containers `vg-test-mongo@27117`/`vg-test-redis@6479` up.
- 🔴#1: thêm `RefreshTokenService.revokeFamilyForEndedSession` — revoke family + audit `TOKEN_REVOKED {reason:'session_ended', count}` (KHÔNG familyId/sessionRef/token); controller gọi khi re-check thấy phiên chết. Test TOCTOU assert đúng 1 event, metadata sạch.
- 🔴#2: bỏ guard `familyId &&` → re-check chạy cho MỌI code grant; phiên chết ⇒ không trả access/id token (`invalid_grant`); best-effort revoke family khi Redis lỗi ở re-check (vẫn 500, 🟡#3). Test race tất định (spy `exists` call#2=false) nhánh không refresh.
- 🔴#3: test idle-expire (`redis.del(sess:)`, không tombstone) ⇒ F2 revoked nhưng F1 cũ `revokedAt==null` và vẫn rotate 200 (fail nếu `revokeFamily`→`revokeForSession`).
- 🔴#4: test `$literal` phân biệt — request+allowed=`['$policyVersion']` ⇒ lưu đúng literal (bỏ `$literal` ⇒ `[null]`, fail).
- 🔴#5: áp NGUYÊN VĂN 5 đoạn vào `spec.md` (§8 L218, §9.8 3 bullet, §14, §15 inv.28/29). 🟡#4: `tokenCount += sweep` + test race P=0/S=1.
- Mutation (byte-identical restore, SHA-256 khớp): M#1 reason sai ⇒ TOCTOU audit fail; M#2 `familyId &&` ⇒ non-refresh test fail; M#3 `revokeForSession` ⇒ idle+TOCTOU fail; M#4 bỏ `$literal` ⇒ consent fail; M-🟡4 bỏ `+=` ⇒ sweep-race fail.
- Verify: typecheck OK, lint OK, unit **131** pass, int **397** pass (+4 baseline 393). KHÔNG commit. KHÔNG đụng `.vscode/mcp.json`/`.mcp.json`/`.github/agents/*`.
- Bàn giao: **senior-reviewer** (vòng 2).


## 2026-10-12 — senior-reviewer — lượt 2 (sau retry 1 của backend-dev)

- Preflight CodeGraph v1.6.2 (sync). Đọc diff qua Git Bash. Baseline: int 397/397, unit 131/131, tsc OK, lint OK.
- Mutation senior tự chạy (script, khôi phục trong `finally`, SHA-256 5 file nguồn khớp): M1b guard `familyId` ✅ bắt; M2 bỏ SWEEP logout ✅ (5 fail); M3 bỏ SWEEP reset ✅ unit / ⚠️ int xanh; M4 bỏ pre-revoke reset ✅ unit / ⚠️ int xanh; M6 bỏ `$literal` ✅; M7 `revokeForSession` ✅; M10 bỏ best-effort revoke ⚠️ xanh; M11 nuốt lỗi Redis ✅.
- INV-11: `revokeFamilyForEndedSession` → `revokeFamily` → `revokeWhere` (vẫn một cửa). Best-effort revoke khi Redis lỗi không đổi fail-closed (500, lỗi gốc). spec.md khớp nguyên văn 7/7 đoạn fold.
- File đổi: `runs/18-consent-session-hardening/review-senior.md` (Lượt 2), `backlog.md` (+DEBT-056…062), `STATUS.md`.
- Kết quả: **PASS**: 0 🔴; 6 🟡 + ponytail → backlog.
- Bàn giao: **tester**.

## 2026-10-12 — tester — kiểm acceptance run 18 + lấp khe senior (cổng tester)

- Preflight CodeGraph v1.6.2 (status OK, 155 files). Đọc code qua Git Bash. Containers vg-test-mongo@27117 (rs0) + vg-test-redis@6479 up.
- Baseline xác nhận: typecheck OK, lint OK, unit 131, int 397 = 528 xanh.
- Thêm 3 int test (be/test/refresh-token.int-spec.ts), KHÔNG sửa code sản phẩm:
  - DEBT-056: sau resetPassword, del sess_end tombstone (isEnded==false) rồi rotate refresh cũ ⇒ 400 invalid_grant, family vẫn revoked. Chứng minh bảo vệ dựa vào family-revoke, không dựa tombstone.
  - DEBT-057: int race thật — gate sessions.revokeAllForUser của reset, /token code grant chạy trọn trong cửa sổ (session còn sống), release ⇒ SWEEP revoke family vừa chèn; refresh không rotate được.
  - DEBT-058: Redis lỗi re-check ⇒ 500 + family vừa mint best-effort revoke (familyRevokedAt/revokedAt set).
- Mutation kiểm load-bearing (revert nguyên trạng, không còn marker, git diff sạch): bỏ SWEEP reset ⇒ DEBT-057 RED; bỏ cả 2 revoke family reset ⇒ DEBT-056 RED; bỏ best-effort revoke ⇒ DEBT-058 RED. Bỏ RIÊNG pre-revoke (giữ SWEEP) không RED (SWEEP là siêu tập) — pre-revoke đã có unit invocationCallOrder bắt.
- Xác nhận acceptance có sẵn: re-login/prompt=login KHÔNG giết AT/refresh cũ (session-reflection.int DEBT-052); logout/reset giết (refresh-token B4.7 + reset block); consent union đồng thời + lọc allowedScopes + chống \ injection (consent.int DEBT-027); covered branch không ghi authz_ctx thừa (authorize.int DEBT-026); drop index cũ {userId,clientId} (indexes.int DEBT-028).
- Full suite cuối: typecheck OK, lint OK, unit 131, int 400 = 531 xanh.
- File đổi: be/test/refresh-token.int-spec.ts (+3 test), runs/18-consent-session-hardening/test-report.md (mới), backlog.md (DEBT-056/057/058 → Đã đóng), STATUS.md, log.md. KHÔNG đụng .vscode/mcp.json/.mcp.json/.github/agents/*.
- Kết quả: **PASS** 531/531. Đóng DEBT-056/057/058.
- Bàn giao: **orchestrator** — đóng run 18.

## [2026-10-12] orchestrator
- Đã làm: commit code `46da89a`; viết `summary.md`; cập nhật `STATUS.md`; chuyển các DEBT đã xử lý ở run 16–18 sang bảng Đã đóng của `backlog.md`.
- Kết quả: DONE — run 18 đóng.
