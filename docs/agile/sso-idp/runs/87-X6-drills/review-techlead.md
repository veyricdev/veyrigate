# Tech Lead Review — 2026-11-12 (run 87, X6 đợt 3: diễn tập + sweep, BE + ops + QA)

## Kết luận: PASS

Fold chi tiết nằm ở `tasks.md`, mục "Fold tech-lead (2026-11-12)". Mục đó gồm phát hiện khi kiểm code, quyết định D87.1–D87.20, và cho từng task: AC, RED, mutation, file, rủi ro, người thực hiện. Đã kiểm trên `develop` HEAD `8855df0`.

| Task | Nội dung | P | Người thực hiện |
|---|---|---|---|
| T4 | Bỏ `failedLoginCount`/`lockTransitionNonce` + mongosh §15 (DEBT-589, phạm vi đã sửa) | 💭 | backend-dev |
| T2 | CLI `admin-recover`: audit `ADMIN_RECOVERED`, transaction, hai người, chạy trong image (DEBT-252) | P1 (D-6) | backend-dev |
| T5 | Pin digest image test/dev + guard spec; seed E2E dọn RT (DEBT-590/608) | 💭/🟡 | backend-dev, tester chạy E2E |
| T1 | Chính sách backup + script `ops/backup/*` + harness + diễn tập thật (DEBT-253) | P1 (D-5) | backend-dev (script/harness), tester (diễn tập + `drill-report.md`) |
| T3 | Diễn tập emergency rotate: Local + Vault hai instance, đo thời gian, sửa runbook | P1 (D-4) | tester (Local + lượt tay), orchestrator (Vault, một lệnh Bash) |
| T6 | Checklist (thêm D-16), security-matrix, gate | — | tester |

**Gói trong một run**, theo thứ tự T4 → T2 → T5 → T1 → T3 → T6. Nếu trễ, T1/T2/T3 phải xong; T4 và T5 được dời sang run 88.

## Kiến trúc đề xuất

Không đổi kiến trúc app và không thêm dependency. Mọi việc dùng công cụ có sẵn:

- `mongodump`/`mongorestore` trong `mongo:7`.
- `gpg` 2.4.8 trên host. Production cần gói `gnupg` của distro trên host backup; đây là điều kiện hạ tầng, không tải gì trong run này.
- `jose` và `mongoose` của `be` cho harness.

Ba lựa chọn đáng chú ý, lý do đầy đủ ở D87.x:

1. **RPO 1 h bằng dump logic hằng giờ, không có PITR (D87.2–D87.4).**
   - Một cơ chế duy nhất, đã diễn tập, đủ cho dữ liệu cỡ IdP.
   - Restore đã bù được phần thay đổi bảo mật bị mất: §4c thu hồi mọi RT, §4d áp lại thay đổi.
   - PITR oplog tự dựng không rename được namespace, nên phá quy tắc "restore vào DB mới" của §4b. PBM thì cần tải ⇒ DEBT-610.
2. **gpg khoá công khai, khoá riêng chia hai người (D87.5).**
   - Host backup chỉ giữ public key; restore cần đủ hai người.
   - Đã loại: `openssl enc` (không AEAD), `openssl cms` (giải mã không theo luồng), `age` (phải tải).
3. **Xác nhận hai người của CLI là kiểm soát thủ tục, ghi thẳng như vậy (D87.13).**
   - Ai có quyền ghi Mongo đều vượt được mọi CLI.
   - Kiểm soát thật gồm: giữ credential theo hai người, audit nằm trong cùng transaction, và alert qua log.
   - CLI bắt hai định danh khác nhau, cộng một mã ngẫu nhiên nhập lại sau khi đã in kế hoạch (`target:`, user id, số super_admin còn dùng được).
   - Đã loại token/HMAC hai pha và chia secret: tốn công quản lý khoá mà không thêm an toàn thật.

## Điểm mạnh

- Hầu hết thành phần đã có sẵn để dùng lại:
  - `SuperAdminGuard.runGuarded` + "touch" cho CLI nên race CLI ∥ API có lời giải sẵn;
  - `isDryRun`/`mongoTarget`/`cliErrorText` theo quy ước DEBT-254/256/522;
  - `AuditService` khởi tạo được ngoài DI;
  - `docker-smoke.sh` đã chạy image production trong CI.
- Digest đã được kiểm (≥ 14 ngày) có sẵn trong `docker-smoke.sh`/`prod.example.yml` cho mongo/redis, nên DEBT-590 không phải pull hay tra registry.
- Runbook §4 đã có khung restore đúng (DB mới, §4c, §4d). Run này chỉ thêm chính sách, script và bằng chứng.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Dev và tester **bắt buộc** làm theo các điểm sau (đã ghi trong AC):

- [ ] Harness và CLI diễn tập phải chạy với **cwd ngoài `be/`** và không qua `pnpm db:*`. Lý do: `main.ts` và `--env-file-if-exists` nạp `be/.env` theo cwd, nên biến dev có thể lọt vào (phát hiện 3).
- [ ] Assert tên DB khớp `^vg-drill-`, Redis đúng db 7/8 với `DBSIZE 0` lúc bắt đầu, chỉ dùng `FLUSHDB` đúng db đó. Hậu kiểm `sso-idp-e2e` không đổi. Guard "DB chưa tồn tại" không đủ, vì `sso-idp` hiện **chưa tồn tại** (phát hiện 7).
- [ ] CLI: audit success phải insert **trong cùng transaction** với việc cấp role. Không in email. Đếm super_admin "dùng được" theo đúng định nghĩa của `SuperAdminGuard`. User đang bị admin khoá phải có `--unlock` tường minh.
- [ ] T4: điều kiện audit unlock chỉ dựa vào `lockedUntil`. DEBT-589 ghi sai rằng admin view lộ `failedLoginCount`; thực tế không lộ, nên **không** đổi FE/OpenAPI.
- [ ] Bằng chứng diễn tập không được chứa token, hash hay email thật. Harness tự grep để kiểm.
- [ ] Root token Vault chỉ sống trong **một** lệnh Bash của orchestrator. Luôn `docker rm -f vg-b73-vault` khi xong.

## Đề xuất (không bắt buộc) — đã ghi `backlog.md`

- **Bootstrap production còn thiếu (DEBT-164, P1, checklist D-16).** Production chưa tạo được resource `admin` và client `fe-admin` với redirect lấy từ env. Super_admin đầu tiên thì T2 đã giải. Đề xuất làm ở run 88, trước khi ký phần F: không có bước này thì không deploy lần đầu được.
- DEBT-610: PITR (Percona Backup for MongoDB) nếu sau này cần RPO < 1 h.
- DEBT-611: quy trình làm mới digest image test trong workflow `services:`/`docker run`, vì Dependabot không cập nhật chúng (có thể bật thêm ecosystem `docker-compose`).
- DEBT-612: chạy harness diễn tập backup/restore theo lịch trong CI (job thủ công hoặc hằng tháng) để phát hiện lệch giữa script và runbook giữa các quý.

## Ghi chú deploy (orchestrator chép vào summary/STATUS)

- Sau deploy, chạy mongosh `runbook-deploy.md` §15: dry-run trước, rồi `$unset` các field cũ.
- Production cần chuẩn bị:
  - host backup có `gnupg` và public key backup;
  - storage offsite có object lock 35 ngày;
  - Mongo user `backup`/`restore`;
  - textfile collector cho alert `SsoMongoBackupStale`.
- CLI recovery: `docker run --rm -i --env-file <env app> <image> node dist/database/admin-recover.js …`. Có super_admin dùng được thì CLI từ chối, trừ khi có `--allow-existing-super-admin`.
