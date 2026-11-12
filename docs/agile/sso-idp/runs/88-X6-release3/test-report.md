# Test Report — 2026-11-12 (run 88 T4, working tree on `6e68a1f` + T1–T3 + DEBT-627 runbook fix)

## Kết quả: PASS

E2E 44/44 ×2 (42 cũ + 2 mới), X3 42/42, lượt tay runbook-deploy §16 110/110 check, be unit 1069/1069 ×4, int FULL 2320/2320 (81 suite), fe-admin 1626/1626, typecheck/lint sạch. Checklist: C-7.5.2, C-10.7b, D-16 ⇒ ✅; A–D 202 dòng = 152 ✅ / 29 ⚠ / 2 ❌ / 19 N/A, P0 ❌ 0.

## Lệnh đã chạy + output thực tế

Hạ tầng: chỉ `veyrigate-mongo` (27017 E2E/X3; 27117 int + `vg-bootstrap-check`), `veyrigate-redis` (6379/2 E2E; 6479 int), `veyrigate-mailpit-1`. Không tạo container, không compose, không FLUSH. Cổng 4000/5173/3000 trống lúc bắt đầu (không phải kill gì).

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C e2e typecheck` (trước + sau) | exit 0 |
| 2 | `pnpm -C e2e e2e tests/account-self-service.spec.ts` | 2 passed (1.9 m; test 7.2 s + 5.1 s) |
| 3 | `pnpm -C e2e e2e` lượt 1 | **44 passed (5.7 m)**, exit 0 |
| 4 | `pnpm -C e2e e2e` lượt 2 | **44 passed (5.3 m)**, exit 0 |
| 5 | `pnpm -C e2e e2e:x3` | **42 passed (9.7 m)**, exit 0 |
| 6 | `pnpm -C be typecheck` / `pnpm -C be lint` | exit 0 / exit 0 |
| 7 | `pnpm -C be test` lượt 1, 2 (chạy riêng) | `Test Suites: 52 passed` · `Tests: 1069 passed, 1069 total` ×2 |
| 8 | `pnpm -C be test` lượt 3, 4 (chạy **song song** với int FULL, cố tái hiện flake của senior) | `Tests: 1069 passed, 1069 total` ×2 — flake không tái hiện, không có tên test fail nào để báo |
| 9 | `pnpm -C be test:int` FULL | `Test Suites: 81 passed, 81 total` · `Tests: 2320 passed, 2320 total` (15 m 29 s), exit 0 |
| 10 | `vg-*` DB trên `veyrigate-mongo` trước int / sau int | `none` / `none` (vg-int-* 0 → 0) |
| 11 | `pnpm -C fe-admin typecheck` / `pnpm -C fe-admin test` | exit 0 / `Test Files 68 passed` · `Tests 1626 passed` |
| 12 | Lượt tay §16: `node bootstrap-check.mjs` (xem mục dưới) | `failures: 0; checks: 110; parallel ok 5/5` |
| 13 | Đếm checklist + kiểm bằng chứng (script scratch) | `C {"n":108,"✅":75,"⚠":17,"❌":1,"N/A":15}` · `D {"n":16,"✅":11,"⚠":4,"❌":1,"N/A":0}` · `total {"n":202,"✅":152,"⚠":29,"❌":2,"N/A":19} P0 ❌ 0 | other ❌ C-6.3.3 (P1), D-14` · `evidence refs 299, errors 0` |

Không chạy: `test:vault` (cần container Vault mới — ràng buộc "NO new containers"; T1–T3 không đổi code Vault).

### Lượt tay runbook-deploy §16 (DB `vg-bootstrap-check`, 27117, rs0)

- **Cách chạy**: §16 viết `docker run … "$IMG" node dist/…`. Máy local không có image node base (`docker images`: chỉ mongo/redis/vault/mailpit) ⇒ build image cần tải ⇒ không build. Chạy đúng các lệnh `node dist/database/mongo/sync-indexes.js` / `node dist/database/bootstrap.js …` từ bố cục `pnpm --filter @sso-idp/be deploy --prod --offline <scratch>/deploy` (downloaded 0; `.env`, `keys` bị chép vào đã xoá ngay, không đọc; `dist` khớp `be/dist`, `diff -rq` rỗng), `--env-file` = env production placeholder (NODE_ENV=production, ISSUER https, KEY_PROVIDER vault, không `ADMIN_SEED_EMAIL`, `REDIS_URL` cổng 1). Cờ `--log-driver none` (DEBT-627) chỉ áp dụng cho `docker run` — đã kiểm có ở `runbook-deploy.md:684`.
- **Secret**: driver bắt stdout trong bộ nhớ, kiểm dòng `^OIDC_CLIENT_SECRET=[A-Za-z0-9_-]{43}$` + `verifyPassword` (argon2) với hash đang lưu, rồi chỉ ghi `OIDC_CLIENT_SECRET=<masked: 43 chars, base64url>`. Guard cuối từ chối ghi evidence nếu chứa secret/`$argon2$`; grep evidence `OIDC_CLIENT_SECRET=[A-Za-z0-9_-]{43}|\$argon2\$|eyJ` = 0.
- **Bằng chứng**: `evidence/bootstrap-check-20261112T091506Z.json` + `.log` (output đã che), harness `evidence/bootstrap-check.mjs`.

| Bước | Exit | Kết quả |
|---|---|---|
| precondition | — | `vg-bootstrap-check` chưa tồn tại; vg-int-* = 0 |
| 1a `sync-indexes --dry-run` → 1b `sync-indexes` | 0 / 0 | `target: 127.0.0.1:27117/vg-bootstrap-check` |
| 2 `bootstrap --operator ops.t88 --dry-run` | 0 | `target:` + 2 danh sách URI + `dry-run: no connection made`; DB không có client |
| 2b dry-run với `MONGO_URI` = listener đếm socket | 0 | `accepted=0` |
| 3 chạy thật | 0 | `tenant default-tenant: created` / `resource admin: created` / `client fe-admin: created` / **1** dòng secret (che) + "shown once…"; secret verify với hash active; 1 credential; resource `https://idp.example.com/admin/`; `fe-admin` `client_secret_basic`, grant `authorization_code refresh_token`, URI = env, CORS rỗng; audit `ADMIN_BOOTSTRAPPED` success `actorType system`, `actorId ops.t88`, `targetId fe-admin`, metadata `{createdTenant,createdResource,createdClient:true, credentialIssued:true, credentialRotated:false, urisUpdated:false, host}` (không secret/hash); dòng `{"alert":true,"action":"ADMIN_BOOTSTRAPPED",…}`; `usable super_admins: 0` + hướng dẫn `db:admin-recover`; `users`/`usertenants` không đổi |
| 4 chạy lại | 0 | `fe-admin secret: unchanged (active credential exists)`, không dòng secret, vẫn 1 credential, audit thứ 2 `credentialIssued:false`, secret lần 3 vẫn verify |
| 5a–5i từ chối trước kết nối: flag lạ, operator sai mẫu, thiếu `--operator`, `--update-uris`/`--rotate-secret` thiếu `--ticket`, `http://localhost` ở production, wildcard, fragment, thiếu biến `BOOTSTRAP_*` | 1 ×9 | không echo giá trị; `accepted=0` (không kết nối) ở cả 9; DB không đổi |
| 6a URI env khác | **2** | in `stored`/`env` cả 2 danh sách, "nothing written", DB không đổi |
| 6b `--update-uris --ticket CHG-88-1` | 0 | 2 danh sách thay; 1 audit `REDIRECT_URI_CHANGED`; `ADMIN_BOOTSTRAPPED` `urisUpdated:true` + ticket; không dòng secret |
| 7 `--rotate-secret --ticket CHG-88-2` | 0 | đúng 1 dòng secret mới (khác cũ); secret cũ **không** verify ngay (không grace); 1 active / 2 tổng; audit `credentialRotated:true` |
| 8a resource `admin` bị re-point / 8b `fe-admin` `none` | 1 / 1 | thông điệp refusal, DB không đổi (snapshot mọi collection) |
| 8c Mongo không tới (`MONGO_URI` có user:pass, cổng 1) | 1 | `connect ECONNREFUSED`; mật khẩu URI không bị in |
| 9.1–9.5 DB rỗng mới + 2 lượt song song (operator khác nhau) | 0/0 ×5 | mỗi lần: tổng **1** dòng secret, 1 credential/1 client/1 resource, secret in ra verify được |
| 10 DB không index (chưa `sync-indexes`) | 1 | `missing unique index clients {"clientId":1}: run db:sync-indexes first (nothing was written)`; DB không đổi |
| cleanup | — | `dropDatabase` đúng `vg-bootstrap-check`; không còn DB đó; vg-int-* = 0 |

Thời gian: mọi lượt CLI 2,6–3,6 s (8c 7,8 s: chờ kết nối thất bại). Riêng `--dry-run` khi máy rảnh: 2,6–2,85 s, toàn bộ là nạp module (`node -e 0` 0,17 s; chỉ nạp mongoose 0,82 s). Fold AC10 ghi "< 1 s", nhưng int spec chốt `< 5 s`. Thuộc tính cần chứng minh là "không kết nối", và listener đếm socket xác nhận điều đó (0 socket). Ghi nhận là lệch chữ, không chặn.

## Test FAIL (nếu có)

Không có. Lỗi phát hiện khi viết harness đều là lỗi harness, đã sửa: `mongodb` không phải dependency trực tiếp ⇒ dùng `mongoose.mongo`; guard "evidence chứa `$argon2`" khớp nhầm tên check ⇒ đổi tên + guard `$argon2$`. Dòng `[fe-admin] server function failed` trong log E2E là log của các ca âm có chủ đích (lượt 1 và 2 đều có, cả 44 test xanh).

## E2E mới — `e2e/tests/account-self-service.spec.ts`

Mỗi test tự tạo user riêng (`/register` + mail Mailpit). Không đụng user, phiên hay consent có sẵn. Callback RP được stub bằng `page.route` nên code không bao giờ được đổi lấy token. Chờ theo điều kiện, không sleep.

1. `account sessions: list with labels, CSRF, re-authentication, revoke one / others, forget devices`. Ba context A/B/C dùng UA Chrome/Windows, Firefox/Linux, Safari/macOS.
   - Ẩn danh ⇒ 302 `/login?returnTo=%2Faccount%2Fsessions`. A mở trang từ link "Your sessions" trên `/`, nhận `Cache-Control: no-store`.
   - Trang có 3 phiên với nhãn allowlist và đúng 1 "This browser", có 3 thiết bị tin cậy. HTML không chứa email, `Mozilla/5.0`, `Gecko/`, `127.0.0.1`, `::1`. Phiên còn mới nên chưa có ô mật khẩu.
   - POST thiếu `_csrf` ⇒ 403, B vẫn sống.
   - Lùi `authTime` của A 600 s: dịch số tại chỗ trong `sess:<ref>`, giữ TTL, qua RESP `node:net` vào Redis `/2` của E2E. Đây là thao tác ghi duy nhất lên datastore. Trang chuyển sang đòi mật khẩu.
   - Nhập mật khẩu sai ⇒ 400 + "The current password is incorrect.", B vẫn sống. Nhập đúng ⇒ B bị đăng xuất (request kế của B về `/login`), C vẫn sống.
   - "Forget every other device" ⇒ còn 1 thiết bị ("This browser"), C **vẫn** đăng nhập.
   - "Sign out every other session" ⇒ C về `/login`, A còn.
   - "Forget this device" ⇒ 0 thiết bị, A vẫn đăng nhập.
2. `consent screen shows origin, scope descriptions and lifetimes; revoking in /account/apps asks again`.
   - Không có `offline_access` ⇒ hiện "Each access lasts up to 2 minutes.", không có câu "days" (`ACCESS_TOKEN_TTL=120` của E2E).
   - Có `offline_access` ⇒ hiện `fe-sso-test`, "It will receive the result at http://localhost:5173.", 4 mô tả scope, "…up to 2 minutes. The app can keep access for up to 30 days…", link "Connected apps" `href=/account/apps`.
   - Allow ⇒ code; `prompt=none` ⇒ code.
   - `/account/apps` (mở từ link trên `/`) có 1 dòng gồm `fe-sso-test`, `http://localhost:4000/demo/`, `offline_access`, `consent_id` 24 hex. POST thiếu CSRF ⇒ 403.
   - Revoke ⇒ "Access was revoked." + "No app has access…". Sau đó `prompt=none` ⇒ `consent_required` (không có code), authorize thường ⇒ màn consent (nút Allow).
   - `logout.spec.ts`, `password-change.spec.ts` vẫn xanh ở cả 2 lượt (trang `/` thêm link không làm vỡ).

## Coverage acceptance criteria (T4)

- [x] E2E (a) 2+ context, A thấy các phiên, huỷ B có nhập mật khẩu ⇒ B về login — test 1
- [x] E2E (b) đồng ý app ⇒ `/account/apps` có dòng ⇒ thu hồi ⇒ authorize sau hiện consent — test 2
- [x] E2E (c) màn consent có câu thời hạn + origin — test 2
- [x] Thêm theo yêu cầu orchestrator: revoke others, forget device (có xác thực lại) — test 1
- [x] Lượt tay §16: dry-run → thật → chạy lại → song song (×5) → `--update-uris` → `--rotate-secret`, exit code + từ chối + audit — mục trên, evidence JSON
- [x] Gate: lint/typecheck, unit, int FULL, E2E ×2, X3 42, fe-admin — bảng lệnh (vault không chạy, lý do ở trên)
- [x] Checklist C-7.5.2, C-10.7b, D-16 ⇒ ✅; C-6.3.3 giữ ❌ P1, D-14 giữ ❌; đếm lại bằng script; `security-matrix.md` §Run 88

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Ở đâu |
|---|---|---|
| Identity | anonymous (302), chủ tài khoản, phiên khác cùng user (B/C) | E2E 1; IDOR user khác: int `run88-account-sessions › AC4`, `run88-account-apps` AC6 (int FULL xanh) |
| Credential | phiên mới (< 5'), phiên cũ (> 5'): thiếu/sai/đúng mật khẩu | E2E 1; 429 lần thứ 6: int AC3 |
| Authorization | không có CSRF ⇒ 403 (sessions + apps) | E2E 1, 2 |
| Request chain | sau khi huỷ, request **kế tiếp** của B/C (cookie cũ) ⇒ `/login`; sau thu hồi consent, `/authorize` kế tiếp ⇒ `consent_required` / màn consent | E2E 1, 2 |
| State | quên thiết bị không đăng xuất; huỷ phiên không xoá thiết bị khác; bootstrap chạy lại / song song ×5 ⇒ 1 secret | E2E 1; lượt tay bước 4, 9 |
| Input | bootstrap: flag lạ, operator sai, URI http/wildcard/fragment ở production, thiếu env ⇒ exit 1, không echo, 0 socket | lượt tay 5a–5i |
| Dependency | Mongo không tới ⇒ exit 1 không lộ mật khẩu URI; thiếu index ⇒ từ chối không ghi | lượt tay 8c, 10; lỗi Redis/Mongo ở trang tài khoản: int AC8 |
| Exposure | trang phiên không email/UA thô/IP; secret chỉ ở stdout một lần, không vào audit/evidence; output không `$argon2`/email/URI Mongo | E2E 1; lượt tay bước 3–7 |

Invariant T1 "tối đa 1 secret trên mọi tổ hợp lượt chạy đồng thời": lượt tay ×5 cộng int AC3 ×20, mỗi lần đúng 1. Invariant T2/T3 "chỉ huỷ/thu hồi của chính user": int AC4/AC6 cộng negative CSRF ở E2E.

## Ghi chú

- Flake unit senior thấy (1068/1069): **không tái hiện** qua 4 lượt (2 riêng, 2 song song với int FULL). Không có tên test để báo.
- Không thấy bug sản phẩm. Không sửa `src`.
- Debt mới: không. Debt đóng (tester xác nhận): DEBT-164, 165, 581, 582, 586, 627. 🟡 còn mở từ senior: DEBT-628…632.
