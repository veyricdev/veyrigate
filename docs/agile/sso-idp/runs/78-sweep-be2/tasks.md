# Run 78 — sweep 🟡 BE đợt 2 (M7, lane BE)

Nguồn: backlog — các debt BE 🟡/không nhãn còn mở. Analyst bỏ qua. Quyết định: người dùng ủy quyền orchestrator chốt theo tiêu chí production (`plan.md` §12); tech-lead chốt luôn điểm mở.

## Ứng viên (tech-lead chọn lô ≤ 6, ưu tiên rủi ro production/bảo mật, gom theo module để diff gọn)
- Auth/session: DEBT-120 (`/login` + `request_id` peek), 121 (`reauthAfter` vs `authTime` khác clock), 150 (logout `scope=all` dừng ở lỗi đầu), 192 (federation `authTime = now`), 198 (TTL `idp_fed` vs pending link).
- Admin/clients: DEBT-129 (rotate secret OK nhưng audit lỗi ⇒ mất plaintext), 134 (PATCH client trả `updatedAt` cũ), 155 (`families?after=` so chuỗi), 179 (điểm ghi admin-capable).
- Hạ tầng BE: DEBT-139 (cảnh báo Mongoose `new`), 254 (CLI in `err.message` thô), 256 (CLI không có dry-run), 168 (test nhánh `readdir` lỗi).
- Federation: DEBT-182 (provisioning không transaction), 188 (race callback 503), 193 (nhiều FI cùng provider).

## Yêu cầu chung
- Mỗi task: AC cụ thể, int/unit test RED trước fix, mutation cho nhánh bảo mật.
- Kiểm code hiện tại — debt cũ có thể đã được sửa gián tiếp (khi đó đóng với bằng chứng).

## Gate
typecheck/lint, unit be, int full (`vg-int-*` không tăng), fe-admin test, E2E 38, X3 42 — tuần tự.

---

## Fold tech-lead (2026-11-09) — lô chốt 6 task, PASS

Kiểm trên code hiện tại (develop `e3af033`). Không debt ứng viên nào đã được sửa gián tiếp; lý do chọn/loại: `review-techlead.md`.
Thứ tự (rẻ → đắt, gom module): T1 → T2 → T3 → T4 → T5 → T6. Mỗi task: viết test trước, chạy thấy ĐỎ, rồi mới sửa; mutation = hoàn nguyên fix ⇒ test tương ứng đỏ lại (ghi kết quả vào test-report).

### T1 [BE] DEBT-139 — refresh rotation dùng `returnDocument: 'before'`
- [x] backend-dev 2026-11-09: xong (RED→GREEN + mutation, xem log.md)
- **Chỗ sửa**: `be/src/modules/oauth/token/refresh-token.service.ts:457` `{ new: false }` → `{ returnDocument: 'before' }` (cùng ngữ nghĩa; Mongoose 9.10.2 cảnh báo `new` deprecated, một bản nâng cấp qua Dependabot có thể bỏ hẳn). Đây là chỗ DUY NHẤT còn `new:` trong `be/src` (sau fix `grep -rn "{ new:" be/src` = 0).
- **AC**: rotation y hệt (`old` = bản TRƯỚC update, `old.revokedAt == null`; reuse vẫn bị phát hiện); không có process warning chứa "`new` option" khi rotate.
- **Test (RED trước)**: unit trong `be/src/modules/oauth/token/refresh-token.service.spec.ts`: spy `findOneAndUpdate` của model mock ⇒ tham số 3 `toEqual({ returnDocument: 'before' })` (Mongoose chỉ cảnh báo 1 lần/process nên test bằng warning trong int không ổn định — không dùng). Các ca rotate/reuse int hiện có (`be/test/refresh-token.int-spec.ts`) phải vẫn xanh = bằng chứng ngữ nghĩa 'before'.
- **Mutation**: đổi lại `{ new: false }` ⇒ unit đỏ; đổi `'after'` ⇒ unit đỏ + ca reuse int đỏ (ghi lại).

### T2 [BE] DEBT-155 — cursor `families?after=` sai ⇒ 400 như users/consents
- [x] backend-dev 2026-11-09: xong (RED→GREEN + mutation, xem log.md)
- **Chỗ sửa**: `be/src/modules/admin/admin-users.controller.ts:366-385` (`listFamilies`): ngay sau `mustFind` (thứ tự như `listConsents` :428-431 — user khác tenant vẫn 404 trước), `if (q.after !== undefined && !FAMILY_ID.test(q.after)) throw AdminAuthError.invalidRequest('invalid cursor');` dùng hằng `FAMILY_ID` có sẵn ở :62. Không thêm regex mới.
- **AC**: `after` không khớp `^[A-Za-z0-9-]{1,128}$` ⇒ 400 `invalid_request`, mô tả cố định `invalid cursor`, không gọi `refreshTokens.listFamilies`; `after` hợp lệ phân trang như cũ; body lỗi không phản chiếu giá trị `after`.
- **Test (RED trước)** `be/test/admin-users.int-spec.ts` cạnh khối phân trang :947: (a) `after=%7B%22%24gt%22%3A%22%22%7D` (`{"$gt":""}`) ⇒ 400 (hiện 200 ⇒ RED), body không chứa `$gt`; (b) `after=a_b` ⇒ 400; (c) 129 ký tự `a` ⇒ 400; (d) user tenant khác + `after` sai ⇒ 404 (không lộ tồn tại qua 400); (e) phân trang `limit=1` hiện có vẫn xanh.
- **Mutation**: bỏ dòng kiểm ⇒ (a)(b)(c) đỏ; đặt kiểm TRƯỚC `mustFind` ⇒ (d) đỏ.

### T3 [BE] DEBT-150 — logout `scope=all` chạy đủ 3 bước qua `revokeAllUserCredentials`
- [x] backend-dev 2026-11-09: xong (RED→GREEN + mutation, xem log.md)
- **Chỗ sửa**: `be/src/modules/ui/ui.controller.ts:353-375` — nhánh `global` thay 3 lời gọi tự viết (revoke family → `sessions.revokeAllForUser` → sweep) bằng `this.auth.revokeAllUserCredentials(session.userId, now)` (`be/src/modules/authentication/authentication.service.ts:245`; `this.auth` đã inject ở ui.controller :80) ⇒ `tokenCount`/`sessionCount` lấy từ kết quả. Nhánh `scope=session` GIỮ NGUYÊN. Không truyền `onFailure` (failure-audit logout = DEBT-521, ngoài run). Audit SESSION_REVOKED/TOKEN_REVOKED, clear cookie, front-channel giữ nguyên thứ tự + metadata (`{scope:'all', count}`); `rpCandidates` vẫn thu TRƯỚC revoke.
- **Security design**: tài sản = mọi session Redis + refresh family của user; actor = chính user (CsrfGuard giữ). Invariant: 302 thành công ⇒ 0 session sống + 0 family sống của user. Một bước lỗi ⇒ các bước còn lại VẪN chạy rồi ném lỗi đầu ⇒ 5xx (`HtmlExceptionFilter`): KHÔNG audit success, KHÔNG clear cookie, KHÔNG redirect (fail-closed, không báo đăng xuất giả); retry idempotent. Race `/token` giữa bước 1 và session MARK vẫn bị sweep bắt (DEBT-051).
- **AC**: (1) happy path y hệt test hiện có `be/test/ui.int-spec.ts:1011`; (2) Mongo lỗi ở lần revoke family đầu ⇒ 5xx nhưng MỌI session của user (gồm session ở trình duyệt thứ 2) đã revoke + tombstone, không có audit `SESSION_REVOKED` success mới, không Set-Cookie xoá session; (3) Redis lỗi ở revoke session ⇒ 5xx nhưng family đã revoke (bước 1 + sweep chạy).
- **Test (RED trước)** cạnh `ui.int-spec.ts:1011`: user có 2 session + 1 family; `jest.spyOn(app.get(RefreshTokenService), 'revokeAllForUser').mockRejectedValueOnce(new Error('boom'))` ⇒ POST `/logout?scope=all` (CSRF hợp lệ) ⇒ `statusCode >= 500`; session 2 không còn sống; family revoke (do sweep); không audit success mới. Code hiện tại: bước 1 ném ⇒ session 2 còn sống ⇒ RED. Ca (3): spy `SessionService.revokeAllForUser` reject ⇒ 5xx + family đã revoke. `mockRestore` trong `finally`.
- **Mutation**: khôi phục 3 lời gọi cũ ⇒ ca (2) đỏ; bỏ bước `sweep` trong `revokeAllUserCredentials` ⇒ unit `authentication.service.spec.ts` hiện có đỏ (ghi lại).

### T4 [BE] DEBT-198 — `link_required` gia hạn cookie `idp_fed` theo TTL pending link
- [x] backend-dev 2026-11-09: xong (RED→GREEN + mutation, xem log.md)
- **Chỗ sửa**: `be/src/modules/federation/federation.controller.ts`: trích options cookie binding ở `start` (:113-119) thành `private bindingCookieOptions(maxAgeMs: number)` (httpOnly, `secure: this.secure`, sameSite lax, path `/`, `maxAge = maxAgeMs / 1000`), dùng ở `start` (FED_STATE_TTL_MS) và nhánh `link_required` của `callback` (:157-160): set lại `this.bindingCookie` với CHÍNH giá trị `req.cookies[this.bindingCookie]`, options `bindingCookieOptions(FED_LINK_TTL_MS)`, trước redirect `/auth/link`. Không sinh giá trị mới; phòng thủ: chỉ set khi giá trị khác rỗng.
- **Security design**: boundary trình duyệt ↔ IdP (binding chống login-CSRF). Invariant: chỉ gia hạn, cùng giá trị, chỉ ở nhánh `link_required` (binding đã được service so constant-time với state); `signed_in`/`denied`/lỗi KHÔNG set lại binding. Abuse: không cấy được binding (giá trị là cookie đã khớp state); pending link vẫn single-use + so binding ở POST `/auth/link`. Exposure: giá trị không vào log/URL/audit/view.
- **AC**: 302 `/auth/link` có Set-Cookie cho tên binding (tôn trọng `__Host-` khi secure, run 73) = đúng giá trị request, `Max-Age=600` (= `FED_LINK_TTL_MS/1000`), `HttpOnly`, `SameSite=Lax`, `Path=/`; nhánh signed_in không có Set-Cookie binding.
- **Test (RED trước)** `be/test/federation.int-spec.ts` mở rộng ca :1009: parse `set-cookie` của callback ⇒ có binding = giá trị đã gửi + Max-Age theo hằng import (hiện không có ⇒ RED). Ca signed_in hiện có: assert không có binding trong `set-cookie`.
- **Mutation**: xoá setCookie ⇒ đỏ; set `generateToken()` thay giá trị ⇒ đỏ. (STATE/LINK TTL cùng 600s nên mutation đổi hằng không phân biệt — ghi chú, chấp nhận.)

### T5 [BE] DEBT-254 — lỗi CLI DB không in credential; `seed-dev` in `target:`
- [x] backend-dev 2026-11-09: xong (RED→GREEN + mutation, xem log.md)
- **Chỗ sửa**: thêm `export function cliErrorText(err: unknown, uri?: string): string` vào `be/src/database/mongo/sync-indexes.ts` cạnh `mongoTarget` (seed/seed-dev đã import từ file này): non-Error ⇒ `non-Error thrown`; Error ⇒ `err.message` với mọi xuất hiện literal của `uri` (khác rỗng) thay bằng `[MONGO_URI]`, rồi qua `scrubUriCredentials` (`be/src/common/logger/error-log.ts:25`). Dùng ở 3 catch: `sync-indexes.ts:110`, `seed.ts:295`, `seed-dev.ts:296` (truyền `process.env.MONGO_URI`). `seed-dev.ts` main (:268-280): in `mongoTarget(env.MONGO_URI)` sau `readDevSeedUserConfig`, TRƯỚC `createConnection` (như `seed.ts:268`).
- **Security design**: tài sản = mật khẩu trong `MONGO_URI`; kênh lộ = stderr CLI (CI log, terminal). Driver có thể lặp lại URI trong lỗi; mật khẩu chứa ký tự không encode (`/ ? #`) làm hỏng regex `scrubUriCredentials` ⇒ thay literal URI trước là lớp chính. Exit code giữ 1.
- **AC**: message `bad mongodb://u:s3cret@h:1/db` ⇒ không chứa `s3cret`; `uri = mongodb://u:p/ss?x#@h/db` nằm nguyên trong message ⇒ không chứa `p/ss`; non-Error ⇒ chuỗi cố định; message không có URI giữ nguyên. `grep -rn "err.message" be/src/database` = 0.
- **Test (RED trước)**: `be/src/database/mongo/sync-indexes.spec.ts` thêm `describe('cliErrorText (DEBT-254)')` 4 ca trên. Target seed-dev: kiểm thủ công bằng built CLI với `MONGO_URI=mongodb://127.0.0.1:1/x` (KHÔNG trỏ DB dev `sso-idp`), thấy `target: 127.0.0.1:1/x` trước lỗi kết nối; ghi output vào test-report.
- **Mutation**: bỏ bước thay literal URI ⇒ ca `p/ss` đỏ; bỏ `scrubUriCredentials` ⇒ ca `s3cret` đỏ.

### T6 [BE] DEBT-256 (+ đóng DEBT-257) — cờ `--dry-run` cho `db:seed` / `db:sync-indexes` / `db:seed-dev`
- [x] backend-dev 2026-11-09: xong (RED→GREEN + mutation, xem log.md)
- **Chỗ sửa**: `export function isDryRun(argv: readonly string[]): boolean` (= `argv.includes('--dry-run')`) cạnh `mongoTarget`. Ở 3 `main`: sau validate env + đọc config seed (fail-fast như cũ) và in `target:` ⇒ nếu dry-run: in `dry-run: no connection made` rồi `return` (exit 0) TRƯỚC `createConnection`. Không thêm `--confirm-target` (YAGNI). `assertNotProduction` vẫn chạy đầu như cũ. Cờ khác: giữ hành vi hiện tại.
- **Docs**: `docs/agile/sso-idp/runbook-ops.md` §0 (:23-26): thay lệnh `node -e ... mongoTarget(...)` bằng quy trình gõ biến 1 lần trong subshell: `export MONGO_URI=...` ⇒ `pnpm --filter be db:sync-indexes -- --dry-run` ⇒ xác nhận đích ⇒ chạy lệnh thật cùng shell (đóng DEBT-257); sửa các tham chiếu "Kiểm khô đích (§0)" (:264). Kiểm thực tế `pnpm --filter be <script> -- --dry-run` có đưa cờ vào `process.argv` không; ghi output vào test-report (nếu pnpm nuốt `--`, ghi lệnh đúng vào runbook).
- **Security design**: tài sản = DB đích (sync-indexes có thể DROP index/đổi TTL audit; seed ghi user/secret). Invariant: `--dry-run` ⇒ 0 kết nối, 0 ghi, exit 0; không cờ ⇒ hành vi cũ y hệt. Env sai ⇒ vẫn exit 1 trước khi in. Exposure: chỉ in `mongoTarget` (allowlist), không in URI.
- **AC**: `isDryRun(['node','x','--dry-run'])` true; `[]` và `['--dry-run=1']` false; built CLI `sync-indexes.js --dry-run` với `MONGO_URI=mongodb://127.0.0.1:1/x` ⇒ exit 0 trong < 3s (không chờ `serverSelectionTimeoutMS` 5s), stdout có `target: 127.0.0.1:1/x` + dòng dry-run; không cờ ⇒ exit 1 (cũ).
- **Test (RED trước)**: unit `isDryRun` trong `sync-indexes.spec.ts`; ca CLI trong `be/test/seed.int-spec.ts` (hoặc spec mới trong `be/test`): `execFile(process.execPath, ['dist/database/mongo/sync-indexes.js', '--dry-run'], { env: { ...process.env, MONGO_URI: 'mongodb://127.0.0.1:1/x' } })` ⇒ exit 0, < 3s, stdout đúng. Nếu `dist/` thiếu ⇒ test FAIL với thông báo "chạy pnpm -C be build" (không skip âm thầm). RED hiện tại: cờ bị bỏ qua ⇒ chờ 5s rồi exit 1.
- **Mutation**: bỏ `return` dry-run ⇒ ca CLI đỏ; đặt kiểm dry-run SAU `createConnection` ⇒ đỏ.

### Ngoài lô (giữ backlog) — lý do ở `review-techlead.md`
DEBT-120, 121, 129, 134, 168, 179, 182, 188, 192, 193. Debt mới: DEBT-521 (failure-audit cho logout global).

### Gate (tuần tự)
`pnpm -C be typecheck` + lint, `pnpm -C be build` (T6), unit be, int full (`vg-int-*` không tăng), fe-admin test, E2E 38, X3 42. Không chạy CLI vào DB dev `sso-idp`.
