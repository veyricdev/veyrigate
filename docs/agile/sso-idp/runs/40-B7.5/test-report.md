# Test Report — 2026-10-21 (run 40 B7.5, nghiệm thu sau backend-dev retry 1/2, senior lượt 3 PASS)

## Kết quả: PASS (BE unit 401/401, int FULL 1203/1203, §4c diễn tập lại 2/2 tình huống)

Phạm vi: thay đổi chưa commit kể từ `8e6c464` — `runbook-ops.md`, `be/test/runbook-drill.int-spec.ts`,
`be/src/database/mongo/sync-indexes.ts` (`mongoTarget`) + `sync-indexes.spec.ts`, `be/src/database/seed.ts` (in `target:`).
Hạ tầng: CHỈ `vg-test-mongo@27117` / `vg-test-redis@6479` (Docker Desktop đã chạy sẵn, không start/stop gì).
Không đụng `aegate-*`, cổng host 27017, DB `sso-idp*`, không FLUSH, không docker run/rm/pull/compose, không
đụng `be/keys`/`be/.env`, không sửa code sản phẩm, không commit.

## Lệnh đã chạy + output thực tế

| # | Lệnh | Output |
|---|---|---|
| 1 | `pnpm -C be typecheck` | `tsc --noEmit` exit 0 |
| 2 | `pnpm -C be lint` | `eslint src test` exit 0 |
| 3 | `prettier --check` 4 file trong phạm vi | `All matched files use Prettier code style!` |
| 4 | `pnpm -C be test` | `Test Suites: 32 passed, 32 total` / `Tests: 401 passed, 401 total` (31,4 s) |
| 5 | `jest sync-indexes --verbose` | 19/19 (6 dạng lộ retry 1 + 6 dạng chữ số retry 2 + property test seed cố định + dạng hợp lệ: +srv, nhiều host, IPv6, `@`/`:` encode, db mặc định) |
| 6 | Fuzz độc lập `mongoTarget` (thân hàm trích bằng `sed` từ `sync-indexes.ts:24-43`, không chép tay) | 300 000 URI (bảng ký tự khác senior: thêm `!$&'()*+;= ~`, user ngẫu nhiên, 5 dạng host gồm IPv6/nhiều host/+srv, có/không db/query) ⇒ `probes 300000 leaks 0`; URI diễn tập ⇒ `target: 127.0.0.1:27117/vg-drill-src-1` |
| 7 | §4c diễn tập lại trên `vg-drill-*` | xem case 7 dưới; chi tiết `drill-report.md` B8 |
| 8 | `pnpm -C be test:int` FULL (08:06:50–08:12:51 UTC) | `Test Suites: 45 passed, 45 total` / `Tests: 1203 passed, 1203 total` / `Time: 358.616 s`; `PASS test/runbook-drill.int-spec.ts (9.898 s)`; EXIT=0 |
| 9 | Sau cùng | `listDatabases` lọc `^vg-(drill\|int-runbook)` = `[]`; `/tmp` container chỉ `mongodb-27017.sock`; không tiến trình node nào có `jest\|test:int\|sync-indexes\|seed` trong command line |
| 10 | Grep âm `runbook-ops.md` + `drill-report.md`: `-----BEGIN\|password=\|mongodb(+srv)?://…:…@\|ADMIN_SEED_PASSWORD=<giá trị>` | 0 dòng (grep exit 1) |
| 11 | Grep dương route admin (controller) + alert | `rotate`, `:id/sessions/revoke`, `:id/families[/:familyId/revoke]`, `:id/lock`, `:id/unlock`, `:id/roles`, `:id/consents[/:consentId]`, `:clientId`, `:clientId/secrets[/:version]` có; `SsoTokenReuseDetected`/`SsoEmergencyKeyRotation`/`SsoTokenErrorRatioHigh` có trong `ops/prometheus/alerts.yml` |

**Case 7 — §4c bản qua `d` (TS=1792569980)**: xác nhận đích `docker inspect vg-test-mongo` (mongo:7, host 27117),
không DB `vg-drill-*` trước. Khối JS trích nguyên văn từ runbook (chỉ thay `<db_mới>`); mongosh mở trên DB
"cũ" `vg-drill-src` (2 RT sống), `d` = `vg-drill-dst` (3 sống + 1 đã thu hồi):
- In `DB: vg-drill-dst-1792569980`, `active RT: 0`, `tổng RT: 4`, exit 0.
- DB mở kết nối không bị đụng: src active = 2, `familyRevokedAt null` = 2. RT đã thu hồi từ trước giữ stamp cũ (1).
- Tên gõ sai `vg-drill-dst-typo-…` ⇒ `Error: DB không tồn tại: …`, **exit 1**, không tạo DB.
- Dọn: regex `^vg-drill-(src|dst)-1792569980$` ∩ `listDatabases` ⇒ drop 2 DB `{"ok":1}`, còn `[]`.

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] Task 1 — mọi lệnh/endpoint có thật: grep dương (11); `pnpm` script `build/db:seed/db:sync-indexes` có trong `be/package.json`; không chứa secret: grep âm (10).
- [x] Task 1 — 4 kịch bản đủ dấu hiệu/quyết định/bước/xác minh/rollback/prod-vs-dev: đọc `runbook-ops.md` §1–§4.
- [x] Task 2 — 4/4 kịch bản có bằng chứng: `runbook-drill.int-spec.ts` 4/4 trong int FULL (8) + `drill-report.md` B0–B8; runbook đã sửa theo L1–L5.
- [x] F5 — CLI in `target:` trước khi kết nối, không lộ credential: unit 19/19 (5) + fuzz 300k (6); `seed.ts` gọi `assertNotProduction` rồi mới in/kết nối (đọc code).
- [x] Retry 1 🔴1 / retry 2 🔴1 — allowlist + `@` sau đoạn match fail-closed: (5)(6).
- [x] Retry 1 🔴2 — §4c/§3d qua `getSiblingDB` + in `DB:` + guard: case 7 (§4c chạy thật); §3d kiểm bằng spec §3 (filter `_id`, `matchedCount`) trong (8).
- [x] Retry 2 🔴2 — §4b thứ tự 4 (chỉ 4c) → 5 sync → 6 trỏ app chưa mở traffic → 7 checklist 4d + `GET`: đọc runbook; drill-report tham chiếu §4b-2/3/5 vẫn đúng số (B8).
- [x] F7 — test + test:int xanh; sau diễn tập không còn DB `vg-drill-*` (9).

## Coverage security invariants / risk matrix
- [x] Exposure (URI credential ra stdout/biên bản): malformed/encoded/injection — unit 19 + fuzz 300k, 0 lộ; dạng không parse được ⇒ `(unparseable MONGO_URI)`, không echo.
- [x] Input/target (ghi nhầm DB): mongosh mở DB cũ, ghi qua `d` ⇒ DB cũ nguyên vẹn (case 7); tên sai ⇒ throw exit 1, không `0` giả (case 7); biến env sai tên ⇒ kiểm khô §0 (drill B0).
- [x] State (restore về điểm cũ): RT thu hồi sau backup sống lại ⇒ §4c vô hiệu (drill B5 + case 7); RT đã thu hồi giữ nguyên stamp; không reuse burst (spec §4(i) trong int FULL).
- [x] Request chain / Authorization / Credential (§1–§3): step-up thiếu ⇒ 403; AT cũ 401 sau emergency; refresh sau thu hồi ⇒ 400/401 `invalid_client`; `NODE_ENV=production` seed từ chối trước khi ghi — spec runbook-drill trong int FULL.
- [x] Blast radius: chỉ `vg-test-mongo`; drop bằng regex ∩ listDatabases; không `--drop`.

Debt mới: không (DEBT-263 💭 của senior giữ nguyên; ID mới tiếp theo DEBT-264 chưa dùng).
