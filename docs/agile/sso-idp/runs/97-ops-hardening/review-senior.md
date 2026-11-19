# Senior Review — 2026-11-19

## Lô A (T4, DEBT-280: Redis phiên fe-admin ở production)

### Kết luận: PASS

Phạm vi: `fe-admin/src/server/env.ts`, `fe-admin/test/env-matrix.test.ts`, `fe-admin/test/env.test.ts`,
`fe-admin/scripts/docker-smoke.sh`, `fe-admin/.env.example`, `fe-admin/README.md`, `runbook-deploy.md` §7.
Không review thay đổi lô B (`be/`, `ops/`, runbook-ops, runbook-deploy §4/§16).

Chạy lại (reviewer): fe-admin `test` 69 file / 1669 pass, `typecheck` 0 lỗi, `lint` 0 lỗi,
`bash -n scripts/docker-smoke.sh` OK. Không chạy Docker (smoke thật để CI `fe-admin-image`).

### Tổng quan

Thay đổi nhỏ, đúng D97.22/D97.23. Điểm tốt:
- Parse của validation **trùng với parse của ioredis 6.0.0**: `built/utils/index.js` `parseURL` dùng WHATWG
  `new URL` + `decodeURIComponent(parsed.username)`, cùng cách `aclUsername()` làm. `%64efault` bị chặn ở
  cả hai phía; query `?username=default` không vượt được vì ioredis dùng `defaults(result, options)`
  (username trong URL thắng, URL không username thì validation đã từ chối).
- `abort: true` trên `z.url` ⇒ refine chỉ chạy trên URL hợp lệ, lỗi đúng 1 dòng; `decodeURIComponent` ném
  (`%ZZ`) ⇒ `""` ⇒ từ chối (fail closed).
- Một thông báo cố định cho mọi lỗi (kể cả thiếu biến, vì `error` của zod áp cho mọi issue), test canary
  kiểm cả message lẫn `console.error`.
- Test có nghĩa: 6 case âm (redis://, không user, `default`, `%64efault`, scheme khác, không phải URL), 3 case
  dương, nhánh `import.meta.env.PROD` không cần `NODE_ENV`, ngoài prod giữ `redis://`.

### 🔴 Blocker

Không có.

### Security invariants / trust boundaries đã kiểm

- **Fail closed lúc boot**: production + URL sai ⇒ `parseServerEnv` ném ⇒ container exit 1 (smoke 12b kiểm
  exit đúng 1). Dev/E2E (`vite dev`, `NODE_ENV=test`, `e2e/config/env.ts`) không đi nhánh prod ⇒ không vỡ.
- **Exposure**: lỗi chỉ có tên biến + thông báo cố định; `"rediss://"` trong thông báo không khớp
  `grep -F 'redis://'` (sau `redis` là `s`, không phải `:`), nên check 12b và test `not.toContain("redis://")`
  không tự bắn nhầm. Smoke truyền env bằng `-e NAME`, không có URL/mật khẩu trên command line.
- **Nhất quán parser** validation ↔ ioredis: xem trên (không có bypass bằng percent-encoding/query).
- **ACL** (D97.23): lệnh fe-admin dùng (`session/store.ts`: SET PX/NX/KEEPTTL/XX, GET, DEL, PEXPIRE, GETDEL)
  nằm trong `+get +set +del +pexpire +getdel`; handshake ioredis 6 là RESP3 `HELLO 3 AUTH …` (HELLO/AUTH là
  lệnh no-auth, không cần quyền), `CLIENT SETINFO` lỗi bị `noop`, `SELECT` cần `+select`, ready check cần
  `+info`. Khối ACL đủ.
- **Smoke script**: assignment tiền tố trước hàm `docker` được export cho `command docker` (đã thử bằng bash);
  log ghi file rồi grep (không SIGPIPE với pipefail); container mới `vg-fea-smoke-redis` có trong `NAMES` ⇒
  `docker rm -f` theo tên chính xác ở đầu và trong trap. Đếm `pass`: 1,2,3,4,5,6,7,8,8b,9,9b,9c,10,11,12,12b,
  13,14 = 18, khớp "18/18" và runbook. **Check 8** vẫn hợp lệ: `rediss://` tới cổng đóng ⇒ TCP refused trước
  TLS, `commandTimeout`/`enableOfflineQueue:false` giữ fail nhanh ⇒ 503; IdP `.invalid` cũng không tới được;
  `/healthz` không chạm Redis nên check 2 không đổi.

### 🟡 Nên sửa

🟡 **Tài liệu: khối "Redis phiên" cắt đôi danh sách bullet của §7**
`runbook-deploy.md`:242–262 — khối mới chèn giữa "Chỉ 1 replica" và hai bullet "Rate limit `/auth/login` ở
proxy" / "`Sec-Fetch-Site` … (DEBT-376)". Hai bullet đó giờ nằm sau code block, dưới tiêu đề **Redis phiên**.
Vì sao: người vận hành đọc lướt sẽ tưởng rate limit/CSRF là việc của Redis, hoặc bỏ sót khi chỉ đọc danh sách
chung. Đề xuất: chuyển khối "Redis phiên" xuống sau bullet DEBT-376 (ngay trước **Healthcheck**). → DEBT-705.

### 💭 Nit

💭 `runbook-deploy.md`:255 — `ACL DRYRUN` chỉ kiểm GET; thiếu `+info`/`+select` sẽ không lộ ra, và `/healthz`
không chạm Redis nên container vẫn healthy trong khi mọi login 503. Cân nhắc thêm `ACL DRYRUN fea INFO` ⇒ OK
và một lần đăng nhập thật sau deploy. Gộp vào DEBT-702 được, không cần DEBT mới.

💭 `env-matrix.test.ts` — dev ghi "phân biệt hoa thường" (`Default` là user ACL khác `default` trong Redis,
đúng), nhưng chưa có case dương `rediss://Default@…` để khóa hành vi đó. Tùy chọn.

### ✂️ Ponytail

Lean already. Ship.

(`aclUsername()` 7 dòng, try/catch cần cho `decodeURIComponent`; không thêm option `tls`, đúng YAGNI D97.22.)

### DEBT mới

- **DEBT-705** (🟡 [docs/ops]): runbook-deploy §7, khối "Redis phiên" cắt đôi danh sách bullet; chuyển xuống
  sau bullet DEBT-376. Chưa ghi `backlog.md` (orchestrator gộp cùng DEBT-701..704).

## Lô B (T3 → T2 → T5; DEBT-218, DEBT-126, DEBT-618)

### Kết luận: PASS

Phạm vi: `audit.service.ts`(+spec), `audit-action.enum.ts`, `audit-alert-watch.ts`(+spec), `security.module.ts`,
`metrics.ts`, `ops-rules.spec.ts`, `tenant-context.ts`, `admin-auth.errors.ts`, `admin-guards.spec.ts`,
`ops/prometheus/alerts{,.test}.yml`, int `run97-admin-denied`, `run97-audit-alert-watch`, sửa `metrics.int-spec` +
`run80-tester`, runbook-ops §3d/§14/§15, runbook-deploy §4 bước 7/§16; phần orchestrator ở fe-admin
(`openapi/admin.json`, `schema.d.ts`, `inputs.ts` `AUDIT_ACTIONS`).

Chạy lại (reviewer): be `typecheck` 0, `lint` 0, unit 68 suite / **1333 pass**; int `run97-admin-denied`,
`run97-audit-alert-watch`, `metrics.int-spec`, `run80-tester`, `admin-api` ⇒ 5 suite / 177 pass (snapshot OpenAPI
của `run80-tester` đã xanh sau khi orchestrator thêm enum). fe-admin `admin-schema-types` + `audit-ui` 31 pass, `tsc` 0.
promtool không có trên máy dev; đã tính tay ngoại suy `increase`/`rate` cho mọi case (bên dưới), job CI `promtool` là
required check nên gate vẫn chặn nếu sai.

### Tổng quan

Thiết kế gọn, bám sát D97.x. Điểm tốt: đếm trước ghi nên Mongo sập không còn che `SsoTokenReuseDetected`; log lỗi ghi
chỉ có `{alert, action, eventId}`; audit từ chối chỉ sau khi chữ ký hợp lệ (kẻ không có token không ghi được Mongo);
SET NX atomic nên không có document trùng khi request đồng thời; poll stateless + cờ `running` + `unref`. Mutation tay
dev ghi lại (D97.5/D97.11) chứng minh test thực sự bắt lỗi thứ tự đếm và dedupe.

### 🔴 Blocker

Không có.

### Security invariants / trust boundaries đã kiểm

- **Đếm trước ghi, không đếm đôi**: `observeAuditEvent` chạy đúng 1 lần trước `create`; lỗi ghi ⇒ thêm
  `sso_audit_write_failures_total` (series khác), không gọi lại `observeAuditEvent`. Không caller nào retry `record`
  trong cùng tiến trình (đã grep). `observeAuditEvent` chỉ được gọi từ `AuditService.record`.
- **Exposure**: log lỗi ghi không có metadata/message Mongo (unit có canary `fam-secret`); warn của guard và của watch
  chỉ `err.name`; audit `ADMIN_ACCESS_DENIED` dùng route template (`routeOptions.url`), không URL thô/token (int (b)
  canary token). Dedupe key dùng `sha256(sub)`, sub không vào Redis.
- **Auth fail-closed, audit fail-open**: mọi nhánh `deny()` vẫn ném đúng `AdminAuthError` gốc; `auditDenied` nuốt mọi
  lỗi Redis/Mongo (unit: Redis reject ⇒ 401, record reject ⇒ 401/403). Lỗi hạ tầng của `isAccessTokenLive` vẫn
  propagate 5xx như cũ. Filter chỉ thêm metric trong try/catch; wire body/header không đổi (int (a)–(e)).
- **DoS ghi Mongo**: `invalid_token` không có sub đã verify ⇒ không bao giờ tới `auditDenied` (verifier bắt buộc
  `sub` là string, `token-verifier.ts:112-126`), nên khóa dedupe luôn có sub thật. Mỗi tài khoản ≤ 5 document/15',
  toàn hệ thống ≤ 60/phút. Đường thêm độ trễ: dedupe trúng = 1 RTT Redis; dedupe trượt = 2 RTT + 1 insert (≤ 60/phút).
- **Multi-instance**: alert dùng `sum(...)`/`time() - max(...)`; poll aggregate trên `action_1` (int kiểm IXSCAN),
  `maxTimeMS 5000`, không chồng tick, timer `unref` + `clearInterval` ở `onModuleDestroy`.
- **PromQL (tính tay)**: `SsoAuditWriteFailed` 4m ⇒ increase = 1 (giá trị đầu 0 ⇒ không ngoại suy đầu) ⇒ fire, 2m ⇒ 0.
  `SsoAdminAccessDenied` 6m ⇒ 6 + 4 = 10 ≥ 10 fire (đúng biên, không ngoại suy vì mẫu đầu = 0 và mẫu cuối = eval time);
  9 ⇒ không; 35m ⇒ 0. `SsoAdminInvalidTokenHigh` 0,5/s ⇒ pending từ ~1–2m, fire ở 25m, 8m còn pending (không tính);
  0,1/s ⇒ không. `SsoAdminRecovered/Bootstrapped`: 35m ⇒ 2100 − 0 > 1800 im; 50m ⇒ 600 < 1800 fire; 75m ⇒ 2100 im.
  Giá trị 0 ngoài đời ⇒ `time()` ~1.8e9 ⇒ không bao giờ fire.

### 🟡 Nên sửa

- [ ] **DEBT-707 — `not_live` sau logout không có `tenantId`** — `tenant-context.ts:219`. Liveness trả false ở bước
  tombstone Redis trước khi tra client, nên document `not_live` của trường hợp quan trọng nhất (AT admin bị replay sau
  logout, D97.8) không có tenant ⇒ `GET /admin/audit` của tenant admin không thấy, chỉ mongosh (runbook §15 đã ghi rõ).
  Vì sao: điều tra lộ token phụ thuộc người có quyền mongosh production; console vô dụng cho case này.
  Đề xuất: trong `auditDenied`, *sau* khi dedupe + trần đã cho qua và `tenantId === undefined` với reason `not_live`,
  tra `clients.findByClientId(claims.client_id)` (client_id đã verify chữ ký, tối đa 60 lần/phút) để điền tenant; lỗi
  tra vẫn nuốt như các bước khác. Đúng spec hiện tại nên không chặn.
- [ ] **DEBT-708 — int `run97-admin-denied` có thể flaky vì trần toàn cục** — `test/run97-admin-denied.int-spec.ts:41`.
  Bucket `rl:admin-deny-audit:account:<sha256(global)>` dùng chung Redis db0 giữa các suite int chạy tuần tự; suite admin
  trước đó tạo > 60 lượt từ chối đã verify (mỗi user mới là một sub mới) trong cùng cửa sổ 60 s ⇒ (b)/(c)/(d) không có
  document ⇒ đỏ ngẫu nhiên. Đề xuất: `beforeAll` xoá đúng key đó (key của chính hợp đồng này, không scan pattern), hoặc
  cho case cap một test riêng và các case khác chờ/xoá bucket. Hiện chạy 5 suite xanh, nhưng full int 2510 test chưa
  chắc.

### 💭 Nit

- `tenant-context.ts:278-285`: dedupe key được SET trước khi qua trần và trước khi ghi; trần từ chối hoặc Mongo lỗi ⇒
  sub+reason đó im 15'. Kẻ có nhiều tài khoản có thể đốt trần 60/phút để che probe của tài khoản thật khỏi audit (metric
  vẫn đếm, `SsoAdminAccessDenied` vẫn bắn). Chấp nhận được theo D97.9; nếu muốn chặt hơn: `DEL` key dedupe khi trần
  từ chối/record lỗi.
- `tenant-context.ts:285`: `await this.audit.record` trên đường từ chối ⇒ Mongo treo thì request bị từ chối chờ tới
  `serverSelectionTimeoutMS` (5 s) trước khi 401 — đặc biệt nhánh `not_live`-tombstone vốn chưa chạm Mongo. Bị dedupe
  giới hạn (1 lần/sub/reason/15'), đúng D97.9 nên không đổi; nếu cần: `void this.auditDenied(...)` (hàm đã tự catch).
- `audit-alert-watch.ts:53`: poll hỏng kéo dài (mất quyền đọc `auditlogs`, timeout) chỉ có WARN ⇒ `SsoAdminRecovered`
  im lặng mà không ai biết. Dòng JSON CLI vẫn là đường chính (runbook §3d), nên chỉ ghi nhận.
- runbook-ops §15 "Hành động" `forbidden`: `forbidden` ném từ handler (`assertSuperAdmin`…) được đếm metric nhưng không
  audit (D97.8) ⇒ `SsoAdminAccessDenied` có thể bắn mà mongosh không có document; nên thêm một câu.
- fe-admin: `ADMIN_ACCESS_DENIED` chỉ cần là option lọc (select render mã action thô, như các action khác); không phải
  alert action nên `alert-label.ts` / dashboard risk không cần nhãn. Không thiếu gì.

### ✂️ Ponytail

- metrics.ts:L33: delete: `export type AuditAlertWatched` không ai dùng. Xoá dòng.
- tenant-context.ts:L225: yagni: reason `not_admin_capable` không tới được (liveness DEBT-177 đã trả `not_live` cho cùng
  điều kiện). Giữ check phòng thủ, có thể audit chung `not_live` và bỏ member khỏi `AdminDenyAuditReason` + câu runbook;
  không bắt buộc.
net: -3 lines possible.

## Sửa lô B + Lô C (T1, DEBT-072) — 2026-11-19

### Kết luận: REJECT (1 🔴, lô C) — chuyển lại **backend-dev**

Sửa lô B: PASS (không có gì mới phải sửa). Lô C: REJECT vì nguồn đã miễn trừ vẫn hoàn bucket toàn cục, phá đúng bất biến mà T1 lập ra.

Chạy lại (reviewer): be typecheck 0, lint 0, unit 69 suite / 1350 pass; int 10 suite / 357 pass (`client-auth-rate-limit`,
`run97-admin-denied`, `run97-audit-alert-watch`, `metrics`, `admin-api`, `clients`, `token`, `introspect`, `run59-http-edge-tester`
+ suite trùng mẫu tên). Mutation D97.17 (`if false and redis.call('EXISTS', KEYS[2])`) ⇒ `client-auth-rate-limit` 1/22 đỏ; đã khôi
phục từ bản sao, sha256 file trùng bản trước mutation. promtool để CI (tính tay: case 4m `increase` 0→2 > 0 ⇒ fire `scope=client`;
2m và 12m rỗng; `source` không nằm trong expr ⇒ đúng).

### Tổng quan

- Sửa lô B gọn: tra `findByClientId` chỉ sau dedupe + trần 60/phút nên không thành cách khuếch đại truy vấn Mongo; `release` + `finally`
  nhả khoá dedupe đúng ở 3 nhánh không ghi (trần từ chối, tra lỗi, ghi lỗi); `release = false` chỉ sau `record` thành công.
  Int `beforeEach` xoá đúng một key trần toàn cục (không `KEYS`). Case (b) kiểm `tenantId` và `GET /admin/audit` của admin khác cùng tenant.
- Lô C đúng thứ tự D97.14: per-IP → find → global → Argon2. Bị chặn ⇒ không Argon2, refund per-IP, 429 giống hệt per-IP (không lộ
  `scope` ra wire). Không key nào sinh từ client_id thô của kẻ tấn công (int (d)). Lua atomic, `INCR` + `PEXPIRE` lần đầu trong cùng
  script, `logKey` `PX pttl`, okKey `PX 7d` ⇒ không key sống mãi. Redis lỗi ở `reserveGlobal` ⇒ propagate (fail-closed, unit kiểm).
  Log chỉ `clientId` đã đăng ký / `(unknown)`, không IP/secret. Metric 3 series cố định, khởi tạo 0.
- Unit spec mới kiểm thứ tự gọi bằng mảng `calls` — rõ ràng, đáng giữ làm mẫu.

### 🔴 Blocker

- [ ] 🔴 **Bảo mật/DoS: nguồn được miễn trừ vẫn hoàn bucket toàn cục ⇒ trần vô hiệu đúng với client bận nhất**
  `rate-limit.service.ts` `CLIENT_OK_SCRIPT` (`if count > 0 then DECR`) + `client-authentication.service.ts:197` gọi `clientOk` sau
  mọi lần thành công, kể cả khi `reserveGlobal` đã đi nhánh miễn trừ (`okKey` tồn tại ⇒ `{0,0,0}`, không `INCR`).
  Vì sao: mỗi lần RP thật (nguồn tin cậy) xác thực thành công lại `DECR` một đơn vị do botnet `INCR`. RP 1 req/s ⇒ botnet được thêm
  ~60 lần Argon2/phút ngoài `CLIENT_AUTH_FAIL_GLOBAL_MAX`; RP 100 req/s ⇒ trần gần như không tồn tại, alert `SsoClientAuthGlobalLimit`
  không bắn. Phá bất biến D97.14 "Argon2 ≤ limit / cửa sổ cho mỗi bucket" đúng trong mô hình đe doạ DEBT-072 (botnet xoay IP).
  Reviewer tái hiện bằng chính 2 script Lua trên Redis int (key riêng `review97:*`, đã xoá): limit 3, botnet làm đầy ⇒ chặn; nguồn tin
  cậy 3 lần reserve (miễn) + clientOk ⇒ `gKey = 0` ⇒ botnet lại không bị chặn. Gốc ở spec: D97.14 bước 6 không phân biệt đã reserve hay miễn.
  Đề xuất: `RESERVE_GLOBAL_SCRIPT` trả thêm cờ đã `INCR` (nhánh miễn `{0,0,0,0}`, nhánh `INCR` `{0,0,0,1}`) ⇒
  `GlobalReserveResult.reserved`; khi thành công chỉ `DECR` nếu `reserved` (truyền cờ làm `ARGV[2]` của `CLIENT_OK_SCRIPT`), vẫn luôn
  `SET okKey`. Thêm int case (b'): bucket đầy, nguồn tin cậy thành công N lần ⇒ nguồn mới sai secret vẫn 429; unit: miễn trừ ⇒ không
  giảm bucket. Mutation: bỏ điều kiện `reserved` ⇒ case mới đỏ.

### Security invariants / trust boundaries đã kiểm

- **Thứ tự / CPU**: Argon2 không chạy khi per-IP hoặc global chặn (unit `verifySecret` not called; int (a) spy). ✔
- **Enumeration client_id**: timing có/không client như nhau (cùng find + reserve + Argon2/dummy); 429 giống hệt mọi scope. Còn một
  oracle trạng thái (🟡 DEBT-709). ✔ có điều kiện
- **Atomic / TTL**: mỗi script atomic; chặn không `INCR`; `pttl < 1 ⇒ 1`; okKey 7 ngày; không key vĩnh viễn. ✔
- **Miễn trừ okKey**: theo `sha256(req.ip)` của request đã thành công với secret đúng; client lạ dùng `:ok:never` không bao giờ được set
  (`clientOk` chỉ chạy khi `client` khác null). XFF chỉ giả được khi `TRUST_PROXY` cấu hình sai (🟡 DEBT-710). Hoàn bucket sai: 🔴.
- **Refund per-IP**: chỉ ở nhánh global chặn (không Argon2) và khi thành công; thất bại giữ cả hai. ✔
- **Fail-closed**: lỗi Redis ở `reserveGlobal` propagate ⇒ 503; per-IP không refund (đếm thừa, an toàn). `clientOk` lỗi chỉ warn. ✔
- **Exposure**: log không IP/secret; warn chỉ `err.message` như `refund()` sẵn có; wire 429 không có `scope`. ✔
- **Cardinality**: `scope` 3 giá trị cố định, `isOneOf` chặn giá trị lạ. ✔
- **Lô B**: không nhả khoá khi đã ghi; tra tenant bị trần chặn; lỗi tra ⇒ không ghi document thiếu tenant. ✔
- **run59 marker `/admin/users`**: vẫn giữ ý nghĩa — URL gửi là `/admin/users/aaaa…`; `aaaa` bắt echo tham số, `/admin/users` bắt echo
  đường dẫn ở raw response, log và label metric (app của test không có route template `/admin/users…` trong `/metrics` trước case, int
  xanh). Chỉ mất khả năng bắt chữ `admin` đứng riêng — chấp nhận được. ✔

### 🟡 Nên sửa

- 🟡 **DEBT-709 Oracle tồn tại client_id khi bucket `{unknown}` đầy.** `client-authentication.service.ts:79` `globalKeys`.
  Kẻ tấn công gửi `CLIENT_AUTH_FAIL_UNKNOWN_MAX` id ngẫu nhiên (vd. 30 IP × 10) ⇒ sau đó id lạ trả 429 ngay, id có thật trả 401 ⇒
  phân biệt được. Không 🔴 vì client_id không phải secret (RFC 6749 §2.2), `/authorize` vốn đã lộ id tồn tại, và thiết kế D97.14 đã duyệt.
  Đề xuất: ghi rõ oracle này trong runbook-ops §16 và rủi ro còn lại D97.13.
- 🟡 **DEBT-710 `TRUST_PROXY` sai làm sụp hoặc lách miễn trừ.** runbook-ops §16 chỉ nói "mọi request trông như từ IP proxy".
  Vì sao: TRUST_PROXY tắt sau proxy ⇒ mọi nguồn chung một IP ⇒ một lần RP thành công là IP proxy được miễn 7 ngày ⇒ botnet cũng được
  miễn, trần toàn cục mất. Trust quá rộng ⇒ kẻ tấn công giả XFF = IP egress của RP. Đề xuất: thêm 1 câu vào §16 và runbook-deploy §4
  bước 7 (rule thứ 6); cân nhắc warn lúc khởi động khi production mà TRUST_PROXY rỗng (nếu chưa có).

### 💭 Nit

- `client-auth-rate-limit.int-spec.ts` `beforeEach` `DEL rl:client-auth-g:{unknown}` trên Redis db0 dùng chung — an toàn nhờ
  `vg:int-lock` tuần tự; nên có 1 dòng comment để người sau không chạy song song.
- `client-authentication.service.ts:197` try/catch quanh `clientOk` trùng mẫu `private refund()` (xem ✂️).
- E2E `e2e/config/env.ts` không đặt 2 biến mới — default 100/300 đủ cho E2E hiện tại; chỉ lưu ý nếu E2E thêm kịch bản sai secret hàng loạt.

### ✂️ Ponytail

- rate-limit.service.ts:L266: yagni: tham số `windowSec?` của `reserveGlobal` không caller nào truyền. Bỏ, dùng `this.defaults.windowSec`.
- client-authentication.service.ts:L197: shrink: try/catch + warn riêng cho `clientOk`. Gộp với `refund()` thành một helper best-effort.
net: -6 lines possible.

### DEBT mới (ghi vào `backlog.md` khi lượt sau PASS)

- DEBT-709 🟡 [BE/docs] oracle client_id khi `{unknown}` đầy — ghi runbook §16 / chấp nhận.
- DEBT-710 🟡 [ops/docs] TRUST_PROXY sai làm sụp/lách miễn trừ okKey — runbook-ops §16 + runbook-deploy §4 bước 7.

## Lô C lượt 2 (retry 1, T1 DEBT-072) — 2026-11-19

### Kết luận: PASS — chuyển sang **tester**

🔴 lượt 1 đã đóng. Không còn 🔴, không có 🟡 mới.

Chạy lại (reviewer): be typecheck 0, lint 0, unit 69 suite / 1351 pass; int `client-auth-rate-limit` 23/23 + `clients`, `token`,
`introspect`, `metrics` (6 suite / 243 pass). Phần đã PASS ở lượt 1 không review lại.

### 🔴 lượt 1 — đã đóng

- `RESERVE_GLOBAL_SCRIPT` trả cờ thứ 4 `reserved`: miễn `{0,0,0,0}`, chặn `{1,pttl,first,0}`, INCR `{0,0,0,1}`. `CLIENT_OK_SCRIPT` chỉ
  `DECR` khi `ARGV[2] == '1'`, luôn `SET okKey PX 7d`. Service truyền `global.reserved`.
- Tái hiện lại bằng chính 2 script Lua trên Redis int (key riêng `review97b:*`, đã xoá): thành công từ nguồn mới ⇒ `{0,0,0,1}`, DECR về 0,
  okKey có TTL; botnet làm đầy (limit 3) ⇒ chặn; nguồn tin cậy 5 lần reserve(miễn)+clientOk ⇒ `gKey` vẫn 3, botnet vẫn bị chặn. ✔
- Int (b') đúng kịch bản (5 lần thành công từ nguồn tin cậy, nguồn mới sai secret vẫn 429, `gKey = GLOBAL_MAX`). Unit mới
  "exempt ... NOT given back (reserved=false)".
- Mutation mới (reviewer chạy): `if ARGV[2] == '1' then` ⇒ `if true then` ⇒ `client-auth-rate-limit` 1/23 đỏ; khôi phục từ bản sao,
  sha256 khớp bản trước mutation.

### Phần mới đã soi

- `bestEffort(what, op: Promise)`: promise tạo trước `try` nhưng cả `refund` lẫn `clientOk` là `async` ⇒ lỗi luôn là promise reject,
  được `await` ngay trong `try` ⇒ không unhandled rejection, không ném đồng bộ. Log giữ nguyên dạng cũ (`client-auth rate-limit refund failed: <message>`). ✔
- Bỏ `windowSec?` ✔. Thứ tự refund rồi `clientOk` khi thành công giữ nguyên; nhánh chặn vẫn chỉ refund per-IP. ✔
- Runbook-ops §16 thêm DEBT-709 (oracle `{unknown}`, chấp nhận, lý do RFC 6749 §2.2) và DEBT-710 (TRUST_PROXY tắt ⇒ botnet được miễn
  cùng RP; quá rộng ⇒ giả XFF; dấu hiệu "alert im lặng khi log proxy có tấn công"). Runbook-deploy §4 bước 7 có câu TRUST_PROXY. Chính xác,
  hành động được. ✔

### 🟡 Nên sửa

- Không.

### 💭 Nit

- Chưa có cảnh báo lúc khởi động khi `NODE_ENV=production` mà `TRUST_PROXY` rỗng (`src/config/trust-proxy.ts` chỉ có comment). Sau T1,
  TRUST_PROXY sai không chỉ làm lệch bucket per-IP mà còn vô hiệu trần toàn cục ⇒ một dòng `warn` khi boot đáng giá. Đề xuất mở
  **DEBT-711** (💭 [BE]) nếu orchestrator muốn theo dõi; không chặn run này.
- 2 💭 lượt 1 (comment `vg:int-lock` cạnh `DEL {unknown}`, E2E env) vẫn còn, không cần làm.

### ✂️ Ponytail

Lean already. Ship.

### DEBT

- DEBT-709: coi là **đóng** — rủi ro chấp nhận, đã ghi runbook-ops §16 (đúng hành động đề xuất).
- DEBT-710: coi là **đóng** — đã ghi runbook-ops §16 + runbook-deploy §4 bước 7. Phần cảnh báo khi boot tách sang DEBT-711 💭 (tuỳ chọn).
