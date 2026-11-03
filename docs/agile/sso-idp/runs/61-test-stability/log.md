# Log — run 61

- orchestrator: mở run độ ổn định test DEBT-448/450/432/206/096.

## [2026-10-28 17:13] tech-lead
- Đã làm: Preflight codegraph 1.6.2 (sync Done). Đo boot full-app (`security-headers`): ấm 15,8/16,4 s, `--no-cache` 30,9 s. Gốc DEBT-448: `beforeAll` timeout ⇒ app mồ côi (afterAll bỏ qua vì `full` chưa gán), `bootFullApp` không tự dọn khi lỗi; 2 sự cố xảy ra ở lượt full ngoài ý muốn (DEBT-452). DEBT-450 P≈1/1 400; DEBT-432 steps render sau 3 `/token` tuần tự.
- File đổi: `runs/61-test-stability/tasks.md` (fold), `review-techlead.md`, `log.md`, `backlog.md` (mở DEBT-452/453), `STATUS.md`.
- Kết quả: PASS — 5 task (T1 448, T2 450, T3 432, T4 206, T5 096 có điều kiện thoát), tải giả lập + lặp N + mutation.
- Bàn giao: backend-dev (T1 → T4 → T5 → chứng minh ổn định) song song frontend-dev (T2, T3).

## [2026-11-02 17:10] backend-dev
- Đã làm: T1 `bootFullApp` tự dọn khi ném lỗi (đóng app/module trước, drop DB qua kết nối mới, xoá keyDir, ném lại lỗi gốc); `FULL_APP_BOOT_TIMEOUT_MS = 70_000` (max hook dưới tải 22,8 s ×3) + `closeFullApp(booting)` ở 11 file/13 hook (`b73c` S1 boot trong thân test tự đóng nên giữ). Lượt full dưới tải đỏ thêm `indexes`/`admin-target-risk`/`seed-e2e-admin` ⇒ 15 hook tự dựng (seed, seed-risk, indexes, seed-dev×2, authentication, consent, seed-e2e-admin, ui-auth, clients, authorize-params, authorize, oauth-tenant-isolation, identity, tenant-context) giữ promise setup + afterAll chờ; 10 test nâng riêng có số đo (seed-risk 10 vòng 660 s, DEBT-178 45 s; clrl XFF 40 s; run57 M1 30 s; run56 L6 25 s; indexes 60/45/35 s; admin-target-risk 45 s; admin-api DEBT-161 25 s). ts-jest transpile-only KHÔNG thử: hook boot ấm 1,5–2,5 s vs `--no-cache` 2,1–2,5 s (< 40 %; chi phí transform nằm ở import, ngoài hook). T4 heartbeat 0 ⇒ `lost`+warn, teardown release 0 ⇒ warn, lost/0 ⇒ globalTeardown ném ⇒ jest 30 exit 1. T5 gỡ `--forceExit` khỏi `test:int`.
- Đo (máy 28 lõi; tải = scratchpad `load2.mjs` 28 worker_threads busy-loop, tự dừng; 14 worker không làm chậm): security-headers rảnh 12,9 s / hook 2,3 s ⇒ 28 worker 49,7 s / 18,8 s (3,9×). Pha boot rảnh: compile 0,2–0,4 s, init+ready 0,8–1,6 s, syncIndexes 0,3–0,6 s; dưới tải: 0,2–1,7 / 7–17 / 3–9 s. Hook boot rảnh/no-cache/tải: headers 2,1/2,1/17,1–26,1; run56 2,1–5,1/2,1/18,0–25,8; runbook 1,7–6,4/2,5/12,1–20,4; seed 1,5–3,4/1,5/16,6–20,1; seed-risk 1,4/1,3/17,2–20,2; apc 1,6–2,2/1,7/12,1–20,5; clrl 1,3–3,2/1,5/12,2–17,4 s.
- Mutation T1 (hook security-headers): bản cũ 1 ms ⇒ keyDir mồ côi, 1700 ms ⇒ DB `vg-int-headers-*` + keyDir mồ côi; bản mới 1 ms ×3 + 1700 ms ⇒ security-headers đỏ, run56 xanh, 0 DB, 0 keyDir, tự thoát. Spec tạm (đã xoá): boot ném ở compile/app.init ⇒ lỗi gốc, 0 keyDir, 0 DB, tự thoát. Drill DB/keyDir do drill tạo đã dọn đúng tên. Khôi phục sha256 OK.
- T4 drill (`vg:int-lock` trên 6479, so giá trị): A ghi đè ⇒ warn + exit 1, key còn giá trị drill ⇒ dọn; B ghi đè rồi trả token sau 34 s (4 suite) ⇒ exit 1 chỉ nhờ heartbeat; không drill exit 0. Mutation bỏ `n === 0` ⇒ B exit 0; bỏ cả hai kiểm ⇒ A exit 0; khôi phục sha256 OK.
- Bằng chứng: 7 suite ×3 dưới tải 192/192 ×3, 0 timeout (672/636/656 s). `test:int` full sau sửa cuối: dưới tải 1420/1420 2661 s; rảnh 1420/1420 566 s và 500 s. T5: probe `--detectOpenHandles` không `--forceExit` 1420 xanh, 0 handle, thoát 3 s; 3 lượt cuối thoát 1/0/0 s sau dòng tổng kết (cả lượt đỏ trước đó cũng thoát 1–2 s) ⇒ giữ gỡ `--forceExit`. be unit 630, typecheck/lint/build 0, root `pnpm lint` 0, `pnpm -r run typecheck` 0.
- File đổi: `be/test/full-app.ts`, `int-preflight.mjs`, `int-teardown.mjs`, `be/package.json`, 28 `be/test/*.int-spec.ts` (xem diff); `backlog.md` (đóng 448/206/096/054, mở 454–456), `tasks.md`, `STATUS.md`.
- Kết quả: T1/T4/T5 PASS. Debt mới DEBT-454 (DB `vg-int-*` mồ côi 581, gồm 10 từ lượt đo bị huỷ), DEBT-455 (biên timeout còn sát), DEBT-456 (`--testTimeout` truyền lại thành mảng).
- Bàn giao: senior-reviewer (song song frontend-dev T2/T3).

## [2026-11-02] senior-reviewer (BE)
- Đã làm: review `git diff -- be/` (full-app, int-preflight/teardown, package.json, 28 int-spec) theo invariant (không nuốt lỗi, lock-lost không rò đường thường, thứ tự dọn vs index build, gỡ `--forceExit`, lộ secret/log); đối chiếu `timing-*.tsv`. typecheck/lint 0, be unit 630 xanh; không chạy int/E2E.
- Kết quả: **PASS**, 0 🔴. Chấp nhận hạ hook về 70 s (max hook full-app dưới tải 22,8–25,8 s ⇒ ≥ 2,7×) và mở rộng 15 hook (có số đo: seed-e2e-admin 31,8 s/20 s, indexes 26–30 s/30 s). 🟡: import AppModule chỉ để lấy hằng số (DEBT-461); `closeFullApp` không chờ seed của `beforeAll` (DEBT-462); 2 kiểu mẫu + nuốt lỗi boot muộn + `rm` không catch (DEBT-463).
- File: `runs/61-test-stability/review-senior-be.md`, `backlog.md` (DEBT-461–463), `STATUS.md`, `log.md`.
- Bàn giao: tester (BE).

## [2026-11-03] frontend-dev
- Đã làm: T2 `fe-admin/test/session-store.test.ts` dùng fixture JWT thật (AT/IDT phân biệt, header RS256), bỏ `not.toContain("eyJ")` ⇒ kiểm {AT, IDT, RT, cookie, từng phần JWT} không có dạng rõ/base64/base64url; mọi đoạn `[A-Za-z0-9_-]{16,}` giải mã base64url không chứa bí mật hay `accessToken`/`refreshToken`/`idToken`; tập khoá + regex `tokens`. T3 `e2e/tests/lab.spec.ts` chờ `lab-replay-steps` 20 s sau `run.click()`.
- Lệch fold T3: BỎ `expect(run).toBeEnabled()`. Sau replay họ RT bị thu hồi ⇒ mất session ⇒ nút `lab-replay-run` bị gỡ khỏi DOM (thay bằng link Sign in), nên lượt đầu đỏ 10/10 ở dòng đó (cả 3 step PASS). `setSteps` chạy sau khi xong cả chuỗi, nên `lab-replay-steps` hiện ra đã là tín hiệu hoàn tất.
- Mutation T2 (`store.ts` sha 151812f3… trước/sau): M1 rõ, M2 base64url(JSON), M3 thêm field `accessToken`: cả 3 RED. Riêng nhánh giải mã (tắt tạm vòng rõ/base64) vẫn bắt M2. Test file khôi phục sha c2fe43e9…. 10 000 mẫu `create` (vg-test-redis, chỉ DEL key tự tạo, probe tạm đã xoá): kiểm cũ dính `eyJ` 24 lần, kiểm mới 0. 50/50 lượt xanh.
- Mutation T3: `replayRefreshToken` no-op ⇒ RED (step-2 "FAIL — old refresh_token was ACCEPTED"). `client.ts` khôi phục sha 9031f209…, git sạch. Lượt mutation đầu bị gián đoạn: webServer BE quá 120 s ⇒ chạy lại (DEBT-464).
- Ổn định E2E (cổng trống, không `E2E_REUSE`, DB `sso-idp-e2e`): `--repeat-each=10` rảnh 10/10 (1,8 phút), dưới tải 28 worker_threads 10/10 (4,4–6,5 s/lượt, 5,4 phút). Full E2E 36/36 (4,2 phút).
- Verify: `pnpm -C fe-admin test` 1533/1533 (66 file), `typecheck` 0, `lint` 0. `pnpm -C e2e typecheck` 0.
- File đổi: `fe-admin/test/session-store.test.ts`, `e2e/tests/lab.spec.ts`; backlog đóng DEBT-450/432, mở DEBT-464. Bàn giao: senior-reviewer (FE).

## [2026-11-03] senior-reviewer (FE)
- Đã làm: review T2/T3 (`session-store.test.ts`, `lab.spec.ts`). Đọc `store.ts`, `Lab.tsx`, `refresh.ts`. Xác nhận nút `lab-replay-run` bị gỡ sau thu hồi họ RT (`refresh.ts:97` clear ⇒ re-render nhánh `lab-replay-signin`) ⇒ bỏ `toBeEnabled` là đúng. Probe offline 100 000 mẫu AES-GCM cùng fixture: kiểm cũ 278 lần dính, kiểm mới 0; P sai dương của nhánh giải mã ≈ 7·10⁻¹⁵ mỗi lượt. fe-admin typecheck/lint 0, e2e typecheck 0. Không chạy được session-store test vì `vg-test-redis` tắt (không khởi động container theo ràng buộc). Không chạy E2E/int.
- Kết quả: **PASS**, 0 🔴, 0 🟡. 💭: thêm assert `lab-replay-signin` hiện ra sau replay. DEBT-464 hợp lệ. Không mở debt.
- File: `runs/61-test-stability/review-senior-fe.md`, `log.md`, `STATUS.md`.
- Bàn giao: tester (FE).

## [2026-11-03] tester
- Đã làm: `docker start vg-test-mongo vg-test-redis` (trước Exited; dừng lại sau khi xong). `test:int` full không `--forceExit`; mutation T1 (ném sau compile/init/sync, spec tạm + đối chứng tắt dọn); đọc T4 + drill A; fe-admin full + session-store ×20; lab replay ×5.
- Kết quả: **PASS**. int 1420/1420 (513,9 s), exit 0, tự thoát ≈ 0,5 s sau tổng kết; DB `vg-int-*` 607 → 610 (đúng 3 DB `authorize`/`clrl`/`demo` của DEBT-454, 0 từ suite full-app), keyDir 19 → 19. Mutation T1: 3 stage ⇒ lỗi gốc, 0 DB, 0 keyDir; đối chứng RED (1 DB + 1 keyDir mỗi stage, đã dọn đúng tên); `full-app.ts` sha256 OK. Drill A ⇒ warn heartbeat + teardown, test xanh nhưng exit 1, key giữ giá trị drill ⇒ DEL theo giá trị. fe-admin 1533/1533; session-store 20/20; lab replay 5/5 (1,4 phút). Không mở debt.
- File: `runs/61-test-stability/test-report.md`, `log.md`, `STATUS.md`.
- Bàn giao: orchestrator đóng run 61.
