# Log — run 34 — B7.1 security test suite (+ test infra DEBT-195/199/201/202)

## orchestrator — 2026-10-19
- Mở M7 hardening. spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §B7 (B7.1), spec §14 (ma trận), §15 (INV) + backlog test-infra (DEBT-195, 199, 201, 202). Cổng → tech-lead.

## tech-lead — 2026-10-19
- **PASS** (có điều kiện, fold vào `tasks.md` mục "Fold tech-lead"). Review: `review-techlead.md`.
- Q-34.1: khoá chạy đơn Redis `vg:int-lock` (SET NX PX 120s + heartbeat 30s + teardown so-giá-trị-rồi-DEL) + `--testTimeout=20000`; Mongo đã cách ly theo spec (`vg-int-*-${Date.now()}`).
- Q-34.2: khảo sát ~42 dòng §14: 35 có, 5 thiếu test (refresh song song HTTP, logout∥/token song song, enumeration HTTP, verify-email song song), 2 lỗi sản phẩm (cross-tenant issuance/consent = DEBT-116), 1 ngoài phạm vi (cookie đa trình duyệt, X3). Run 34 chỉ test; debt sản phẩm hẹn "B7.1" tách sang run 35 (B7.1b: DEBT-116/128/141/144/156, qua analyst) và run 36 (B7.1c: 140/142/147/150/151/155/166/197).
- Q-34.3: không cần replica set (không transaction/change stream; URI `directConnection=true`); job `int` với mongo:7@27117, redis:7@6479, mailpit v1.21@1025/8025; cấm đặt `TEST_MONGO_URI`.
- Phân công: Task 1, 3, 4 → backend-dev; Task 2 → tester (song song Task 1).
- Debt mới: DEBT-203.

## tester — Task 2 (ma trận truy vết) — 2026-10-19
- Tạo `docs/agile/sso-idp/security-matrix.md`: bảng §14 có 47 dòng (tách dòng gộp thành dòng con), bảng §15 có 30 dòng (INV-24 tách thành 24a control-plane và 24b OAuth). Chỉ đọc code/test (CodeGraph + grep), không chạy hạ tầng, không sửa `be/`. Preflight: `codegraph sync` báo index đang bị khoá bởi daemon (PID 14096) đang chạy, nên dùng index của daemon.
- Kết quả: §14 có 39 / một phần 2 (SE12, AE6) / thiếu 3 (R1, AE4, AE8) / lỗi sản phẩm 2 (MT1, MT2: DEBT-116 → run 35) / ngoài phạm vi 1 (CK1: X3, DEBT-008). §15 có 25 / một phần 4 (INV-10, 15, 19, 27) / lỗi sản phẩm 1 (24b: DEBT-116). Tổng 77 dòng.
- Lệch so với khảo sát tech-lead (35/5/2/1): thêm 2 khoảng trống mới, đều đưa vào Task 3. (1) **AE4**: đăng nhập local khi chưa verify email chưa có test (`login` từ chối `!emailVerifiedAt`, nhưng chưa test nào chạm nhánh này). (2) **INV-15**: `resource` lặp ở `/authorize` chỉ được kiểm trong trường hợp lọt sang admin. `AuthorizeParams.resource` không có class-validator nên hành vi với mảng chưa được xác minh. Enumeration và logout∥`/token` ghi `một phần` thay vì `thiếu` vì đã có unit/seam tất định. Thiếu cấp HTTP/song song thật vẫn giao Task 3.
- Đầu vào Task 3: mục "Đầu vào Task 3" cuối `security-matrix.md`, 6 test kèm kỳ vọng và mutation: #1 refresh song song, #2 logout∥`/token`, #3 enumeration HTTP, #4 verify-email song song, #5 login chưa verify, #6 `resource` lặp.
- Không mở debt mới. DEBT-116 đã có, kế hoạch run 35. KMS/Vault (INV-19) trỏ về plan B7.3 và DEBT-159.
- Vòng lặp kiểm (Git Bash, `LC_ALL=C.UTF-8`):
  ```bash
  f=docs/agile/sso-idp/security-matrix.md; ok=0; bad=0
  while IFS=$'\t' read -r path name; do
    n=$(grep -cF -- "$name" "$path" 2>/dev/null || echo ERR)
    if [ "$n" = "1" ]; then ok=$((ok+1)); else bad=$((bad+1)); echo "BAD($n): $path › $name"; fi
  done < <(grep -oP '`[^`]+ › [^`]+`' "$f" | sed -E 's/^`//; s/`$//; s/ › /\t/')
  echo "refs ok=$ok bad=$bad"
  ```
  Output: `refs ok=213 bad=0`. 213 là số lần tham chiếu, một số test được dẫn ở nhiều dòng. Kiểm ô trống bằng node: `empty-cell rows: 0`. File UTF-8, không BOM, không CRLF.

## backend-dev — Task 1 (độ tin cậy test:int) — 2026-10-19
- `be/test/int-preflight.mjs`: sau dò TCP lấy `SET vg:int-lock <host:pid:uuid> NX PX 120000` (ioredis, `TEST_REDIS_URL ?? redis://localhost:6479`); bận ⇒ throw "another test:int is running (holder, ttl); if stale: docker exec vg-test-redis redis-cli DEL vg:int-lock"; heartbeat 30s `unref` Lua so giá trị ⇒ PEXPIRE. Mới `be/test/int-teardown.mjs` (Lua so giá trị ⇒ DEL, lỗi chỉ warn). Script `test:int` + `--testTimeout=20000 --globalTeardown`. Không đổi spec/jest.config; không FLUSH, chỉ chạm key `vg:int-lock`.
- Đồng thời: lần 2 exit 1 sau 1950 ms (holder=DESKTOP-VEYRIC:40260:…, ttl=117494ms), lần 1 xanh 816/816 (244 s); PTTL 106878 ở ~100 s ⇒ heartbeat chạy. Khoá cũ `stale PX 5000` ⇒ từ chối 2024 ms; sau 6 s chạy xanh 18/18. `EXISTS vg:int-lock`=0 sau mọi lần.
- Full `pnpm -C be test:int` 3 lần liên tiếp (foreground): 35/35 suites, 816/816, 228.4/233.5/234.0 s, exit 0. `indexes.int-spec` 10/10 xanh (18/18, 11.5–16.5 s); `client-auth-rate-limit.int-spec` 5/5 xanh (16/16, ~14 s). DEBT-195/199 không cần sửa spec.
- typecheck sạch, lint sạch (sau khi import `node:console`/`node:timers` cho .mjs), unit 25 suites/303 tests xanh.
- Sự cố tự gây: lần đầu thay chuỗi bằng script không áp dụng ⇒ khoá không được lấy, 2 lần đồng thời đều chạy (5 đỏ/816 mỗi bên, tái hiện DEBT-201); đã sửa và đo lại toàn bộ.
- Đóng DEBT-195/199/201/202. Không debt mới. Đề nghị: senior-reviewer (hoặc tiếp Task 3 theo orchestrator).

## backend-dev — Task 3 + Task 4 — 2026-10-19
- Trust boundary (Task 3): tài sản RT family/session/one-time token/grant; actor client công khai, kẻ replay, kẻ dò tài khoản. Bất biến: 1 RT ⇒ ≤ 1 successor; logout ⇒ không family sống theo `sessionRef`; phản hồi auth không phụ thuộc tồn tại tài khoản; token verify dùng 1 lần; 1 grant = 1 resource. Không có 5xx trên mọi nhánh.
- 9 test mới (6 mục ma trận): `refresh-token` R1 N=5; `session-reflection` SE12 K=10 (thêm `UiController` thật vào module, logout lệch 0..90 ms ⇒ mỗi lần chạy có ~4–5 vòng `/token` 400 + ~5–6 vòng 200 đã bị revoke); `ui-auth` AE6×4 + AE4; `authentication` AE8 N=5; `authorize` INV-15.
- Mutation (sao lưu + sha256, khôi phục khớp hash): R1 bỏ `revokedAt: null` ⇒ RED 5×200. SE12: bỏ re-check sau insert ⇒ xanh 2/2, bỏ SWEEP ⇒ xanh 2/2 (2 lớp che nhau); bỏ cả hai ⇒ RED 3/3 (vòng 3, 2, 2). AE6: register "đã tồn tại" ⇒ 400 / forgot ném khi email lạ / verify-email 401 khi token đã dùng ⇒ RED; đổi chỉ thông điệp ⇒ xanh vì `HtmlExceptionFilter` che message. AE4 bỏ `!user.emailVerifiedAt` ⇒ RED (2 test). AE8 bỏ `usedAt: null` ⇒ RED 5/5 fulfilled.
- **Lỗi sản phẩm (INV-15)**: `resource` lặp ở `/authorize` ⇒ Mongoose ép mảng thành `$in` ⇒ cấp **code** cho resource khớp trước (test RED trên code cũ). Sửa 4 dòng trong `AuthorizeService.resolveResource`: không phải chuỗi ⇒ `invalid_target` (mã đã có). Probe thêm: `scope` lặp ⇒ 500, `state`/`nonce`/`client_id` lặp ⇒ được chấp nhận ⇒ mở DEBT-204 (run 35, qua analyst), không sửa ở đây.
- Task 4: `.github/workflows/ci.yml` job `int` (timeout 30, mongo:7@27117 single-node, redis:7@6479, mailpit v1.21@1025/8025 health `/mailpit readyz` như image local), `pnpm -C be test:int`; không `TEST_*`, không secret, `permissions: contents: read` giữ nguyên; comment branch protection thêm `int`/`e2e`; ghi chú cách bật rs. YAML parse OK bằng js-yaml 4.3.2 (3 job). **Chưa chạy trên runner thật**: lần push đầu là phép kiểm (thứ tự health Mailpit, thời gian). Đóng DEBT-004.
- Verify: typecheck 0, lint 0, unit 25/303 xanh; full `test:int` 3 lần 35/35 suites, 825/825 (255/232/248 s), `EXISTS vg:int-lock`=0; ma trận refs ok=227 bad=0, ô trống 0, `thiếu`=0; `pnpm -C e2e e2e` 16/16 (1.9 m), không còn listener 3000/4000/5173.
- ⚠ Sự cố tự gây: chuỗi node -e có backtick bị bash thực thi ⇒ `docker run -d -p 27117:27017 mongo:7 --replSet rs0` tạo container `funny_pascal` (trạng thái Created, KHÔNG chạy vì cổng đã bị vg-test-mongo giữ; 2 volume ẩn danh). `docker rm -v` bị chặn quyền ⇒ người dùng tự gỡ: `docker rm -v funny_pascal`. vg-test-* không bị ảnh hưởng.
- DEBT mới: 204. Đóng: 004. Đề nghị: senior-reviewer.

## senior-reviewer — 2026-10-19
- **PASS** (0 🔴). Review: `review-senior.md`. Tự kiểm: typecheck + eslint các file đổi sạch; `test:int` 5 spec đổi 128/128 (39 s), `EXISTS vg:int-lock`=0 sau chạy; ma trận refs ok=227 bad=0.
- Khoá: SET NX + Lua so token khi gia hạn/nhả ⇒ không xoá khoá người khác; Redis lỗi không treo (timeout 2 s, retry 1, forceExit); không spec nào FLUSH/xoá `*`. Test song song có assertion DB không tautology (R1 `children ≤ 1`, SE12 `live = 0`), enumeration so status+body (che CSRF/nonce)+tên Set-Cookie. Fix INV-15 đúng RFC 8707, sau Phase 1, không đổi hợp đồng. CI không secret/không `TEST_*`.
- DEBT-204 giữ 🟡 (500 là fail-closed, `client_id` `$in` vẫn bị redirect_uri ràng buộc, không bypass/cross-tenant/rò secret) → run 35.
- DEBT mới: 205 (mở rộng DEBT-204: `prompt` lặp ⇒ 500, `nonce` lặp ⇒ ID token nonce mảng, `request_id`/`client_id`), 206 (heartbeat không báo khi mất khoá). Đề nghị: tester.

## tester — nghiệm thu — 2026-10-20
- **PASS**. Báo cáo: `test-report.md`. Preflight `codegraph sync` OK. Docker Desktop khởi động lại, `docker start vg-test-mongo vg-test-redis` (không run/rm/compose/FLUSH; `funny_pascal` vẫn chờ người dùng gỡ).
- typecheck 0, lint 0, unit 25/303; `test:int` full 2 lần 35/35, 827/827 (276.8/258.0 s); FE 31/240; E2E 16/16 (1.7 m), không còn listener 3000/4000/5173.
- Khoá: lần chạy thứ 2 đồng thời bị từ chối sau 1870 ms (`another test:int is running`), lần 1 xanh; khoá cũ `stale PX 5000` ⇒ từ chối 2053 ms, sau 6 s chạy 18/18; `EXISTS vg:int-lock`=0 sau mọi lần.
- Ma trận: §14 47 (44/0/0/2/1), §15 30 (28/1/0/1/0) ⇒ 77 = 72 có / 1 một phần / 0 thiếu / 3 lỗi sản phẩm / 1 ngoài phạm vi; refs ok=229 bad=0 (thêm 2 test tester vào dòng INV-15).
- 2 test INV-15 (tester) trong `authorize.int-spec.ts`: mảng 1 phần tử/rỗng (service); `resource=A&resource=`, `resource[]=`, `resource%5B%5D=`, `resource[0]=` (HTTP). Mutation bỏ fix `typeof raw !== 'string'` (cp + sha256, khôi phục khớp) ⇒ 3/49 RED, đúng 3 test INV-15.
- CI YAML parse OK (js-yaml 3.15.2 có sẵn), job `int` không `TEST_*`/secrets; chưa chạy runner thật.
- Không debt mới. Đề nghị: orchestrator đóng run 34.

## orchestrator — 2026-10-20 (đóng run)
- Mọi cổng PASS. Commit `2007080`. Container lạc `funny_pascal` (do subagent tạo nhầm, xoá bị chặn quyền) — chờ người dùng xoá.
