# Test Report — 2026-11-09 (run 78, sweep 🟡 BE đợt 2)

## Kết quả: PASS (gate đủ, 0 test đỏ; +15 int tester, 1 flake CLI đã tìm ra gốc và sửa ở mức test)

| Gate (tuần tự) | Kết quả |
|---|---|
| `pnpm -C be typecheck` + `lint` | exit 0 / exit 0 (chạy lại sau khi thêm test: 0 / 0) |
| `pnpm -C be test` | 41 suites, **708/708** |
| `pnpm -C be build` | exit 0 |
| `pnpm -C be test:int` FULL | **59 suites, 1552/1552** (592 s), exit 0 — 1537 của dev + 15 ca tester |
| `vg-int-*` trên vg-test-mongo | **4 trước → 4 sau** (chỉ 4 DB `vg-int-vault-v7-*` cũ, đã biết) |
| `pnpm -C fe-admin test` | 67 files, **1570/1570** |
| Cổng 4000/5173/3000 trống ⇒ `pnpm -C e2e e2e` | **38 passed** (4.8 m); CLI in `target: localhost:27017/sso-idp-e2e` |
| `pnpm -C e2e e2e:x3` | **42 passed** (9.4 m) ⇒ cổng trống sau |

## Lệnh đã chạy + output thực tế

### 1. `db-cli-dry-run.int-spec.ts` — flake: tái hiện, gốc, sửa ở mức test
- Chạy riêng 6 lần (spec của dev): 18/18 ×6. Thời gian từng ca: dry-run `sync-indexes` ~1.0 s, `seed`/`seed-dev` **2.1–2.4 s** (node cold start + nạp module), so với ngưỡng `expect(r.ms).toBeLessThan(3000)` ⇒ biên chỉ ~0.6 s.
- Tái hiện dưới tải (2 `pnpm -C be test` chạy song song):
  ```
  × sync-indexes --dry-run ⇒ exit 0 fast ... (6354 ms)   Expected: < 3000  Received: 6347
  × seed --dry-run ⇒ exit 0 fast ...         (4607 ms)   Expected: < 3000  Received: 4605
  ```
- **Gốc**: ngưỡng wall-clock 3 s dùng làm bằng chứng "không kết nối" — trên Windows, spawn node + nạp `seed.js` dưới tải vượt 3 s. Không phải port `127.0.0.1:1` (ca dry-run không hề kết nối), không phải timeout `spawnSync` (30 s).
- **Sửa (chỉ test, không nới check)**: thay ngưỡng thời gian bằng bằng chứng trực tiếp — listener TCP cục bộ (`net.createServer` trên `127.0.0.1:0`) **đếm socket được accept** (reset ngay); ca dry-run / pnpm `--` / cờ gõ sai (DEBT-522) trỏ `MONGO_URI` vào listener và assert `accepted === 0`; child chạy async (`spawn`) để event loop accept được trong lúc child chạy. Thêm **ca đối chứng dương**: `sync-indexes` KHÔNG cờ vào listener ⇒ `accepted > 0`, exit 1, không lộ secret (chứng minh bộ đếm thấy kết nối thật). Ca "không cờ" cũ (port 1) giữ nguyên.
- Sau sửa: riêng 1 + 5 lần liên tiếp 19/19; dưới tải 2 unit song song 19/19.
- **Mutation** (sửa `dist/.../sync-indexes.js` tạm, sha256 `789d97…cefcd` khôi phục khớp): trong nhánh dry-run mở `createConnection` rồi đóng sau 300 ms ⇒ spec mới: 2 đỏ (`Expected: 0, Received: 10` socket); spec cũ của dev cũng 2 đỏ (vì close chờ). Bộ đếm bắt cả biến thể kết nối nhanh mà ngưỡng thời gian có thể lọt.

### 2. T3 / DEBT-150 — logout `scope=all` với Redis + Mongo THẬT (`be/test/session-reflection.int-spec.ts`, +3 ca)
Module thật: `UiController` + `AuthenticationService` + `SessionService` (vg-test-redis) + `RefreshTokenService` (vg-test-mongo); mỗi ca 1 user riêng, 2 "trình duyệt" = 2 session + 2 family code-grant `offline_access`.
- (a) happy: logout từ A ⇒ 302 + clear cookie; A, B `get` = null, B tombstone `isEnded` = true; 0 family sống; refresh B ⇒ `invalid_grant`; introspect AT B ⇒ `{active:false}`; audit `SESSION_REVOKED` = `[{scope:'all',count:2}]`, `TOKEN_REVOKED` = `[{scope:'all',count:2}]`; **user khác** (negative actor) session + family + AT còn sống; **replay** cookie chết ⇒ 302, không audit success thứ 2.
- (b) Mongo lỗi ở bước pre_revoke (spy `RefreshTokenService.revokeAllForUser` reject 1 lần, phần còn lại store thật) ⇒ 5xx, không `Location`, body không chứa lỗi, không Set-Cookie session; **B đã chết trong Redis thật** + tombstone; sweep ⇒ 0 family sống; 0 audit success; retry ⇒ 302 + clear.
- (c) Redis lỗi ở bước sessions ⇒ 5xx, 0 family sống (pre_revoke + sweep), 0 audit success, session B còn (fail-closed, không báo đăng xuất giả); retry ⇒ 302, A/B chết, đúng 1 audit success.
- Kết quả 13/13. **Mutation** (`ui.controller.ts` = HEAD cũ 3 lời gọi, sha256 `7976a8…729e` khôi phục khớp): ca (b) đỏ.

### 3. T4 / DEBT-198 — `idp_fed` (`be/test/federation.int-spec.ts`, +3 ca)
- replay callback `link_required` (state đã tiêu thụ) ⇒ ≥ 400, KHÔNG Set-Cookie `idp_fed`/`idp_link`/session, không redirect `/auth/link`; lần đầu: giá trị binding không có trong `Location`/body.
- cookie binding lạ (login-CSRF) ⇒ ≥ 400, giá trị attacker không được set lại/gia hạn, không phản chiếu trong body.
- không có cookie binding ⇒ ≥ 400, không set gì.
- Kết quả 113/113. **Mutation** (set binding vô điều kiện đầu `callback`, sha256 `fe3b2d…fd01` khôi phục khớp): 3 đỏ (replay, foreign + ca signed_in của dev).

### 4. T5 / DEBT-254/523/525 — scrub với chuỗi lỗi THẬT của driver (`be/test/run78-tester.int-spec.ts`, 8 ca)
Probe chuỗi thật (mongoose/mongodb driver + ioredis, đích chỉ cổng đóng / `.invalid` / vg-test-mongo sai credential):
`connect ECONNREFUSED 127.0.0.1:1` · `Password contains unescaped characters` · `Invalid connection string` · `querySrv ECONNREFUSED _mongodb._tcp.nohost.invalid` · `Unable to parse 127.0.0.1:1:2 with URL` · `Authentication failed.` · Redis `connect ECONNREFUSED 127.0.0.1:1` / `Connection is closed.`.
- Driver hiện KHÔNG lặp lại mật khẩu trong message (chỉ lặp giá trị option như `authMechanism`/`readPreference`) ⇒ lớp scrub là phòng thủ chiều sâu.
- Mỗi ca assert: `cliErrorText(err, uri)` và `scrubUriCredentials(msg)` không chứa secret **và giữ phần chẩn đoán** (ECONNREFUSED host:port, "Authentication failed"…); message giả lặp nguyên URI ⇒ `[MONGO_URI]`, không secret. Message > 2 KB kết thúc giữa URI có credential ⇒ không secret, < 50 ms.
- Ghi nhận: dưới Jest ESM, lỗi DNS SRV của Node core khác realm ⇒ `instanceof Error` sai ⇒ `cliErrorText` trả `non-Error thrown` (chỉ trong Jest). CLI build thật (1 realm) đã kiểm tay: `MONGO_URI=mongodb+srv://u:<secret>@nohost.invalid/x` ⇒ stdout `target: nohost.invalid/x`, stderr `Index sync failed: querySrv ECONNREFUSED _mongodb._tcp.nohost.invalid`, exit 1, không secret. Test bọc lại message (có comment).
- Ghi nhận: ca Redis cổng đóng để lại handle ioredis ~10 s ("Jest did not exit…") khi chạy riêng — giống hệt `redis-fail-fast.int-spec.ts` có sẵn; full run thoát bình thường.

### 5. runbook-ops §0 / §3c / khôi phục bước 5 — cổng xác nhận (bash, `pnpm` stub = `echo`, KHÔNG chạy CLI)
Trích nguyên văn 2 khối có `read -r -p` (§0 :30-33, §3c :194-197; bước 5 dẫn chiếu khối §0), chạy với hàm `pnpm(){ echo "PNPM $*"; }`:
```
input=yes rc=0 dry=1 real=1 | no rc=1 real=0 | YES rc=1 real=0 | y rc=1 real=0 | '' rc=1 real=0
input=' yes ' rc=0 real=1 (read bỏ khoảng trắng đầu/cuối — vẫn là ý "yes") | 'yes yes' rc=1 real=0
EOF (</dev/null) rc=1 real=0 | dry-run exit 1 + gõ yes ⇒ rc=1 real=0 (không tới read)
dán khối + dòng thừa ⇒ dòng thừa rơi vào read ≠ yes ⇒ real=0
```
Cả 2 khối giống hệt nhau về hành vi. Đạt AC DEBT-257: `yes` ⇒ chạy, khác ⇒ không, EOF ⇒ không.

## Test FAIL (nếu có)
Không có ở gate cuối. Lỗi tìm được trong quá trình: flake `db-cli-dry-run` (mục 1) — do test, đã sửa ở mức test.

## Coverage acceptance criteria
- [x] T1 DEBT-139 — unit `refresh-token.service.spec.ts` (tham số 3 `{returnDocument:'before'}`), int refresh-token xanh trong full run.
- [x] T2 DEBT-155 — `admin-users.int-spec.ts` (a)–(e) của dev, xanh trong full run.
- [x] T3 DEBT-150 — `ui.int-spec.ts` (mock) + **3 ca store thật** `session-reflection.int-spec.ts` (mục 2).
- [x] T4 DEBT-198 — `federation.int-spec.ts` ca dev (Max-Age/HttpOnly/Lax/`__Host-`) + **3 ca replay/foreign/missing** (mục 3).
- [x] T5 DEBT-254 — unit `sync-indexes.spec.ts`/`error-log.spec.ts` + **8 ca chuỗi driver thật** (mục 4); seed-dev in `target:` — `db-cli-dry-run` 19 ca.
- [x] T6 DEBT-256/257/522 — `db-cli-dry-run.int-spec.ts` (đếm socket, mục 1) + cổng runbook (mục 5).
- [x] DEBT-523/525 — unit của dev + ca > 2 KB với URI bị cắt (mục 4).

## Coverage security invariants / risk matrix
- [x] Identity/Authorization — user khác không bị logout global (negative actor, mục 2a); binding attacker không được gia hạn (mục 3).
- [x] Credential — binding absent / foreign / replayed (state đã tiêu thụ) (mục 3).
- [x] State — replay logout cookie chết (2a), retry sau lỗi (2b/2c), replay callback (3).
- [x] Dependency — Mongo lỗi bước pre_revoke, Redis lỗi bước sessions ⇒ fail-closed, không audit/cookie/redirect giả (2b/2c).
- [x] Request chain — sau 5xx, request kế tiếp cùng cookie ⇒ 302 + clear (2b/2c); sau 302 logout, cookie cũ ⇒ nhánh no-session (2a).
- [x] Exposure — secret/URI không ở stderr CLI, log scrub (mục 1, 4); binding không ở URL/body (mục 3); lỗi nội bộ không ở body 5xx (2b/2c).
- [x] Input — option/URI lỗi định dạng (`/`, `@`, host:port sai, SRV), message > 2 KB (mục 4); cờ CLI gõ sai (mục 1).
- [x] Ops — `--dry-run` 0 socket (bằng chứng trực tiếp + đối chứng dương); cổng `read … yes` (mục 5).

## File tester đổi
- `be/test/db-cli-dry-run.int-spec.ts` (đếm socket thay ngưỡng 3 s, +1 ca đối chứng)
- `be/test/session-reflection.int-spec.ts` (+3 ca, import `jest` từ `@jest/globals`)
- `be/test/federation.int-spec.ts` (+3 ca)
- `be/test/run78-tester.int-spec.ts` (mới, 8 ca)

Không sửa code sản phẩm; mọi mutation backup → restore, sha256 khớp. Debt mới: không.
