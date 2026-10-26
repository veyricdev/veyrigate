# Senior Review — 2026-10-26 (run 54: DEBT-388 / DEBT-401 / DEBT-398)

## Kết luận: PASS

Không có 🔴, không có 🟡. Chỉ còn 💭 (không bắt buộc, không ghi debt mới). Chuyển **tester**.

Bằng chứng tự chạy (preflight codegraph 1.6.2, status OK, sync OK; diff chưa commit so với `9c02a11`, bỏ `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`): `pnpm -C be typecheck` OK, `pnpm -C be lint` OK, `pnpm -C be test` 558/558 (37 suites). Không chạy int/vault/E2E (dev đã chạy int 1256, vault 23, E2E 35, mutation M1–M7, M5a–c, canary Docker 6/6 FAIL + control 4/4 qua; đọc test và log đủ để đối chiếu).

## Tổng quan

Thay đổi nhỏ, đúng fold tech-lead và đúng nguyên tắc "ký trên bản đọc, commit bằng primitive nguyên tử cũ, chỉ trả token khi commit thắng và mọi re-check đạt". Không đổi Lua, không đổi `rotate`, không thêm khoá Redis/collection/field. Điểm tốt:

- Cổng ký ở controller và các kiểm tra sau `consume` dùng cùng predicate. Nếu hai chỗ lệch nhau thì hướng lệch nào cũng fail closed: thêm refusal phía sau thì token đã ký bị bỏ; bỏ một predicate phía sau mà cổng còn giữ thì `issueForAuthorizationCode` gặp `signed` undefined và ném 500. Không có hướng lệch nào phát ra token.
- Các kiểm tra sau `consume` dùng `data` lấy từ consume (không dùng `peeked.data`). `raw === peeked.raw` bảo đảm token đã ký đúng là cho bản ghi bị tiêu.
- Phân loại DEBT-401 nằm ở biên public của provider và chạy sau nhánh refresh DEBT-395, nên nhánh `instanceof VaultStatusError` bên trong vẫn thấy lỗi gốc. `LocalKeyProvider`/`TokenSigner` giữ nguyên, nên bug signer vẫn ra 500.
- Test int mới kiểm tra trạng thái thật: `EXISTS`/PTTL của khoá code, các trường stamp của RT, số audit, số family. `afterEach` assert log không chứa `eyJ` cho mọi case. Hai pin đổi có chủ đích (R5, DEBT-067) có comment ghi lý do và vẫn chặn đúng điều cần chặn: không body, không audit success, không log.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

**Code grant** (`token.controller.ts:178-237`, `authorization-code.service.ts:102-153`, `token.service.ts:103-172`)

| Interleaving | Đối chiếu code | Kết quả |
|---|---|---|
| 2 request cùng code (A,B cùng ký) | Lua GET+binding+DEL nguyên tử; bên thua `consume` null ⇒ `invalid_grant` ở L208, `signed` ra khỏi scope; test C3 | I1 ✅ |
| A ký lỗi, B thắng | Lỗi ký ném ở L196 trước `consume`, không audit; A retry ⇒ `peek` null; test C4 | I1, I4 ✅ |
| Code hết TTL trong lúc ký (≤ ~4×`VAULT_TIMEOUT_MS`) | `consume` null ⇒ `invalid_grant`, không family. Cùng nhánh với C3 (không có test riêng, xem 💭-3) | I3 ✅ |
| Refusal thuần (resource body sai, admin-forbidden, thiếu sessionRef) | `signable=false` ⇒ không ký, vẫn `consume` ⇒ đốt code như cũ; test C5 (a)(b)(c), `sign` không được gọi | ngữ nghĩa cũ ✅ |
| Binding sai | `peek` so đúng 3 trường như Lua (`~=` trên chuỗi ⇔ `!==`; trường thiếu thì cả hai đều coi là lệch) ⇒ null, không ký, không DEL; test C6 + unit | INV-13 ✅ |
| Logout giữa peek↔consume / consume↔insert | `sessions.exists` sau consume và re-check sau insert giữ nguyên, đúng thứ tự | INV-29 ✅ |
| Redis lỗi ở peek | Throw ⇒ 503 qua `isRedisUnavailable`; `redis-down.int-spec` pin thêm `error_description` | I4 ✅ |
| Redis lỗi ở consume sau khi ký | 503/500, có thể đã DEL (mơ hồ). Fail closed, đã được chấp nhận trong fold | I3 ✅ |
| `consume` trả raw khác peek | null ⇒ `invalid_grant` (code đã DEL, fail closed); unit M7 | ✅ |

**Side channel của peek.** Với request không đủ binding, `peek` trả null giống hệt `consume` cũ: cùng một `GET`, cùng một lượt so sánh, cùng `invalid_grant`. Vì vậy không phân biệt được "code không tồn tại" với "code đúng nhưng verifier sai". Chỉ request có đủ client + redirect + verifier mới đi tới bước ký chậm (Vault), mà người gửi được request đó đã nắm toàn bộ binding. Không có oracle mới.

**Refresh grant** (`refresh-token.service.ts:196-256`)

- Ký trước `rotate` từ `original`. Lỗi ký ⇒ không có ghi nào xảy ra, RT vẫn active, retry ⇒ 200, 0 reuse (R1, R2, cùng T5 trên Vault thật).
- `original` null ⇒ không ký, vẫn gọi `rotate` (chắc chắn miss vì filter của `rotate` chặt hơn: `now` muộn hơn, `revokedAt` không bao giờ bị gỡ, cùng `allowedIdentifiers`) ⇒ `classifyMiss` vẫn phát hiện reuse.
- Claim ký từ `original` có lỗi thời so với bản ghi sau `rotate` không? **Không.** `rotatedFromId.equals(original._id)` và `tokenHash` unique ⇒ cùng một doc. `userId/clientId/resource/scope/sessionRef` của RefreshToken không có đường cập nhật nào (chỉ `$set revokedAt/replacedBy/familyRevokedAt…`). `auth_time` không có trên đường refresh (giữ như cũ). Thứ duy nhất "cũ" là `iat/exp` của AT sớm hơn vài ms, tối đa vài giây (đã chấp nhận, `expires_in` hằng).
- Bất biến `rotatedFromId == original._id`: nhánh vi phạm về lý thuyết không tới được (do `tokenHash` unique và filter của `rotate` chặt hơn). Nếu có bug thì revoke family best-effort rồi 500. Hợp lý: lúc đó RT đã bị đốt, không revoke thì successor mồ côi vẫn dùng được. Ghi chú nhỏ ở 💭-2.
- Token chỉ rời server sau `recheckAfterRotate` và audit success, nên user/client bị khoá trong cửa sổ ký vẫn bị chặn như trước (pin R5).
- Race R3/R3b: bên thua bị `classifyMiss` ⇒ revoke family. Nếu reuse stamp xảy ra trước khi A re-read `familyRevokedAt` thì A cũng thua. Bên thua không có token trong body hay log. R4 (`/revoke` trong cửa sổ ký) ⇒ `invalid_grant` thường, 0 reuse.

**Exposure.** Token đã ký mà bị bỏ không đi vào `errorForLog`, audit hay metric: các lỗi ném sau khi ký đều là `TokenError`/`RefreshRotationError`/lỗi Mongo, không mang token. `KeyProviderUnavailableError` có message cố định `key provider unavailable`. `cause` là `VaultNetworkError(op, name)`/`VaultStatusError(op, status)`, không chứa addr/path/key/token (unit kiểm tra message).

**DEBT-401 phân loại** (`vault-transit-key-provider.ts:127-170, 425-436`). Mạng/timeout/body không đọc được (`VaultNetworkError`), 5xx, 429 ⇒ 503. Các lỗi sau giữ 500: 400, 403 sau khi reload token, 404, chữ ký sai định dạng, chữ ký không verify, metadata sai hình, key cấu hình sai. Có bảng unit cho cả hai chiều, cả khi cache còn hạn và hết hạn, cho cả `getPublicKeys`; mutation M5a/b/c RED. `init`/`listKeys`/`rotate` không đổi (DEBT-410). `/token` dùng `DEPENDENCY_UNAVAILABLE_DESCRIPTION`, nhánh 429 rate-limit giữ câu cũ.

**DEBT-398.** Guard `RUN --mount=type=bind` là lệnh đầu tiên của stage `build` ở cả hai Dockerfile, trước mọi `COPY`, nên không có layer nào chứa file. BuildKit đưa nội dung bind mount vào cache key, nên khi một file lạ xuất hiện thì cache bị phá và guard chạy lại. Guard chỉ khớp theo tên, không đọc nội dung. Không dùng `*/keys/*` (đã kiểm: `be/src/modules/keys`, `fe-admin/src/routes/keys` không trúng). Builder cũ không có BuildKit sẽ lỗi cú pháp `--mount`, tức vẫn fail closed. CI `.github/workflows/ci.yml:288,311-312` dùng `docker build` trên runner Docker ≥ 23 nên BuildKit là mặc định. Runbook §7/§9 ghi rõ cần BuildKit và cấm `mode=max`.

## 🟡 Nên sửa

Không có.

## 💭 Nit

- 💭-1 `be/Dockerfile:15-16`, `fe-admin/Dockerfile:13-14`: danh sách tên cấm chưa có `id_rsa*`, `*.jks`/`*.keystore`, `.git-credentials`, `.yarnrc.yml`. Guard chỉ là lớp thứ hai sau allowlist `.dockerignore`, nên đây không phải lỗ hổng. Nếu sau này thêm thì giữ nguyên nguyên tắc "khớp theo tên, không đọc nội dung".
- 💭-2 `refresh-token.service.ts:224-226`: nhánh vi phạm bất biến revoke family mà không audit. Nhánh này chỉ tới được khi có bug, và lỗi 500 đã được log, nên chấp nhận được. Nếu muốn dấu vết điều tra, cân nhắc `revokeFamily(…, { reason })` hoặc một dòng log không chứa token.
- 💭-3 Chưa có test riêng cho interleaving "code hết hạn trong lúc ký" (giữ barrier, `PEXPIRE`/`DEL` khoá, rồi thả). Nhánh code tương ứng đã được C3/C4 phủ (`consume` null), nên chỉ đáng thêm nếu tester muốn khoá riêng kịch bản TTL.
- 💭-4 Root `pnpm test` có 1 fail không bắt được tên (log dev). Nhiều khả năng đây là DEBT-400 (đã có, 🟢). Đã ghi thêm lần xuất hiện ở run 54 vào DEBT-400 thay vì mở debt mới.
- 💭-5 DEBT-411 (`/introspect` 503 thiếu `error_description`) mức 💭 là đúng.

## ✂️ Ponytail

- `be/src/modules/oauth/code/authorization-code.service.ts:L142`: shrink: `expectedRaw?: string` là tham số tuỳ chọn trong khi caller duy nhất luôn truyền nó. Nên đổi thành tham số bắt buộc và bỏ `expectedRaw !== undefined &&`, để bất biến được trình biên dịch ép thay vì phụ thuộc vào việc caller nhớ truyền.
- `be/src/modules/oauth/token/token.service.ts:L113-115`: delete: `if (!data.resource) throw invalid_target` trong `signForAuthorizationCode` không bao giờ chạy được, vì cổng ở controller đã đòi `!!p.resource`. Có thể giữ để thu hẹp kiểu, hoặc thay bằng `data.resource!` kèm comment.
- `be/src/modules/oauth/token/refresh-token.service.ts:L224`: shrink: `!accessScope` thừa, vì khi có `original` thì `accessScope` luôn là mảng. Viết `!signed || !original || …`, và `accessScope` có thể suy từ `original` ở L244/253.

net: -4 lines possible.
