# Tech Lead Review — 2026-10-20

## Kết luận: PASS (kèm fold bắt buộc F0–F7 trong `tasks.md`)

Plan đúng vấn đề (plan §B7.5, spec §6.4/§8 rotation khẩn cấp) và đủ nhỏ. Tuy vậy text gốc có 3 khẳng định **sai so với code** — đã sửa trực tiếp trong mục "Fold tech-lead" của `tasks.md`, nên không có blocker còn mở → không cần REJECT.

## Kiến trúc đề xuất
- Không đổi kiến trúc. Thêm 1 doc bền `runbook-ops.md`, 1 int-spec diễn tập, và 1 thay đổi CLI nhỏ (in DB đích).
- Diễn tập **lai**: kịch bản 1–3 tự động (int-spec trên `vg-test-*`, DB tạm), kịch bản 4 thủ công (`docker exec vg-test-mongo` mongodump/mongorestore, DB `vg-drill-*`).

## Điểm mạnh
- Phạm vi gọn, ràng buộc hạ tầng an toàn đã nêu sẵn (không DB dev, không FLUSH/drop `aegate-*`).
- Đã có nền vững: `POST /admin/keys/rotate` (super_admin + step-up 5'), alert `SsoTokenReuseDetected`/`SsoEmergencyKeyRotation`, `PATCH /admin/clients/:id {disabled}` revoke RT theo client, `seedBootstrap` idempotent.

## Vấn đề (đã fold — dev làm theo fold)
- [x] **Kịch bản 2 sai**: `GET /admin/audit?action=TOKEN_REUSE_DETECTED` luôn rỗng — `RefreshTokenService` ghi event không có `tenantId` (DEBT-140), `listForTenant` lọc chặt tenant. ⇒ Runbook dùng metric/alert + mongosh chỉ-đọc `auditlogs` → `refreshtokens` theo `familyId` (F2); int-spec khoá hành vi này.
- [x] **Kịch bản 3 sai**: `db:seed` gọi `assertNotProduction` (chỉ development|test, DEBT-164) ⇒ production không có công cụ khôi phục; seed cũng **không reset mật khẩu, không gỡ khoá** (`$setOnInsert`); không có endpoint admin reset mật khẩu. ⇒ F3: dev/test = seed; prod = break-glass mongosh 2 người; mật khẩu qua `/forgot`→`/reset`; khoá qua `lockedUntil` hết hạn / `POST /admin/users/:id/unlock` / break-glass.
- [x] **Kịch bản 1 thiếu**: step-up `RequireRecentAuth(5)`, không idempotent (DEBT-158 — cấm retry mù), emergency KHÔNG thu hồi session/RT, không có rollback, phần prod chưa có (Q5/B7.3) (F1).
- [x] **Kịch bản 4 thiếu bất biến bảo mật**: restore về thời điểm cũ làm RT đã rotate/reuse-revoke **sống lại** và đảo ngược disable client/revoke secret/gỡ role/khoá user ⇒ bắt buộc bước thu hồi toàn bộ RT + checklist áp lại thay đổi (F4); backup chứa hash + PII ⇒ mã hoá/giới hạn truy cập; diễn tập phải chứng minh việc RT sống lại (F6 bước 3–5).
- [x] **Rủi ro diễn tập đụng DB dev**: `db:sync-indexes`/`db:seed` nạp `be/.env` (`MONGO_URI` → `sso-idp`) qua `--env-file-if-exists`; gõ sai tên biến ghi đè ⇒ âm thầm chạy trên DB dev và `syncIndexes` drop index. ⇒ F5: CLI in `target: <host>/<db>` (đã scrub) trước khi ghi; tester xác nhận dòng này trước mỗi bước.

## Security design gate (trust boundary: admin API, DB thao tác tay, backup)
- Tài sản/actor: signing key (super_admin), RT/session (user, client), quyền super_admin (break-glass operator), file backup (hash + PII). Owner/non-owner: rotate chỉ super_admin + step-up — int-spec assert thiếu step-up ⇒ từ chối.
- Invariant/transition: sau emergency rotate JWKS chỉ newKid, AT cũ 401, RT vẫn chạy; sau reuse family revoked; sau restore mọi RT trước điểm restore vô hiệu.
- Abuse cases: retry rotate (DEBT-158), stale RT sống lại sau restore, nhầm DB đích (F5), break-glass không audit (biên bản ngoài hệ thống, DEBT-252).
- Failure semantics: rotate 5xx ⇒ kiểm state trước khi gọi lại; `db:sync-indexes` fail-closed (deploy §2b); restore vào DB mới, không `--drop`.
- Exposure: runbook/report không chứa secret/PEM/URI có credential/`tokenHash`/PII — grep âm F7.

## Phân công
- **backend-dev**: Task 1 (`runbook-ops.md`) + Task 2a (`be/test/runbook-drill.int-spec.ts`) + F5.
- **tester**: Task 2b — chạy spec, diễn tập thủ công kịch bản 4 theo F6, viết `runs/40-B7.5/drill-report.md`, sửa văn bản runbook theo lệch.

## Đề xuất (không bắt buộc) → backlog
- DEBT-251: không có cách revoke mọi family của một client mà không disable client; không có "revoke all" toàn cục (cần sau restore / key compromise) — đang dùng mongosh.
- DEBT-252: khôi phục super_admin ở production không có công cụ hỗ trợ và không để lại audit (break-glass mongosh).
- DEBT-253: chính sách backup production (lịch, RPO/RTO, PITR/oplog hoặc snapshot managed, mã hoá, retention, nơi lưu) chưa quyết — phụ thuộc Q5.
