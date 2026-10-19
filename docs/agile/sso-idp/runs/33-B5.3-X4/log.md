# Log — run 33 — B5.3 account linking + DEBT-189 + X4 federation E2E

## orchestrator — 2026-10-19
- Tiếp M6 sau run 32 (`4c36371`). spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §B5 (B5.3), X4, spec §9.9 bước 5, INV-22 + backlog DEBT-189 (bắt buộc), 184, 186, 182, 190. Cổng → tech-lead.

## tech-lead — 2026-10-19
- **PASS** có điều kiện: fold F1–F22 trong `tasks.md` (bắt buộc). Đối chiếu code `4c36371` (authorize maxAgeExceeded, federation client/service, AuthenticationService.login, module wiring, main.ts, e2e config).
- Q-33.1: `configureApp` + entry `be/test/e2e/e2e-main.ts` (ts-node, mock Google trong tiến trình, `overrideProvider`) + guard `dist` sạch; backend-dev làm T3. Q-33.2: không nhánh riêng — link qua `auth.login` (lock/chỉ-federated/chưa verify ⇒ lỗi generic); DEBT-186 chốt cho phép `/forgot`. Q-33.3: T1→T2→T4'(DEBT-190a+191)→T3; DEBT-182 hoãn B7.3.
- Mở DEBT-192/193/194. Chuyển → backend-dev.

## backend-dev — 2026-10-19
- Trust boundary T2: tài sản = tài khoản local có email trùng; actor = trình duyệt đã chứng minh email verified ở provider. Trạng thái: pending `fed_link` (Redis TTL 10', token chỉ trong cookie `idp_link`) → POST consume-first → binding `idp_fed` → `auth.login(email pending)` → userId khớp → FI + `ACCOUNT_LINKED`. Abuse: replay/race/CSRF/fixation/email từ form/user khác/khoá/chỉ-federated/chưa verify ⇒ không link, trang chung giống hệt. Fail-closed: Redis lỗi ⇒ 500, không cookie.
- T1 ✅ `reauthAfter` cả khi không session; Google `max_age`+`auth_time`, session `authTime` kẹp `[reauthAfter, now]`; GitHub từ chối. T2 ✅ `GET/POST /auth/link` + `link.eta` + CSP form-action RP; FederationModule khai CsrfService/CsrfGuard; helper `formCsrfIdentity`; bỏ `email_conflict`. T4' ✅ allSettled, trần body 64 KB, JWKS mạng ⇒ 502. T3 ✅ `src/bootstrap.ts#configureApp`, `be/test/e2e/{e2e-main.ts,mock-google.ts,assert-dist-clean.mjs}`, `start:e2e`, `e2e/tests/federation.spec.ts` (4 kịch bản).
- Mutation RED rồi khôi phục (cp + sha256 khớp): bỏ nhánh không session; bỏ F3; bỏ kẹp dưới; bỏ consume-first; bỏ so userId; bỏ binding POST; email lấy từ form; await tuần tự bù trừ; bỏ trần body; JWKS mạng ⇒ invalid.
- Verify: typecheck/lint sạch; BE unit 303/303; int 811/811 (35 suites); FE 240/240; E2E 16/16 ×2 liên tiếp, log không có `code=`/`state=`/`id_token`, `be/dist` sạch (probe âm ⇒ exit 1), không request ngoài localhost; :4000/:5173 trống sau chạy.
- Đóng DEBT-184/186/189/191/190(a). Mở DEBT-195 (indexes.int-spec chập chờn 2/7 lần, không liên quan run), DEBT-196 (chú thích còn trỏ `main.ts`). Cổng → senior-reviewer.

## senior-reviewer — 2026-10-19
- **PASS** (không 🔴). Kiểm độc lập theo invariant: INV-22 (callback không ghi FI hay session; POST consume-first → binding → `auth.login(email pending)` → so `userId` → FI + `ACCOUNT_LINKED`), replay/race/CSRF/fixation, enumeration (`auth.login` chỉ ném `Unauthorized`, `DUMMY_HASH`), exposure (log mã cố định, token chỉ ở cookie), `max_age`/`prompt=login` cả federation lẫn local, `auth_time` thật kẹp `[reauthAfter, now]` (session expiry không dựa vào `authTime`), INV-23 (entry/mock ngoài `src/`, build loại `test`, guard dist, chặn production), `configureApp` chuyển nguyên văn, CSP `form-action` chỉ thêm origin RP đã khớp.
- Tự chạy: typecheck/lint sạch; unit 303/303; `test:int` ×2 full: mỗi lần 810/811, cùng test đỏ `client-auth-rate-limit` › XFF share counter (không chạm; chạy riêng 16/16 ×2) ⇒ DEBT-199. Không chạy E2E.
- 🟡 mở DEBT-197 (JWKS 5xx ⇒ 400 thay vì 502), DEBT-198 (TTL `idp_fed` < pending link), DEBT-199 (int chập chờn), DEBT-200 (ponytail ~-8 dòng). Cổng → tester.

## tester — 2026-10-19
- **PASS**. BE typecheck/lint sạch; unit 303/303; int **816/816 ×2** (gồm 5 test mới T33-1…5); FE 240/240; E2E **16/16 ×2**, log không có `code=`/`state=`/`id_token`, `be/dist` sạch (guard probe âm ⇒ exit 1), không request ra ngoài localhost.
- Ưu tiên 1, test đỏ `client-auth-rate-limit` › "no TRUST_PROXY … share one counter": **không phải hồi quy**. So sánh bằng worktree tạm `ca38e20` (đã `git worktree remove`): chạy tuần tự, working tree xanh test này 7/7 lần, HEAD 2/2 lần. Chạy **song song** 2 `test:int` ⇒ test này đỏ ở 4/4 tiến trình ("Expected 401, Received 429": bucket IP `127.0.0.1` dùng chung trên `vg-test-redis`), và HEAD cũng đỏ khi chạy song song. Đỏ chập chờn còn lại là timeout 5 s, HEAD cũng có (`admin-target-risk`, `indexes` = DEBT-195). Cập nhật DEBT-199 (nguyên nhân gốc); mở DEBT-201 (chặn chạy song song), DEBT-202 (timeout 5 s).
- Test bổ sung trong `be/test/federation.int-spec.ts`: max_age khi link (T33-1) và khi login local (T33-2); bucket `login` thật dùng chung `/login` và `/auth/link`, 429 không tiêu pending (T33-3); 2 pending link cho cùng danh tính ⇒ nhánh `not_linked` (T33-4); xoay session bị cài sẵn (T33-5). Mutation: bỏ login limiter ⇒ T33-3 RED; bỏ `oldSessionId` ⇒ T33-5 RED; khôi phục bằng cp, sha256 OK. Báo cáo: `test-report.md`. Cổng → orchestrator đóng run.
