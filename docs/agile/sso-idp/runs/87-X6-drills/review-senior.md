# Senior Review — 2026-11-12 (run 87 — lượt 2 PASS ở cuối file; lượt 1 bên dưới, X6 drills + sweep; code uncommitted on `develop` @ `8855df0`)

## Kết luận: REJECT

Lý do: 1 🔴 trong harness diễn tập. Khi guard không gian tên **từ chối** (Redis db 7/8 không rỗng, DB `vg-drill-*` đã có, cổng bận, Vault mount đã có), khối `finally` vẫn `FLUSHDB` và `dropDatabase`. Điều này phá đúng bất biến D87.11 ("sai ⇒ exit trước khi ghi"). Sửa rẻ, phải xong trước khi tester chạy diễn tập. Mọi phần còn lại (CLI `admin-recover`, T4, T5, script backup/restore, alert) đạt; các 🟡 dưới đây có thể sửa cùng lượt hoặc để backlog (DEBT-613…619).

Quay lại **backend-dev**.

## Tổng quan (ấn tượng chung + điểm tốt)

- **CLI `admin-recover` chắc chắn.** Tham số theo allowlist, lỗi là câu cố định nên không echo giá trị. `--dry-run` không kết nối. Kế hoạch in **trước** mã xác nhận, mã 8 chữ số sinh bằng `randomInt`, stdin EOF hoặc hết giờ ⇒ `not_confirmed`.
- **Transaction của CLI đúng.**
  - Callback chỉ chạm DB qua `session`, kể cả `adminUnlock(..., session)` và audit `create([event], {session})`. `eventId` sinh trong callback nên driver retry vẫn đúng.
  - `Refusal` không phải lỗi transient nên `withTransaction` abort rồi ném lại, không retry.
  - Đếm lại super_admin trong snapshot sau khi touch.
- **Đã kiểm bằng chạy thật**: `pnpm -C be test:int run87` ⇒ 2 suite, 28/28 xanh. Có AC9 ×20 (khác user ⇒ 1 success + 1 `super_admin_exists`; cùng user ⇒ idempotent), AC8 (audit lỗi ⇒ abort) và kiểm socket cho `--dry-run`/lỗi tham số.
- **T4 gọn.** Field cũ bỏ khỏi schema và mọi chỗ ghi; audit unlock chỉ theo `lockedUntil`. §15 có dry-run → apply → chạy lại, `EXPIRED` không đụng sentinel.
- **T5 đúng.** Digest khớp nhau trên mọi file (mongo ×4, redis ×5, mailpit ×2). Mailpit `sha256:8137…1a` khớp RepoDigest local (image tạo 2024-12-20). `image-pins.spec.ts` có ca parser và ca "không rỗng". `seed:e2e-admin` chỉ xoá RT của user mục tiêu.
- **Script ops cẩn thận.** `set -euo pipefail` + `umask 077`; URI có `@` bị từ chối và không echo. Restore dùng `nsFrom/nsTo` và kiểm `sha256` trước khi kết nối. Câu mongosh kiểm DB đích đi qua stdin, có chặn `'`/`\`. Bắt buộc dòng tổng kết của mongorestore. Metric ghi bằng `mv` nguyên tử.
- **Alert đúng.** `max(time() - m) > 7200 or absent(m)`: `>` ràng buộc chặt hơn `or`; có `absent` và 3 ca promtool.
- **Các lệch hướng của backend-dev — chấp nhận cả 6:**
  - `$inc` trên doc tenant: cần thiết, vì khi không còn super_admin thì không có membership nào để touch. Kèm theo đó là kiểm "DB thiếu `default-tenant` ⇒ lỗi" (chống nhầm DB).
  - Đếm super_admin dùng được trừ chính target: cần cho AC9 idempotent.
  - Audit insert thẳng bằng model, có `sanitizeMetadata`: `AuditService.record` không nhận session.
  - Digest tính trong Node.
  - Grep bí mật hẹp hơn: bù lại bằng việc so khớp mọi giá trị bí mật trong bộ nhớ.
  - Redirect socket Assuan cho gpg: chỉ dùng trong diễn tập.

## 🔴 Blocker

- [ ] **1. Cleanup chạy cả khi guard không gian tên đã từ chối** — `be/scripts/drills/backup-restore-drill.mjs:345-358`, `be/scripts/drills/rotate-drill.mjs:240-250` (`cleanupNamespace` ở `lib.mjs:368`).
  - **Vấn đề**: `assertNamespace` (`backup-restore-drill.mjs:130`, `rotate-drill.mjs:95`) và các kiểm Vault (`rotate-drill.mjs:93-94`) nằm **trong** `try`. Bất kỳ kiểm nào ném lỗi thì `finally` → `if (!dryRun) cleanupNamespace(ns)` ⇒ `FLUSHDB` Redis db 7/8 mà guard vừa thấy **không rỗng**, và `dropDatabase` một `vg-drill-*` **đã có từ trước**.
  - **Vì sao**: hai drill dùng chung Redis db 7 và cổng 4987. Tester chạy `backup-restore` song song với `rotate --provider local`, hoặc chạy lại khi lượt trước còn dở, thì lượt thứ hai bị từ chối (cổng bận, db 7 có key) nhưng vẫn xoá sạch db 7 và DB của lượt đang chạy. Lượt đầu hỏng giữa chừng, bằng chứng sai. Đây đúng là trường hợp D87.11 muốn chặn ("`DBSIZE` phải = 0 lúc bắt đầu; sai ⇒ exit trước khi ghi"). Ngoài ra `postCheck` khi đó còn báo `e2eUnchanged: true` một cách vô nghĩa, vì `e2eBefore` là `null`.
  - **Đề xuất**: thêm cờ `let owned = false;` và đặt `owned = true` ngay sau khi `assertNamespace` trả về (sau cả kiểm Vault). Trong `finally`, chỉ `cleanupNamespace`/`postCheck`/`writeEvidence` khi `owned`; nếu không thì in lỗi guard và `exitCode = 1`. Thêm một ca tự kiểm: đặt sẵn 1 key ở db 7, chạy `--provider local` không có `--dry-run` ⇒ exit 1 và key còn nguyên.

## Security invariants / trust boundaries đã kiểm

| Bất biến | Kết quả |
|---|---|
| CLI không bao giờ tạo user | ✅ `findOne` theo `normalizeEmail`; không có ⇒ `user_not_found` (int AC4 đếm user). |
| Nâng quyền ⇒ đúng 1 audit success **trong cùng transaction** | ✅ `auditModel.create([event], {session})` trong `runGuarded`; AC8 stub lỗi ⇒ membership/khoá giữ nguyên. |
| Mọi nhánh từ chối không đổi membership/user | ✅ Từ chối trước transaction thì chưa ghi gì; `Refusal` trong transaction ⇒ abort. |
| Race CLI∥CLI, CLI∥demote/lock qua API | ✅ Touch tenant doc + membership super_admin, đếm lại trên snapshot; write conflict ⇒ retry ⇒ thấy N ≥ 1. 💭: race với **unlock** qua API (chỉ sửa `users`) có thể sinh 2 super_admin; không phải leo thang, chấp nhận. |
| Leo thang âm thầm một user bất kỳ | Chỉ được khi có quyền ghi Mongo, và việc đó vượt mọi CLI (D87.13). Đường CLI luôn để lại audit + dòng JSON. Alert phụ thuộc pipeline log ⇒ 🟡 8. |
| Nhầm DB (confused deputy) | ✅ In `mongoTarget` trước khi kết nối, in `target: host:port/db` trước mã; DB thiếu `default-tenant` ⇒ ném lỗi trước khi ghi. |
| Không lộ email/hash/URI/env | ✅ Kế hoạch chỉ in id; `cliErrorText` lọc URI; `docker-smoke` check 12 grep cả mật khẩu lẫn email. Email nằm trên argv (lịch sử shell) — D87.12 đã chấp nhận. |
| Fail closed | ✅ Standalone/mất kết nối/audit lỗi ⇒ ném lỗi, exit 1, không ghi gì. |
| Backup: URI không lên argv, không echo | ✅ Ở script. ❌ Ở runbook §4c ⇒ 🟡 6. |
| Backup: từ chối thật sự **trước** khi kết nối | ✅ Restore: tuỳ chọn/tên/`dst==src`/manifest/`sha256` đều xử lý trước bước mongosh (drill kiểm với `MONGOSH=false`). |
| gpg: toàn vẹn / xác thực | Toàn vẹn ✅ (MDC/AEAD, pipefail). **Nguồn gốc ❌**: không ký, manifest nằm cạnh file ⇒ 🟡 7. Phát hiện lỗi MDC/AEAD chỉ ở cuối luồng ⇒ 🟡 5. |
| Harness: chỉ `vg-drill-*`, Redis 7/8, không `FLUSHALL` | ✅ Có regex/allowlist ở `dbUri`/`redisUri`/`cleanupNamespace`; không đường nào chạm `sso-idp`, `sso-idp-e2e` hay db 0–2. ❌ Guard bị bỏ qua khi từ chối ⇒ 🔴 1. |
| Bằng chứng không chứa bí mật | ✅ `assertClean` (JWT, argon2, URI có credential, mọi giá trị bí mật trong bộ nhớ). |

## 🟡 Nên sửa

2. **`budget()` thoát mà không dọn** — `be/scripts/drills/lib.mjs:473-480`.
   - **Vấn đề**: hết 10 phút thì gọi `process.exit(2)` ngay, nên `finally` không chạy.
   - **Vì sao**: trên Windows, BE con (`spawn` không `detached`) **không** chết theo tiến trình cha. Chúng tiếp tục giữ cổng 4987 và ghi vào Redis db 7. DB `vg-drill-*` cũng còn lại.
   - **Đề xuất**: khi hết giờ, kill các `bes[*].child` và `process.exitCode = 2`; hoặc truyền `AbortController` để `main` ném lỗi và đi qua `finally` (sau 🔴 1).
3. **Tên chuẩn xuất hiện trước khi xong mọi bước** — `ops/backup/mongo-backup.sh:82-85`.
   - **Vấn đề**: `mv` chạy trước khi ghi manifest và kiểm lại sha.
   - **Vì sao**: nếu bước sau lỗi (đĩa đầy khi ghi manifest), file tên chuẩn vẫn còn mà không có manifest hoặc manifest dở. D87.10 yêu cầu chỉ `mv` khi mọi bước đã exit 0.
   - **Đề xuất**: ghi manifest ra `"$FILE.manifest.json.partial"` (thêm vào `cleanup`), rồi `mv` archive và sau đó `mv` manifest. Bỏ dòng 85 (xem phần Ponytail).
4. **Thông báo lỗi trỏ tới log đã bị xoá** — `ops/backup/mongo-backup.sh:60`.
   - **Vấn đề**: câu lỗi bảo "see the mongodump log of this run", nhưng `trap cleanup` đã xoá `$LOG`.
   - **Vì sao**: job cron lỗi thì operator không có chẩn đoán nào.
   - **Đề xuất**: trước `die`, in khoảng 20 dòng cuối của `$LOG` ra stderr sau khi lọc credential (`sed -E 's#(mongodb(\+srv)?://)[^@/]*@#\1***@#g'`).
5. **Restore lỗi giữa chừng để lại DB đích dở** — `ops/backup/mongo-restore.sh:68-70`.
   - **Vấn đề**: gpg chỉ phát hiện MDC/AEAD sai ở **cuối** luồng, khi mongorestore đã ghi vào `$DST`. Câu lỗi "decryption or mongorestore failed" không nói gì về `$DST`.
   - **Đề xuất**: đổi câu lỗi thành `... $DST may be partially written: do NOT use it, drop it` (giống nhánh lệch số document), và ghi vào runbook §4b.
6. **Runbook §4c đặt URI production lên argv** — `docs/agile/sso-idp/runbook-ops.md` §4c (`mongosh "<MONGO_URI>" --quiet --eval ...`).
   - **Vì sao**: trái D87.7/DEBT-258 ("URI không bao giờ trên argv"); URI có mật khẩu sẽ lộ trong `ps` và lịch sử shell.
   - **Đề xuất**: dùng cách của `mongo-restore.sh`, đưa script qua stdin: `{ printf "db = connect('%s');\nconst TARGET='%s';\n" "$URI" "<db_mới>"; cat ops/backup/revoke-all-refresh-tokens.mongosh.js; } | mongosh --nodb --quiet`, với `URI` đọc từ file config 0600. Có thể gói thành `ops/backup/revoke-all-refresh-tokens.sh`.
7. **Backup không có xác thực nguồn gốc** — `ops/backup/mongo-backup.sh:58`, `mongo-restore.sh:41,68`.
   - **Vấn đề**: mã hoá bằng khoá công khai **không** chứng minh ai tạo ra file. Ai có public key (vốn công khai) và quyền ghi vào thư mục/bucket backup đều dựng được archive + manifest hợp lệ, vì `sha256` lấy từ manifest nằm ngay cạnh file.
   - **Vì sao**: restore một backup giả vào IdP tương đương cài sẵn super_admin hoặc client secret (chiếm toàn bộ hệ thống). Host backup bị chiếm chỉ có quyền **đọc** Mongo, nhưng nhờ đường này lại có quyền **ghi** khi restore.
   - **Đề xuất**: ký bằng khoá ký riêng của host backup (`--sign --local-user <fpr>`) và khi restore kiểm `--status-fd` có `VALIDSIG <fpr đã pin>`. Tối thiểu: runbook §4b ghi rõ giới hạn này và chỉ lấy file từ bucket có object lock (đối chiếu sha256 với bản offsite). → DEBT-617.
8. **Alert `ADMIN_RECOVERED` không được bảo đảm** — `be/src/database/admin-recover.ts:310-313`, `audit-action.enum.ts` (`ALERT_ACTIONS`).
   - **Vấn đề**: alert listener chỉ chạy trong process app, nên mục `ALERT_ACTIONS` không có tác dụng với CLI. Dòng JSON `{alert:true}` đi ra stdout của một `docker run --rm` chạy tay trên host ops, mà output này thường không vào pipeline log.
   - **Vì sao**: D87.13 dựa vào "alert qua log" như một kiểm soát thật.
   - **Đề xuất**: ngắn hạn, runbook §3d bắt buộc dán dòng JSON + `eventId` vào kênh incident/security. Dài hạn, app phát alert cho audit `ADMIN_RECOVERED` mới (đọc định kỳ hoặc change stream lúc chạy) hoặc xuất metric `sso_audit_events_total` từ collection. → DEBT-618.

## 💭 Nit

9. `be/src/database/admin-recover.ts:304` — khi bị từ chối **trong** transaction (`super_admin_exists` sau race), audit lại ghi `usableSuperAdmins` = `usable` đếm trước transaction (có thể là 0), không phải `n`. Nên cho `Refusal` mang theo `n`.
10. `admin-recover.ts:146-151` — target đã là super_admin dùng được và không còn ai khác ⇒ vẫn "recovered" và bắn alert cho một thao tác không đổi gì. Chấp nhận được (idempotent); có thể in thêm `note: already super_admin`.
11. `ops/backup/mongo-backup.sh:88` — glob prune `idp-${DB}-*` khớp cả `idp-${DB}-e2e-…` nếu hai DB dùng chung thư mục. Nên neo thành `idp-${DB}-[0-9]*`. Thêm vào đó, `.partial`/`.mongo-backup-log.*` còn sót sau SIGKILL không bao giờ bị prune.
12. `ops/backup/mongo-restore.sh:62` — `listDatabases` với user chỉ có role `restore`: nên kiểm khi tạo user production (diễn tập chạy không có auth nên chưa chứng minh được).
13. `backup-restore-drill.mjs:67-70` — `makeKeys` lỗi sau `tempDir('s')` thì `keys` chưa được gán, nên thư mục socket bị bỏ lại (rỗng).

## ✂️ Ponytail

- ops/backup/mongo-backup.sh:L85: delete: `sha256sum -c` lại đúng các byte vừa băm ở L76 không chứng minh được gì. Bỏ dòng này (kiểm thật nằm ở restore và ở `--list-packets`).
- be/src/database/admin-recover.ts:L106-120: native: `readLine` tự viết (timer + listeners). Thay bằng `readline/promises` `rl.question('', { signal: AbortSignal.timeout(ms) })` trong try/catch, EOF ⇒ null.
- be/src/modules/security/audit/audit-action.enum.ts:L57: yagni: `ADMIN_RECOVERED` trong `ALERT_ACTIONS` không bao giờ được app phát. Giữ lại vì AC12 yêu cầu, nhưng thêm chú thích "CLI: alert qua dòng log" (xem 🟡 8).

net: -9 lines possible.


---

# Senior Review lượt 2 — 2026-11-12

## Kết luận: PASS

Chỉ kiểm lại phần đã đổi so với lượt 1. Cả 🔴 1 và các 🟡 2–8 đều đã sửa; 💭 9 và 11 cũng đã sửa. Không có 🔴 mới. Chuyển sang **tester** (diễn tập T1/T3 Local + E2E) và orchestrator (Vault).

## Đã kiểm bằng chạy thật

- **Tự kiểm 🔴 1** (`scratchpad/be87/selfcheck.sh`, Git Bash; Redis db 7 lúc đầu `DBSIZE 0`): `selfcheck fail=0`.
  - db 7 có key + `vg-drill-restore` có sẵn ⇒ cả hai drill exit 1 với `REFUSED (nothing touched)`; key và DB còn nguyên; không để lại lock.
  - Chỉ có DB có sẵn ⇒ REFUSED.
  - Lock đang do drill khác giữ ⇒ REFUSED; nội dung file lock không bị đụng.
  - Sau khi chạy: db 7 `DBSIZE 0`, không còn `vg-drill-*`.
- **`signed_by_pin`** (chép nguyên hàm từ `mongo-restore.sh`; keyring tạm có khoá mã hoá, A = primary + subkey ký, B = khoá giả mạo):

  | Archive | pin A primary | pin A subkey | pin B |
  |---|---|---|---|
  | ký bằng A (gpg chọn subkey) | OK | OK | từ chối |
  | ký bằng subkey A (`fpr!`) | OK | OK | từ chối |
  | ký bằng B | từ chối | từ chối | OK |
  | ký bằng cả A và B | OK | OK | OK (A thật sự đã ký ⇒ đúng) |
  | chỉ mã hoá, không ký | từ chối | từ chối | từ chối |
  | ký nhưng không mã hoá | từ chối | từ chối | từ chối |
  | mã hoá đối xứng + ký B | từ chối | từ chối | OK |

  Kết luận: `VALIDSIG` `$3` (khoá đã ký) hoặc `$NF` (primary) phải bằng fingerprint đã pin. Chữ ký của khoá khác **không bao giờ** qua được. Subkey chỉ qua khi primary của nó là khoá đã pin; muốn thêm subkey vào một primary phải có chữ ký binding bằng private key của primary đó, và gpg tự kiểm binding này. Mọi `BADSIG`/`ERRSIG`/`EXPKEYSIG`/`REVKEYSIG` ⇒ từ chối, kể cả khi đồng thời có một `VALIDSIG` đúng. Lượt kiểm đầy đủ chạy **trước** khi kết nối Mongo; lượt restore kiểm lại và báo "partially written" nếu file bị đổi giữa hai lượt (TOCTOU).
- **mongosh qua stdin như file** (`mongosh --nodb --quiet /dev/stdin` trong `veyrigate-mongo`, chỉ đọc):
  - file §4c với `TARGET` không tồn tại ⇒ `Error: database does not exist`, exit 1;
  - kiểm `absent` của restore ⇒ in `absent`, exit 0;
  - server không tới được ⇒ exit 1, không có câu trả lời ⇒ script từ chối.

  Việc sửa lỗi REPL của kiểm tồn tại DB trong `mongo-restore.sh` là đúng: ở chế độ REPL trước đó, prompt bị in lẫn vào output nên không bao giờ khớp `absent`.
- **Lock file** `os.tmpdir()/vg-drill.lock` (`openSync 'wx'`):
  - chỉ xoá khi chính lượt này lấy được lock (`releaseLock?.()`);
  - crash ⇒ lock bị bỏ lại ⇒ lượt sau từ chối (fail closed); thông điệp nói rõ xoá file nào.
  - `budget()` không còn gọi `process.exit`: kill các child rồi đặt `exitCode = 2`, nên `finally` vẫn dọn.
- **Các sửa khác đã đọc**:
  - `mongo-backup.sh`: manifest ghi `.partial` rồi đổi tên cả hai ở bước cuối; in `log_tail` có che credential; đã bỏ kiểm sha thừa; prune neo theo mẫu timestamp; ký `--local-user`.
  - Câu lỗi `$PARTIAL` của restore.
  - Runbook §3d có bước dán dòng alert + eventId; §4 nói rõ ký/pin/xoay khoá.
  - Ca âm "rogue signer" trong harness.
  - `Refusal` mang theo số đếm `n` trong transaction.

## 🔴 Blocker

Không có.

## 🟡 Nên sửa

Không có mục mới.

## 💭 Nit (lượt 2 → DEBT-619)

- R2-1. `runbook-ops.md` §4c: `sed 's/^uri:[[:space:]]*//p'` giữ nguyên dấu nháy YAML và không chặn `'`/`\` trong URI, nên `connect('…')` có thể vỡ. `mongo-restore.sh:63,77` đã có cả hai bước (bỏ nháy + `case` chặn ký tự); nên chép lại y hệt vào runbook.
- R2-2. Khoá ký: `EXPKEYSIG`/`REVKEYSIG` ⇒ từ chối. Nếu khi xoay hằng năm mà thu hồi hoặc để hết hạn khoá cũ, các bản backup ≤ 35 ngày ký bằng khoá đó sẽ **không restore được**. Runbook nên ghi: khoá ký không đặt hạn; xoay định kỳ thì chỉ ngừng dùng, không thu hồi (chỉ thu hồi khi bị lộ); giữ public key cũ trong keyring của host restore.
- R2-3. Chữ ký không ràng buộc tên DB/thời điểm. Một bản cũ có chữ ký hợp lệ có thể bị đổi tên để trông như bản mới nhất (rollback). Chấp nhận được: operator chọn file theo metadata object-lock. Nên ghi một dòng trong §4b.
- R2-4. Restore giải mã hai lần (lượt kiểm + lượt restore) ⇒ thời gian giải mã gấp đôi trong RTO. Chấp nhận với archive ≤ 1 GB; diễn tập sẽ đo.

## ✂️ Ponytail (lượt 2)

Lean already. Ship. (Việc giữ `readLine` tự viết đã có lý do: hành vi EOF của `rl.question` khác; chấp nhận.)
