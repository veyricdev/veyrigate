# Test Report — 2026-11-06 (run 71, DEBT-344 + DEBT-498)

## Kết quả: PASS

int full 1459/1459 (55 suite; 1443 trước + 16 test tester) · unit be 664/664 · fe-admin 1565/1565 (67 file) · typecheck + lint be/fe-admin sạch · fe-admin build + `check:bundle` 0 hit · E2E full 37/37 · E2E tester tạm (scratchpad) 1/1 · mutation 2/2 RED, restore sạch · `vg-int-*` 4 → 4.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output |
|---|---|---|
| P | `codegraph sync` | `Done` |
| B | `pnpm -C be build` (dist cho CLI sync-indexes) | exit 0 |
| T1 | `pnpm -C be test:int run71-tester` (spec mới `be/test/run71-tester.int-spec.ts`) | `Tests: 16 passed, 16 total`. Chạy lại sau `eslint --fix` (chỉ format): 16/16 |
| T2 | `pnpm -C be test:int` (full) | `Test Suites: 55 passed, 55 total` · `Tests: 1459 passed, 1459 total` · exit 0 |
| T3 | `pnpm -C be test` | `Test Suites: 40 passed` · `Tests: 664 passed, 664 total` |
| T4 | `pnpm -C be typecheck` / `lint` | exit 0 / exit 0 (lần lint đầu: 23 lỗi prettier trong spec của tester ⇒ `eslint --fix` ⇒ 0) |
| T5 | `pnpm -C fe-admin test` | `Test Files 67 passed (67)` · `Tests 1565 passed (1565)` |
| T6 | `pnpm -C fe-admin typecheck` / `lint` / `build` | exit 0 / 0 / 0 |
| T7 | `pnpm -C fe-admin check:bundle` | `scanned 23 client files for 8 server env names + 0 canaries, evaluated 22 chunks (0 Function/eval call(s)): 0 hit(s)` |
| E1 | `pnpm -C e2e e2e` (`netstat` trước: :4000/:5173/:3000 trống) | `37 passed (4.3m)` · exit 0 |
| E2 | `npx playwright test --config <scratchpad>/pw/playwright.tester.config.ts` (spec tạm import `e2e/playwright.config.ts` + `e2e/tests/support/*`, cùng webServer/DB `sso-idp-e2e`; cổng kiểm trống trước) | `1 passed (1.2m)`; dọn: `PATCH roles [] => 200` |
| D | `listDatabases` `vg-int-*` trên vg-test-mongo trước / sau T1, T2, mutation | 4 / 4 (chỉ 4 DB `vg-int-vault-v7-*` cũ) |

Node PID 12064 (:4071) không bị đụng. Không compose up, không đụng `aegate-*`, không sync/seed `sso-idp`.

### Case 1 — che PII qua HTTP thật (`bootFullApp`, DB `vg-int-r71t-*` tự drop)
Corpus 18 event (mỗi event UA riêng `R71T-UA-<n>-Mozilla/5.0 …`), kết quả cho tenant_admin:

| ip lưu | ip trả | chuỗi cấm trong body thô |
|---|---|---|
| `203.0.113.77` | `203.0.113.0/24` | `203.0.113.77` |
| `2001:db8:abcd:12::1` | `2001:db8:abcd::/48` | `2001:db8:abcd:12`, `:12::1` |
| `::ffff:198.51.100.23` / `::FFFF:198.51.100.24` | `198.51.100.0/24` | octet 4, `::ffff`/`::FFFF` |
| `::ffff:c633:6419` (hex) | `198.51.100.0/24` | `c633:6419`, `198.51.100.25` |
| 6to4 `2002:cb00:714e::1` | `203.0.113.0/24` | `2002:cb00:714e`, `cb00:714e`, `203.0.113.78` |
| NAT64 `64:ff9b::cb00:714f` | `64:ff9b::/48` | `cb00:714f`, `203.0.113.79` |
| Teredo `2001:0:4136:e378:8000:63bf:3fff:fdd2` | `2001:0:4136::/48` | `e378`, `63bf`, `3fff:fdd2` |
| `fe80::1234:5678%eth0`, `fe80::abcd:ef01%25` | `fe80::/48` | `1234:5678`, `eth0`, `abcd:ef01` |
| `127.1`, `0x7f.0.0.1`, `10.11.12.13/8`, `r71t-garbage<script>`, `203.0.113.80, 10.9.8.7`, `''`, `'   '`, thiếu | key `ip` vắng | chuỗi gốc |

Mọi item: `!('userAgent' in item)`; body thô không chứa `R71T-UA`, `Mozilla`, `userAgent`. super_admin: `ip`/`userAgent` nguyên văn cho cả 18 (kể cả rác, zone, rỗng). Thêm: anonymous ⇒ 401, member không vai trò admin ⇒ 403, membership super_admin `suspended` ⇒ 403 — không body nào chứa UA/IP. Giáng super_admin→tenant_admin: cùng token ⇒ che ngay request kế. Nâng tenant_admin→+super_admin: cùng token ⇒ đầy đủ ngay (vai trò đọc từ membership live mỗi request, không từ claim).

### Case 2 — TTL
- Boot không đặt env ⇒ `timestamp_1.expireAfterSeconds = 15552000`; boot `AUDIT_RETENTION_DAYS=30` ⇒ `2592000`.
- Boot với `29`, `3651`, `1e2` ⇒ `bootFullApp` reject, thông điệp có `AUDIT_RETENTION_DAYS` (không để lại DB).
- CLI repo thật `node be/dist/database/mongo/sync-indexes.js` (env hermetic tự truyền, KHÔNG `be/.env`; guard trong test: URI phải khớp `^mongodb://localhost:27117/vg-int-r71t-cli-\d+\?`, drop kiểm tên `^vg-int-r71t-cli-\d+$`) lên DB legacy: `timestamp_1` không TTL + cursor index run 57 + 4 doc (0/1/5/20 ngày tuổi):
  - unset ⇒ exit 0, stdout `target: localhost:27117/vg-int-r71t-cli-…` + dòng đúng `AuditLog: synced` (không `dropped`), TTL 15552000, 4 doc còn.
  - `30` ⇒ exit 0, `AuditLog: synced`, TTL 2592000, 4 doc còn, cursor index `{tenantId:1,timestamp:-1,_id:-1}` còn.
  - `29` / `3651` / `1e2` ⇒ exit ≠ 0, output nêu `AUDIT_RETENTION_DAYS`, không chứa CSRF secret canary, TTL giữ 2592000.

### Case 3 — Runbook/spec (đọc diff)
- `runbook-deploy.md` §1 "Run 71": `collMod` tại chỗ, output kỳ vọng `AuditLog: synced`, lỗi ⇒ exit 1 không fallback; ⚠ lần đầu XOÁ VĨNH VIỄN event > N ngày + `mongoexport` mẫu trước; TTL monitor ~60 s theo lô ⇒ giờ thấp điểm; xác minh `getIndexes()`; đổi env cần chạy lại sync, rút ngắn N lại xoá; dev: sync TRƯỚC `db:seed`. Đủ để vận hành làm đúng.
- `runbook-ops.md` §6: ai thấy gì, tenant_admin nhờ super_admin, TTL không xoá backup/log.
- `spec.md` §10 + bảng index: retention, quy tắc che, không filter ip.
- Thiếu nhỏ (không chặn): spec §10/runbook-ops chưa nêu 6to4 ⇒ IPv4 nhúng `/24` (DEBT-498) ⇒ DEBT-499.

### Case 4 — FE
- Component (`audit-ui.test.tsx`, trong T5): tenant_admin IP như nhận + "Hidden (super_admin only)", kể cả khi BE lỡ gửi UA; super_admin đầy đủ / "—".
- E2: stack thật. Admin seed PATCH roles `tenant_admin` cho E2E user ⇒ event `ADMIN_USER_ROLES_CHANGED`. Viewer super_admin: IP `127.0.0.1`, UA `Mozilla/5.0 (Windows NT 10.0; …)`. Viewer tenant_admin (E2E user, đăng nhập fe-admin): IP `127.0.0.0/24`, UA "Hidden (super_admin only)", text trang không chứa UA lẫn `127.0.0.1`. Dọn roles `[]` ⇒ 200. Sự kiện đăng nhập không gắn tenant nên không dùng được (trang ghi rõ). Spec + config chỉ nằm ở scratchpad, repo không thêm file.

### Case 6 — Mutation (backup ngay trước; restore xong `git diff | sha1sum` trước == sau; `mask-ip.ts` untracked so sha1 với bản backup = `9829bb77…`)
- M1 `mask-ip.ts`: nhánh 6to4 ⇒ `if (false && …)` ⇒ T1 3 RED (tenant_admin, demotion, promotion). Restore OK.
- M2 `admin-audit.controller.ts`: `fullPii: actor.roles.length > 0` (mọi admin thấy đủ) ⇒ T1 3 RED (cùng 3 test). Restore OK.

## Test FAIL (nếu có)
Không có. (Lần chạy đầu T1 5 test CLI fail vì env tester thiếu `RATE_LIMIT_*` — lỗi của test, đã sửa; E2 lần đầu lọc theo `AUTH_LOGIN_SUCCESS` không thấy event vì đăng nhập không gắn tenant — đổi sang `ADMIN_USER_ROLES_CHANGED`.)

## Coverage acceptance criteria
- [x] F1 env 30–3650, unset/'' ⇒ 180, sai ⇒ boot fail nêu tên biến — unit dev (T3) + Case 2 (boot + CLI).
- [x] F2 TTL `timestamp_1` qua `collMod`, không drop, docs còn, cursor index còn, DB trống — Case 2 CLI + `indexes.int-spec` (T2).
- [x] F3 che ip /24 /48 + mapped/hex/6to4, vắng `userAgent`, body thô sạch, super_admin đầy đủ, giáng ⇒ che ngay — Case 1, M1, M2.
- [x] F4 FE IP nguyên văn + "Hidden (super_admin only)" — T5 + E2.
- [x] F5 spec §10 + runbook — Case 3 (DEBT-499 nit).
- [x] Regression — T2–T7, E1.

## Coverage security invariants / risk matrix
- [x] Identity: anonymous 401, non-admin member 403, tenant_admin che, super_admin đủ, cả hai vai trò đủ (dev spec) — Case 1.
- [x] Authorization/State: vai trò live — giáng ⇒ che, nâng ⇒ đủ, membership suspended ⇒ 403 cùng token — Case 1.
- [x] Input: 18 dạng IP gồm biên/rác/injection `<script>`/danh sách XFF/zone/CIDR/rỗng — fail-closed, không echo — Case 1.
- [x] Exposure: body JSON thô (mọi field, cả metadata) + text trang fe-admin — Case 1, E2.
- [x] Dependency/failure: env sai ⇒ boot fail + CLI exit ≠ 0, index không đổi, không lộ env khác — Case 2.
- [x] Dữ liệu: sync không drop index, không mất doc trong hạn — Case 2.
- Cross-tenant: endpoint vẫn scope tenant của client đã verify (không đổi ở run này; phủ bởi `oauth-tenant-isolation`/`admin-*` int trong T2).
