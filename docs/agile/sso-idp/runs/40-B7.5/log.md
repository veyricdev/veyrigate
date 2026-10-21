# Log — run 40 — B7.5 runbook + diễn tập

## orchestrator — 2026-10-20
- Hạng mục M7 cuối không bị chặn. spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §B7 (B7.5). Cổng → tech-lead.

## tech-lead — 2026-10-20
- **PASS** kèm fold F0–F7 trong `tasks.md` (ưu tiên hơn text cũ). Đối chiếu code `d8da71c` qua CodeGraph; `docker exec vg-test-mongo which mongodump mongorestore mongosh` ⇒ có sẵn (tools 100.18.0), không cần cài.
- Sửa 3 khẳng định sai: (1) `/admin/audit?action=TOKEN_REUSE_DETECTED` rỗng do event không có tenantId (DEBT-140) ⇒ dùng metric + mongosh chỉ-đọc; (2) `db:seed` chặn production (DEBT-164), không reset mật khẩu/không gỡ khoá; không có endpoint admin reset mật khẩu ⇒ `/forgot`→`/reset`, break-glass; (3) emergency rotate cần step-up 5', không idempotent, không thu hồi RT/session.
- Bổ sung: bất biến sau restore (RT sống lại ⇒ thu hồi toàn bộ; checklist áp lại thay đổi bảo mật), F5 CLI in DB đích chống chạy nhầm DB dev.
- Q-40.1: thủ công trên `vg-test-mongo`, DB `vg-drill-src/dst-<ts>`, restore bằng `--nsFrom/--nsTo`, cấm `--drop`/`aegate-mongo`/27017. Q-40.2: lai — 1–3 int-spec (backend-dev), 4 thủ công + `drill-report.md` (tester).
- Debt mới: DEBT-251…253. Cổng → **backend-dev**.

## backend-dev — 2026-10-20
- Task 1: `runbook-ops.md` 4 kịch bản + §0 chung (step-up, lấy ADMIN_AT thủ công vì chưa có fe-admin). Grep F7: 22 route/3 script/3 alert đều có thật; grep âm (`-----BEGIN`, `password=`, URI có credential) = 0.
- Security: §1 không idempotent ⇒ kiểm `GET /admin/keys` + audit trước khi gọi lại; §2 audit API rỗng (DEBT-140) ⇒ metric + mongosh chỉ-đọc; §3 seed không reset mật khẩu/khoá, prod = break-glass 2 người; §4(i) thu hồi toàn bộ RT = 2 update như `revokeWhere` ⇒ dùng lại ra `invalid_grant`, KHÔNG reuse burst (chỉ RT đã rotate trước backup mới bắn reuse) — đã khoá bằng test.
- Task 2a: `be/test/runbook-drill.int-spec.ts` (full app, DB `vg-int-runbook-drill-<ts>`) §1 §2 §3 §4(i) 4/4. F5: `mongoTarget()` in `target: <host>/<db>` (bỏ userinfo + query) trước khi kết nối ở `db:sync-indexes` + `db:seed`; unit 5 test; CLI thật với URI có credential tới cổng 1 ⇒ in `target: 127.0.0.1:1/vg-f5-probe`, không lộ user/pw.
- Mutation (cp + sha256, đã khôi phục khớp hash): bỏ nhánh userinfo trong regex ⇒ 2/5 unit đỏ; seed `$set` password + `$unset lockedUntil` và bỏ lọc tenant ở `listForTenant` ⇒ §3 + §2 đỏ.
- Verify: typecheck/lint sạch; `pnpm -C be test` 387/387 (32 suites); `test:int` FULL 1203/1203 (45 suites); vg-test-mongo không còn DB runbook/drill.
- Debt mới: DEBT-254 🟡 (lỗi CLI chưa scrub URI, seed-dev chưa in target), DEBT-255 💭 (lấy ADMIN_AT thủ công). Cổng giữ nguyên → orchestrator điều phối tester 2b rồi senior.

## tester — 2026-10-20 (Task 2b)
- **PASS 4/4** diễn tập — xem `drill-report.md`. §1–§3 + §4(i): `runbook-drill.int-spec.ts` 4/4, đối chiếu từng bước với runbook-ops (bảng trong report). §4 thủ công trên `vg-test-mongo` (`vg-drill-src/dst-1792490163`, ~1 ph 38 s): kiểm khô đích → `db:seed` (target đúng 27117/src) → RT giả → `mongodump` trong container → revoke ở src → `mongorestore --nsFrom/--nsTo` (không `--drop`, 10 doc) → count + tên index src==dst (12 collection) → RT giả **sống lại** ở dst → §4c ⇒ 0 RT active → `db:sync-indexes` dst exit 0, index trước/sau giống hệt → drop đúng 2 DB (regex + listDatabases) + xoá archive.
- Lệch L1–L5 đã sửa VĂN BẢN `runbook-ops.md`: §0 lệnh kiểm khô đích (CLI ghi ngay sau `target:`, không kịp Ctrl-C; sai tên biến ⇒ `localhost:27017/sso-idp`); §4a/§4b số liệu từ log mongodump (dryRun không đếm), kỳ vọng `N restored/0 failed`, lệnh so count+index, kiểm DB mới chưa tồn tại; ghi chú Git Bash `MSYS_NO_PATHCONV`; §1 xác minh cần AT mới (AT dùng để xoay đã 401); §2 RT client disable = `401 invalid_client`.
- Test: siết assert §2 trong `runbook-drill.int-spec.ts` (`≥400` → `401 invalid_client`), không đổi code sản phẩm; eslint/prettier sạch.
- Verify: `pnpm -C be test` 387/387 (32); `test:int` FULL 1203/1203 (45, 330 s). Sau cùng: không DB `vg-drill-*`/`vg-int-runbook*`, `/tmp` container sạch, không tiến trình tồn đọng. Grep âm runbook/report = 0.
- Debt mới: DEBT-256 🟡 (CLI DB thiếu kiểm khô/xác nhận đích). Cổng → **senior-reviewer**.

## senior-reviewer — 2026-10-20
- **REJECT** — xem `review-senior.md`. 🔴1 [BE] `mongoTarget` lộ user/mật khẩu khi password có `/ ? #` chưa encode (đo: `mongodb://u:p/ss@h:1/db` ⇒ `target: u:p/ss@h:1/db`), mà runbook §3c dặn ghi dòng `target:` vào biên bản ⇒ allowlist host + tên DB, fail-closed `(unparseable)`, thêm unit test. 🔴2 [docs/ops] runbook §4c `updateMany` thu hồi toàn bộ RT chạy trên `db` hiện tại (mongosh mở bằng URI prod = DB cũ) ⇒ thu hồi nhầm DB đang chạy, `countDocuments` xác minh giả `0`, RT sống lại trên DB restore vẫn hiệu lực ⇒ ràng buộc `d = db.getSiblingDB('<db_mới>')` + in đích.
- Đã kiểm: route/script/alert/anchor có thật; khẳng định runbook khớp code (`revokeWhere`, `rotate` reuse, 409 tự disable, audit enum/exact-match); spec khoá đúng hành vi; drill-report có bằng chứng đo được. `pnpm -C be test -- sync-indexes` 5/5, `tsc --noEmit` sạch. Không chạy lệnh runbook lên DB nào.
- 🟡 → DEBT-257…260 (kiểm khô tách lệnh thật, URI trên argv/history, `NODE_ENV=development` trong §3c, break-glass không in đích). Ponytail: Lean already. Cổng → **backend-dev** (retry 1).

## backend-dev — 2026-10-20 (retry 1)
- Security: tài sản = credential trong `MONGO_URI` (in TRƯỚC khi kết nối, vào biên bản) + đích ghi mongosh; abuse = password có `/ ? #` chưa encode, `user/x:pw@h`; failure mode = fail-closed `(unparseable MONGO_URI)`, không bao giờ echo phần không khớp allowlist.
- 🔴1: `mongoTarget` allowlist host list `host[:port]` (nhiều host, IPv6 `[..]`) + tên DB theo ký tự Mongo cho phép (cấm `@`/`#`). RED trước: 6/12 đỏ đúng nguyên nhân (in `u:p/ss@h:1/db`, `u:p`, `h:1/db@x`...). Unit +7 (6 dạng lộ + IPv6/`%3A`); dạng hợp lệ (+srv, nhiều host, query, `@` encode) giữ nguyên.
- Mutation (cp + sha256, khôi phục khớp `2259665…`): nới HOST_LIST ⇒ 3 đỏ; nới DB_NAME ⇒ 2 đỏ.
- 🔴2: runbook §4c ghi qua `const d = db.getSiblingDB('<db_mới>'); print('DB:', ...)` + throw nếu DB không tồn tại (gõ sai ⇒ DB rỗng ⇒ `0` giả) + in tổng RT; §4b-4 dặn không dùng `db` trần. Rà toàn runbook: §3d cùng lớp ⇒ qua `d`. Spec §4(i) giữ nguyên (DB tạm).
- Gộp: DEBT-259 (§3c chỉ dev/test, cấm URI prod, `NODE_ENV=test`), DEBT-260 (§3d `if (!u) throw`, `matchedCount === 1` cả 2 update), nit `action=` từng giá trị (`@IsIn` ⇒ 400); spec §3 break-glass dùng filter `_id` như runbook + assert `matchedCount`, thêm dòng trống.
- Verify: typecheck/lint/prettier sạch; `pnpm -C be test` 394/394 (32); `test:int -- runbook-drill` 4/4; grep âm runbook = 0. Không chạy lệnh runbook/seed/sync lên DB nào.
- Debt: đóng DEBT-259/260; mới DEBT-261 💭 (runbook-deploy backfill không in DB), DEBT-262 🟡 (§4b thứ tự 4d trước khi trỏ app). Cổng → **senior-reviewer** (lượt 2).

## senior-reviewer — 2026-10-20 (lượt 2)
- **REJECT** — xem `review-senior.md` mục "Lượt 2". Fix lượt 1 đúng hướng (allowlist fail-closed, §4c/§3d qua `d` + in DB + guard), không hồi quy.
- 🔴1 [BE] biến thể còn hở: password `<1–5 chữ số>[?#]…` chưa encode ⇒ `user:digits` khớp `HOST` (host:port), `m[2]` rỗng ⇒ in `target: u:12345/test (default)` / `admin:2024/...` / `u:1234/...` (lộ user + tiền tố hoặc toàn bộ mật khẩu số). Sửa 1 điều kiện: `uri.slice(m[0].length).includes('@')` ⇒ unparseable; đã thử trên probe: 7 dạng lộ ⇒ fail-closed, 4 dạng hợp lệ của spec giữ nguyên. Các biến thể khác (user không pw, pw rỗng, `%` lỗi, authSource, DB dài, unicode, `@` thô, `#frag`) sạch.
- 🔴2 [docs/ops] DEBT-262 nâng 🔴: §4b bước 4 làm 4d qua admin API khi app đã scale 0, chưa trỏ `<db_mới>` ⇒ không làm theo được; ứng biến (gọi API trên app trỏ DB cũ) làm thay đổi bảo mật mất im lặng khi chuyển ⇒ vi phạm bất biến (ii). Sửa văn bản: bước 4 = chỉ 4c; trỏ app sang `<db_mới>` chưa mở traffic; bước mới 4d + xác minh `GET`; rồi mới mở traffic.
- Rà mọi lệnh ghi runbook-ops: §3d/§4c đều qua `d` tường minh ✓; §2 `db` trần chỉ đọc ✓. 💭 §0 kiểm khô cần build trước.
- Đã chạy: `pnpm -C be test` 394/394; `test:int -- runbook-drill` 4/4; `tsc --noEmit` sạch. Không chạy lệnh runbook lên DB nào. Không DEBT mới. Cổng → **backend-dev** (retry 2).

## backend-dev — 2026-10-20 (retry 2)
- Security: tài sản = credential trong `MONGO_URI` (dòng `target:` in trước khi kết nối, ghi biên bản) + bất biến (ii) sau restore; abuse = password `<chữ số>[?#]…` chưa encode khớp `host:port`; failure mode = fail-closed `(unparseable MONGO_URI)` khi còn `@` sau đoạn match (đánh đổi: `@` thô trong query cũng unparseable).
- 🔴1: `mongoTarget` thêm `uri.slice(m[0].length).includes('@')`. RED trước: 7/19 đỏ đúng nguyên nhân (`u:12345/test (default)`, `admin:2024/...`, `u:1234/...`, `h:1,u:123/...`, `u:99/...`, property test `usr15:57328/...`). Test: 6 URI lộ (5 của senior + `+srv u:99#x`) + property test 2000 URI (password ngẫu nhiên chữ số đầu + `/?#:@`, seed 40) ⇒ chỉ được in đúng `host/db` hoặc unparseable.
- Mutation (cp + sha256 `91e80a22…`, khôi phục khớp): bỏ điều kiện mới ⇒ 7 đỏ.
- 🔴2: runbook §4b: bước 4 chỉ 4c (app tắt) → 5 sync-indexes → 6 trỏ app `<db_mới>` CHƯA mở traffic (bước vận hành; repo không có ingress/LB, ghi khoảng hở nếu không chặn được, ưu tiên disable client/gỡ role/lock) → 7 checklist 4d + xác minh `GET` (`disabled:true`, secret `status:"revoked"`, `roles`/`membershipStatus`/`locked`, consent biến mất — đối chiếu mapper) → mới mở traffic. 4d thêm cảnh báo gọi trên app trỏ DB cũ ⇒ mất im lặng. 💭 §0: build trước kiểm khô. Đóng DEBT-262.
- Verify: `tsc --noEmit` sạch, `pnpm lint` sạch, prettier sạch; `pnpm -C be test` 401/401 (32); `test:int -- runbook-drill` 4/4; grep lộ secret runbook = 0. Không chạy lệnh runbook/seed/sync lên DB nào.
- Debt: đóng DEBT-262; không 🟡 mới. Cổng → **senior-reviewer** (lượt 3).

## senior-reviewer — 2026-10-21 (lượt 3)
- **PASS** — xem `review-senior.md` mục "Lượt 3". Cả 2 🔴 lượt 2 đóng, không hồi quy.
- 🔴1 đóng: điều kiện `@` sau đoạn match đóng cả lớp lỗi (URI có credential luôn có `@`; nó hoặc bị userinfo ăn, hoặc rơi vào `m[2]`/phần sau ⇒ fail-closed). Probe thêm (password giả danh nhiều host, giả IPv6, `;`, dấu cách, `\n`, `\`, `%2F`, AWS token trong query, unix socket, scheme hoa) sạch; fuzz 200 000 URI ⇒ 0 lần lộ.
- 🔴2 đóng: đọc §4b như người trực, 1→7 làm được nguyên văn; không bước ghi nào rơi vào DB cũ (mongosh qua `d`, CLI có kiểm khô, admin API chỉ sau khi trỏ `<db_mới>`); Rollback giờ đúng.
- Đã chạy: `pnpm -C be test` 401/401 (32); `test:int -- runbook-drill` 4/4 (bật Docker Desktop + `docker start vg-test-mongo vg-test-redis`). Không chạy lệnh runbook lên DB nào, không E2E, không commit.
- Debt mới: DEBT-263 💭 (§4b 6–7: admin tạo/đổi sau backup không đăng nhập được trên `<db_mới>` ⇒ trỏ §3). Ponytail: Lean already. Cổng → **tester** (nghiệm thu).

## tester — 2026-10-21 (nghiệm thu sau retry 2)
- **PASS** — xem `test-report.md`. Typecheck/lint/prettier sạch; `pnpm -C be test` 401/401 (32); `sync-indexes` 19/19; `test:int` FULL 1203/1203 (45 suites, 358,6 s), gồm `runbook-drill` PASS.
- Exposure: fuzz độc lập 300 000 URI (thân `mongoTarget` trích bằng sed từ nguồn, bảng ký tự khác senior) ⇒ 0 lộ user/password.
- §4c bản mới (qua `d`, guard DB tồn tại) diễn tập lại trên `vg-test-mongo` DB `vg-drill-src/dst-1792569980`: mongosh mở DB "cũ" ⇒ chỉ `<db_mới>` bị thu hồi (active 0, tổng 4), DB cũ giữ 2 RT sống; tên gõ sai ⇒ `Error: DB không tồn tại`, exit 1, không tạo DB. Dọn đúng regex, còn `[]`. `drill-report.md` thêm B8 + chú thích B5 (bản §4c cũ); tham chiếu §4b-2/3/5 vẫn đúng số.
- Grep âm runbook/report = 0; grep dương route/alert có thật. Không còn tiến trình/DB do tester tạo. Không sửa code sản phẩm, không commit.
- Debt mới: không. Cổng → **orchestrator** (đóng run).

## orchestrator — 2026-10-21 (đóng run)
- Mọi cổng PASS (senior sau 2 retry). Commit `27b1a69`.
