# Run 85 — X6 release checklist đợt 2 (M8, lane BE + UI + ops/docs)

Nguồn: `release-checklist.md` (run 84) — 7 P0 ❌ — + D84.4 (DEBT-393) + DEBT-553/557. Analyst bỏ qua. Người dùng ủy quyền chốt theo tiêu chí production (`plan.md` §12). Có thể chia 2 run nếu lô vượt ≤ 6 task — tech-lead quyết, P0 trước.

## Ứng viên
- **P0 OIDC**: DEBT-571 (`/authorize` có `request`/`request_uri` ⇒ lỗi `request_not_supported`/`request_uri_not_supported`, OIDC Core §6.1/§6.2), DEBT-584 (`POST /userinfo`, OIDC Core §5.3.1).
- **P0 ASVS L1 (auth)**: DEBT-573 (đổi mật khẩu: mật khẩu hiện tại + mới, CSRF, rate limit, revoke phiên/family khác, audit), DEBT-574 (danh sách mật khẩu phổ biến nhúng trong repo, không gọi mạng), DEBT-575 (chống khoá tài khoản có chủ đích — chọn cơ chế + tài liệu; liên quan DEBT-016), DEBT-577 (token một lần trên query string — tech-lead quyết: sửa (POST/fragment) hoặc chấp nhận ⚠ có lý do).
- **P0 ops**: DEBT-576 (chính sách thời hạn vá lỗ hổng theo mức + SBOM — cách sinh SBOM không thêm dependency/tải gói lạ).
- **D84.4 / DEBT-393**: pre-publish key mới (`pending` + `activatesAt`, `KEY_PREPUBLISH_SEC` mặc định 3600) — đổi hợp đồng admin/fe-admin.
- **Supply chain**: DEBT-553/557 — pin mọi GitHub Action theo commit SHA (peeled commit), cân nhắc `codeql-action@v4`. Push 2026-11-11 Dependabot báo **9** cảnh báo (4 high, 4 moderate, 1 low) trên `develop` — tăng từ 6; máy không có `gh`, trang Security cần người dùng đăng nhập ⇒ tech-lead suy luận nguồn (action trôi tag? `pnpm audit` hiện 0) và ghi cho người dùng.
- P1 kèm nếu rẻ: DEBT-572 (RP-Initiated Logout POST không `_csrf`).

## Yêu cầu chung
- Test RED trước fix; mutation cho nhánh bảo mật/fail-closed. Cập nhật `release-checklist.md` (dòng tương ứng ❌ ⇒ ✅/⚠ kèm bằng chứng `grep -F`).
- Thay đổi UI (fe-sso-test? trang IdP server-render) ⇒ E2E; chạm login/cookie ⇒ X3 42.
- Không chạy CLI ghi vào DB dev `sso-idp`; không `npx` gói chưa cài; thêm dependency mới phải có lý do + qua 14 ngày.

## Gate
typecheck/lint, be unit, int FULL (`vg-int-*` không tăng), fe-admin test (nếu chạm), E2E 38+, X3 42 (nếu chạm) — tuần tự.

## Fold tech-lead (2026-11-11)

Kết luận: **PASS** (lý do: `review-techlead.md`). Đã kiểm trên `develop` HEAD `78724b7` (codegraph + đọc file). Ứng viên có 10 mục, cộng 1 P0 mới phát hiện (mongoose, xem T1) ⇒ chia **run 85** (6 task, toàn P0) và **run 86** (X6 đợt 2b). Kế hoạch X6 dời một run: đợt 3 (diễn tập, DEBT-252/253) = run 87, đợt 4 (pentest + ký duyệt) = run 88.

### Phát hiện khi kiểm code

- **P0 mới, chưa có trong ứng viên**: `be/package.json:43` `mongoose` `9.10.2`; 4 GHSA công bố **2026-11-10** (GHSA-gg4r-jv3p-qx3c high 7.5, GHSA-8332-j7wj-wjw4 high 8.2, GHSA-wr5m-5jph-8m96 moderate, GHSA-6972-9mcm-vhwj moderate; bản vá `9.11.4` phát hành 2026-10-23 ⇒ đã qua 14 ngày). `pnpm audit` chạy lại hôm nay: **high 2, moderate 2, low 1** (câu "pnpm audit 0" trong STATUS đã cũ) ⇒ bước CI `pnpm audit --audit-level high` của push run 84 gần như chắc đỏ. Đây là nguồn chính của 9 cảnh báo Dependabot (mục "Dependabot" dưới).
- DEBT-571 đúng: `authorize.service.ts:84-97` `AUTHORIZE_PARAM_KEYS` không có `request`/`request_uri`, tham số lạ bị bỏ qua. Thêm: discovery (`discovery.controller.ts:57-102`) **không khai** `request_uri_parameter_supported`, mà OIDC Discovery §3 mặc định giá trị này là `true` khi vắng ⇒ IdP đang quảng cáo sai. Sửa cùng T2.
- DEBT-584 đúng: `userinfo.controller.ts:82` chỉ có `@Get`. Preflight đã cho `GET, POST` (`client-cors.helper.ts:34`), `/userinfo` có trong `CORS_PREFLIGHT_PATHS` ⇒ không cần đổi CORS.
- DEBT-575 đúng và rộng hơn mô tả: ngoài khoá tạm 15' (`user.service.ts:199-265`, gọi ở `authentication.service.ts:131`), limiter chung `ui.controller.ts:509-516` có chiều `account` (RATE_LIMIT_MAX/RATE_LIMIT_WINDOW, mặc định 100/60 s) ⇒ kẻ tấn công giữ chiều này bão hoà là chặn được nạn nhân vô thời hạn. Reset đã gỡ khoá tạm (`setPassword` `:295-318`). Bộ reserve/refund Lua có sẵn (`rate-limit.service.ts:62-98`, `reserve()`/`refund()`) ⇒ dùng lại, không thêm Lua.
- DEBT-573 đúng: không có route đổi mật khẩu; `revokeAllUserCredentials` (`authentication.service.ts:236-266`) dùng lại được nguyên vẹn.
- DEBT-574 đúng: chỉ kiểm độ dài (`authentication.service.ts:313-316`, gọi ở register `:71` và reset `:202`). Nest assets hiện chỉ có `views/**/*`, `public/**/*` (`be/nest-cli.json`).
- DEBT-577: `issueToken` (`authentication.service.ts:289-290`) dùng `searchParams.set('token')`. Logger đã cắt query (`logger.module.ts:53`), có `Referrer-Policy: no-referrer`, GET chỉ render form; đã có tiền lệ script ngoài `/assets/logout-redirect.js` (CSP `script-src 'self'`) ⇒ chuyển sang fragment rẻ. Chưa phát hành production ⇒ không cần tương thích link cũ. E2E không dùng link email (chỉ int dùng).
- DEBT-576: `pnpm sbom` **có sẵn trong pnpm 12.6.0** (`pnpm help sbom`: `--sbom-format cyclonedx|spdx`, `--prod`, `--lockfile-only`, `--out`). Thử ra scratchpad: `pnpm --filter @sso-idp/be sbom --sbom-format cyclonedx --sbom-type application --prod --lockfile-only` ⇒ CycloneDX 1.7, 177 component (có `@nestjs/core`, `mongoose`, không có `react`); fe-admin 233 component. Không cần dependency mới.
- DEBT-393: `KeyMetadata.status: 'active' | 'retiring'` (`key-provider.ts:19`); Local `rotateExclusive` (`local-key-provider.ts:153-`) và Vault `signWith` (`vault-transit-key-provider.ts:232-237`, ký bằng `set.latest`) đều ký ngay bằng key mới; Vault `live()` (`:271-282`) tính `retireAt = next.createdAt + ttl + KEY_CACHE_TTL_MS`. fe-admin: `schemas.ts:185` `z.enum(["active","retiring"])`, `routes/keys/index.tsx:22`, `routes/index.tsx:144`.
- DEBT-553/557: 18 dòng `uses:` trong `ci.yml` + `codeql.yml` (`checkout@v4` ×8, `setup-node@v4` ×4, `cache@v4` ×3, `upload-artifact@v4` ×1, `codeql-action/{init,analyze}@v3.39.3`). SHA đọc hôm nay bằng `git ls-remote` + API releases (công khai, không cần đăng nhập) — bảng ở T1.

### Quyết định (D85.x, người dùng ủy quyền, tiêu chí production) — orchestrator chép vào `plan.md` §12 khi đóng run

- **D85.1 Chia lô**: run 85 = T1–T6 dưới (P0: mongoose + supply chain, 571/584, 574, 575, 573; T6 QA). Run 86 (X6 đợt 2b) = DEBT-577 (P0, fragment), DEBT-393 [BE] + [FE] (D85.7), DEBT-572 (P1), DEBT-583 (P2), gate. Lý do: 577 và 393 không phụ thuộc lô này, 393 cần lane FE; gộp vào thì lô vượt 6 task. Run 87 = đợt 3 (diễn tập), run 88 = đợt 4 (pentest + ký). Phát hành vẫn bị chặn tới khi 577 xong (run 86), đúng định nghĩa P0.
- **D85.2 Chống khoá có chủ đích (DEBT-575, đóng DEBT-016)**: chọn **throttle theo (tài khoản, mạng) + device cookie tin cậy** (mẫu "device cookies" của OWASP), **bỏ khoá cứng theo tài khoản**; không CAPTCHA, không gọi ngoài.
  - Loại *progressive delay*: giữ kết nối mở (khuếch đại DoS lên IdP), và nếu khoá theo tài khoản thì vẫn làm chậm chính nạn nhân.
  - Loại *chỉ (account, IP)*: botnet N mạng được 5N lần đoán mỗi 15' vào một tài khoản ⇒ cần trần theo tài khoản; trần đó chỉ không khoá nạn nhân khi nạn nhân có đường tin cậy (device cookie).
  - Hằng số (không thêm env, ghi trong tài liệu): mạng = IPv4 /32, IPv6 /64 (IPv4-mapped ⇒ IPv4); cửa sổ 900 s; **N = 5** lần thử/(email, mạng) cho thiết bị chưa tin cậy; **A = 20** lần thử/email cộng mọi thiết bị chưa tin cậy; **D = 10** lần thử/(email, device cookie) cho thiết bị tin cậy, không chịu N và A. Hợp đồng ở T4.
- **D85.3 DEBT-577: SỬA (không chấp nhận ⚠), ở run 86**, bằng token trong **fragment**: link `…/reset#token=…`, `…/verify-email#token=…`; trang đọc fragment bằng script ngoài `/assets/token-fragment.js`, điền ô ẩn, `history.replaceState` xoá fragment; POST mang token trong body như hiện tại.
  - Không chọn "POST-only": link email bắt buộc là điều hướng GET, nên token vẫn phải nằm trong URL, hoặc người dùng tự gõ mã.
  - Lý do theo ASVS 5.0 14.2.1 (URL và query string không được chứa thông tin nhạy cảm): token reset tương đương mật khẩu trong 30' (chiếm được tài khoản). Query rơi vào access log của reverse proxy/CDN/WAF và vào lịch sử/đồng bộ trình duyệt, nằm ngoài tầm kiểm soát của IdP. Các giảm thiểu hiện có (một lần, TTL, `no-referrer`, logger cắt query) đều dựa vào người vận hành. Fragment không bao giờ gửi lên server hay vào Referer. Chi phí thấp (1 script, 2 template, link builder), và chưa phát hành nên không cần giữ `?token=`.
  - Không có JS: ô "Mã trong email" hiện ra (`<noscript>`), thư in mã dưới link.
- **D85.4 DEBT-574 nguồn danh sách**: SecLists (giấy phép **MIT**, theo `api.github.com/repos/danielmiessler/SecLists/license`) commit `64b41f2156e1ae3edb592535c1b4b4dd0d6fe26a`, file `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` (835 538 byte, git blob `38eb37702244f55fda75cab281eb2145cd7685b6`; gốc là danh sách NCSC UK lấy từ HIBP Pwned Passwords, ghi công CC BY 4.0 trong NOTICE).
  - Dẫn xuất: NFKC + lowercase, giữ dòng dài 8–128 (khớp chính sách), bỏ trùng giữ thứ hạng đầu, lấy **10 000** dòng đầu (ASVS 6.2.4 cần ≥ 3000, dư 3 lần; khoảng 100 KB).
  - Nhúng tại `be/src/modules/authentication/password-policy/common-passwords.txt`, đưa vào build qua assets của `nest-cli.json`; nạp một lần lúc khởi động; thiếu, hỏng hoặc < 3000 dòng ⇒ **không khởi động** (fail-closed). File thô không commit.
  - Kèm từ ngữ cảnh (6.2.11): `veyrigate`, `sso-idp`, `ssoidp`, phần local của email (≥ 4 ký tự) và cả email.
  - 6.2.12 (kiểm "đã lộ" qua dịch vụ) **không làm** vì cấm gọi ngoài ⇒ ⚠ có lý do, DEBT-587.
- **D85.5 DEBT-576**:
  - SBOM = `pnpm sbom` sẵn có (CycloneDX 1.7, `--prod --lockfile-only`, mỗi gói deploy một file); job CI `sbom` upload artifact giữ 90 ngày; không thêm dependency.
  - Thêm workflow `audit.yml` chạy `pnpm audit --audit-level high` **hằng ngày**. Lý do: advisory mongoose ra giữa hai lần push, chỉ lộ ra ở push sau.
  - Chính sách thời hạn khắc phục, ghi tại `runbook-deploy.md` §14, tính từ lần phát hiện đầu tiên (CI, audit định kỳ hoặc Dependabot):

    | Mức | Chạy ở production (dependency prod của be/fe-admin, base image, image compose prod) | Chỉ dev/CI |
    |---|---|---|
    | Critical | ≤ 72 h | ≤ 7 ngày |
    | High | ≤ 7 ngày | ≤ 30 ngày |
    | Moderate | ≤ 30 ngày | ≤ 90 ngày |
    | Low | ≤ 180 ngày hoặc lô dependency kế tiếp | như cột trái |

  - Không có bản vá ⇒ ghi ngoại lệ vào `auditConfig.ignoreGhsas` (lý do, khả năng chạm tới, hạn xem lại ≤ 90 ngày) và dismiss cảnh báo Dependabot cùng lý do. Bản vá bảo mật bỏ qua cooldown 14 ngày (quy tắc hiện hành), có ghi ngoại lệ. Cập nhật thường: Dependabot hằng tuần, merge trong ≤ 30 ngày sau cooldown; nâng major theo kế hoạch.
- **D85.6 DEBT-573 đổi mật khẩu**: `GET/POST /account/password`, có CSRF (identity = cookie phiên), cần phiên sống, cần mật khẩu hiện tại + mật khẩu mới. Limiter chung + bucket lỗi riêng 5/900 s theo user (reserve trước Argon2), chính sách D85.4. Ghi bằng compare-and-set trên hash cũ, rồi gọi `revokeAllUserCredentials` (huỷ **mọi** phiên kể cả phiên hiện tại, mọi refresh family, mọi device cookie tin cậy) ⇒ người dùng đăng nhập lại bằng mật khẩu mới.
  - Chọn đăng xuất cả phiên hiện tại vì dùng lại đúng đường reset đã được kiểm (INV-11/28, DEBT-050/055): không thêm logic "trừ phiên hiện tại", không có race khoá admin giữa lúc revoke và lúc tạo phiên mới. Giá phải trả: 1 lần đăng nhập lại.
  - Gửi thư thông báo (không có link token) khi đổi **và** khi reset. Audit `AUTH_PASSWORD_CHANGED`.
- **D85.7 DEBT-393 pre-publish (run 86)** — chốt hợp đồng D84.4:
  - Trạng thái suy ra theo thời gian, không có tiến trình nền ghi state. `activatesAt(v) = createdAt(v) + KEY_PREPUBLISH_SEC` với mọi version tạo bởi rotate `normal`. Version "sàn" (Vault `floor`; ở Local là phần tử duy nhất sau emergency hoặc init) có `activatesAt = createdAt`.
  - **active** = version mới nhất có `activatesAt ≤ now`, nếu không có thì là version sàn. Version mới hơn active là **pending** (có trong JWKS, không ký). Version cũ hơn active là **retiring** tới `activatesAt(version kế tiếp) + ACCESS_TOKEN_TTL` (+ `KEY_CACHE_TTL_MS` ở Vault như hiện tại), sau đó rời JWKS.
  - `KEY_PREPUBLISH_SEC`: env mới, số nguyên 0–86400, mặc định **3600**; 0 = hành vi hiện tại. Runbook ghi: giá trị phải ≥ thời gian cache JWKS dài nhất của RP (runbook-ops §1 yêu cầu RP ≤ 10').
  - Rotate `normal` khi đang có version pending ⇒ **409** `{"error":"rotation_pending"}`, không rotate, audit `SIGNING_KEY_ROTATED` failure `reason:'rotation_pending'`. Emergency luôn được phép: key mới active ngay, gỡ mọi version cũ **kể cả pending** (Vault: `min_decryption_version = n` như hiện tại; Local: `next = [fresh]`).
  - Vault: ký qua `transit/sign/<key>` với tham số `key_version` = version active, suy ra từ `creation_time` (không thêm state). Local: mỗi phần tử `keys.json` thêm `activatesAt` (ISO); phần tử cũ không có trường này ⇒ coi `activatesAt = createdAt`. Chỉ `init`/`rotate` ghi file (DEBT-145); trạng thái đọc ra là giá trị suy ra.
  - Admin API: item của `GET /admin/keys` là `{kid, alg, status: 'pending'|'active'|'retiring', createdAt, activatesAt, retireAt}` (thêm `activatesAt`, ISO); `POST /admin/keys/rotate` trả thêm `activatesAt` của `newKid`; sinh lại OpenAPI và `fe-admin/src/server/admin-api/schema.d.ts`.
  - fe-admin: zod `status` thêm `pending`, `activatesAt` bắt buộc; nhãn `pending: "Pending — published, signs from <thời điểm>"`; thứ tự active → pending → retiring; dashboard đếm pending riêng; hộp xác nhận rotate normal nói rõ key mới bắt đầu ký sau `KEY_PREPUBLISH_SEC`; 409 `rotation_pending` ⇒ thông điệp cố định, không retry; mutation có kết quả không chắc chắn giữ mẫu `UNCERTAIN_*` hiện có.
- **D85.8 DEBT-553/557**: pin **mọi** `uses:` theo commit đã peel, kèm comment `# vX.Y.Z`. Nâng lên major mới nhất có bản phát hành ≥ 14 ngày, vì v4 của `checkout`/`setup-node`/`cache`/`upload-artifact` chạy Node 20, đã hết hạn.
  - Đã đọc release note v5–v7. Thay đổi phá vỡ chỉ gồm: Node 24 + runner ≥ 2.327.1 (runner GitHub-hosted đáp ứng); setup-node v6 chỉ tự cache cho npm (ta dùng pnpm + cache tay); checkout v7 chặn checkout fork PR cho `pull_request_target`/`workflow_run` (ta không dùng hai trigger này).
  - **codeql-action lên v4** (v3 ngừng hỗ trợ 12/2026, DEBT-231): `v4.39.3` cùng đợt phát hành với `v3.39.3` đang dùng (run 83 đã nhận ngoại lệ 14 ngày cho đợt này) ⇒ không phải mã mới.
  - Image Docker trong workflow (`redis:7`, `mongo:7`, `mailpit`) chỉ dùng cho test ⇒ pin digest để sau (DEBT-590).
- **D85.9 DEBT-571/584**: có `request` hoặc `request_uri` (kể cả rỗng hay lặp) ⇒ redirect lỗi sau khi redirect_uri đã được tin; discovery khai `request_parameter_supported: false`, `request_uri_parameter_supported: false`. `POST /userinfo` dùng chung handler với GET; token **chỉ** lấy từ header `Authorization: Bearer` (form body theo RFC 6750 §2.2 là tuỳ chọn; giữ bất biến "không bao giờ lấy từ query/body"); body bị bỏ qua.
- **D85.10 Chốt P-level**: DEBT-572 P1 ⇒ run 86; DEBT-583 P2 ⇒ run 86 (rẻ); C-6.2c: 6.2.11 ✅ sau T3, 6.2.12 ⚠ (D85.4). Các dòng P1/P2 khác ở phần E giữ phân loại của tester (run 84).
- **D85.11 Xoay device token (sửa D85.2)** — amends D85.2, decided by orchestrator under the user's production-readiness delegation; senior finding 1 (DEBT-596): mỗi lần đăng nhập mật khẩu thành công luôn cấp token thiết bị **mới** bằng `generateToken()`, không bao giờ dùng lại giá trị cookie gửi lên (chống cookie fixation ở chế độ không `__Host-`, và cookie từng lộ không được tin cậy lại sau reset); có cookie gửi lên thì `ZREM` hash cũ trong cùng `MULTI` với `ZADD`. Kèm DEBT-597: có cookie đúng dạng thì luôn `ZSCORE` (khoá `userId` hoặc `absent:` + sha256(email) cho email không tồn tại).

### Dependabot (9 cảnh báo: 4 high, 4 moderate, 1 low) — suy luận, cần người dùng xác nhận

Không đọc được trang Security (cần đăng nhập). Dữ kiện:
- Repo chỉ có manifest npm (5 file `package.json`, `pnpm-lock.yaml`), không có manifest Python hay loại khác.
- Dependabot không có cảnh báo cho ecosystem docker (chính `dependabot.yml` ghi vậy) ⇒ Dockerfile và `ops/compose` không phải nguồn.
- Action trong workflow không trúng advisory nào đã biết (v4 của checkout/setup-node/cache/upload-artifact; codeql `v3.39.3` cao hơn mọi khoảng lỗi đã biết).
- Truy vấn API advisory của npm (`/-/npm/v1/security/advisories/bulk`) với các phiên bản khai trong manifest, và `pnpm audit`, cho cùng một kết quả: chỉ mongoose (4) + deepmerge (1, đã ignore cục bộ).

Giả thuyết khớp đúng 4/4/1: mỗi GHSA của mongoose xuất hiện ở **2 manifest** (`be/package.json` khai cứng `9.10.2`, và `pnpm-lock.yaml`); deepmerge chỉ có trong lockfile.

| # | Gói | GHSA | Mức | Manifest dự đoán | Xử lý |
|---|---|---|---|---|---|
| 1–2 | mongoose 9.10.2 | GHSA-gg4r-jv3p-qx3c | high | be/package.json, pnpm-lock.yaml | T1 (⇒ 9.11.4) |
| 3–4 | mongoose 9.10.2 | GHSA-8332-j7wj-wjw4 | high | như trên | T1 |
| 5–6 | mongoose 9.10.2 | GHSA-wr5m-5jph-8m96 | moderate | như trên | T1 |
| 7–8 | mongoose 9.10.2 | GHSA-6972-9mcm-vhwj | moderate | như trên | T1 |
| 9 | deepmerge 4.3.1 (dev, qua jest-config) | GHSA-gcqx-w48m-w2h4 | low | pnpm-lock.yaml | Không có bản vá; người dùng dismiss "Risk is tolerable" kèm lý do của `auditConfig` (hạn xem lại 2027-02-10, DEBT-552) |

Người dùng cần kiểm (ghi kết quả vào `log.md` run 85):
1. Cột Manifest của 9 cảnh báo. Nếu có `pnpm-lock.yaml` thì giả định của DEBT-500 ("Dependabot npm mù") sai ⇒ DEBT-585.
2. Có cảnh báo nào ngoài bảng trên (github-actions, gói khác) không. Có ⇒ báo lại, tech-lead xếp vào run 86.
3. Tab Actions: run CI của `6570f3a` có đỏ ở bước "Dependency audit" không (dự đoán: đỏ).
4. Sau khi push T1, cảnh báo 1–8 tự đóng.
5. Sau khi push T1, workflow `CodeQL` chạy xanh trên v4.

### Task run 85 (thứ tự: T1 → T2 → T3 → T4 → T5 do backend-dev; senior-reviewer; T6 do tester)

Một backend-dev làm tuần tự, vì T3–T5 cùng sửa `authentication.service.ts`/`ui.controller.ts`. T2 sửa file riêng: orchestrator **được** chạy T2 song song bằng một backend-dev thứ hai trong worktree riêng, nhưng int FULL vẫn chạy tuần tự sau khi gộp. UI của T4/T5 là template Eta do BE render ⇒ thuộc lane BE.

- [x] **T1 [BE/ops] Supply chain: mongoose (P0) + pin action + SBOM + chính sách (DEBT-576, 553, 557) — làm đầu tiên**
  - (a) `be/package.json` đổi thành `"mongoose": "9.11.4"` (giữ khai chính xác); `pnpm i` cập nhật lockfile. Mọi gói mới hoặc đổi phiên bản trong lockfile phải có bản phát hành ≥ 14 ngày (`pnpm view <pkg> time`); dự kiến `mongodb` 7.7.0 (2026-09-28). Gói nào < 14 ngày ⇒ ghi ngoại lệ bảo mật vào comment `pnpm-workspace.yaml` như run 83. Đọc `node_modules/mongoose/CHANGELOG.md` từ 9.10.2 tới 9.11.4, ghi thay đổi hành vi liên quan (sanitizeFilter, discriminator, hydrate) vào `log.md`. Giữ `@nestjs/mongoose` 12.0.0 (peer `^9.0.0`).
  - (b) Pin trong `.github/workflows/ci.yml` và `codeql.yml`, dạng `uses: <repo>@<40 hex> # <tag>`:

    | Action | Tag | Commit (đã peel, đọc 2026-11-11) | Phát hành |
    |---|---|---|---|
    | `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` (tag nhẹ) | 2026-07-20 |
    | `actions/setup-node` | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` (tag nhẹ) | 2026-10-08 |
    | `actions/cache` | v6.1.0 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` (tag nhẹ) | 2026-06-26 |
    | `actions/upload-artifact` | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` (tag nhẹ) | 2026-10-07 |
    | `github/codeql-action/init`, `/analyze` | v4.39.3 | `33d7b85da1a04171e211befe2c739303b9a4c066` (tag object `f3bbb05…`, đã peel) | 2026-11-04 |

    Trước khi sửa, xác minh lại từng dòng bằng `git ls-remote https://github.com/<repo>.git "refs/tags/<tag>" "refs/tags/<tag>^{}"`: có dòng `^{}` thì dùng SHA của dòng đó, không có thì SHA duy nhất chính là commit. Lệch bảng ⇒ dừng, báo tech-lead. Không đổi input của action (`node-version-file`, `path`, `key`, `restore-keys`, `retention-days`, `fetch-depth`, `languages`…).
  - (c) Job `sbom` mới trong `ci.yml`, chỉ chạy khi `push`, sau checkout/setup-node/`corepack enable` (không cần `pnpm i`):
    - `pnpm --filter @sso-idp/be sbom --sbom-format cyclonedx --sbom-type application --prod --lockfile-only --out sbom-be.cdx.json`, và tương tự cho `@sso-idp/fe-admin` ⇒ `sbom-fe-admin.cdx.json`.
    - Bước kiểm bằng `node -e`: `bomFormat === 'CycloneDX'`, `components.length >= 100`, có `mongoose` ở be và `react` ở fe-admin, không có `jest`.
    - `upload-artifact` (pin như trên) với `retention-days: 90`; `permissions: contents: read`.
  - Workflow mới `.github/workflows/audit.yml`: `schedule` hằng ngày (`cron: '41 2 * * *'`) + `workflow_dispatch`; một job checkout/setup-node/corepack rồi `pnpm audit --audit-level high`; action pin như trên; `permissions: contents: read`.
  - (d) Thêm `runbook-deploy.md` §14 "Lỗ hổng thành phần — thời hạn khắc phục và SBOM" đúng D85.5: bảng thời hạn, ngoại lệ, cách lấy SBOM (artifact CI hoặc chạy tay lệnh trên), việc người dùng dismiss cảnh báo Dependabot. Chỉ sửa comment `dependabot.yml` khi người dùng đã xác nhận mục 1 của phần Dependabot; chưa có xác nhận thì để DEBT-585.
  - RED trước:
    - `pnpm audit --audit-level high` trên HEAD exit ≠ 0 (ghi đầu ra vào log). Sau (a): exit 0, `pnpm audit` chỉ còn deepmerge (đã ignore), `pnpm why -r mongoose` chỉ còn một phiên bản 9.11.4.
    - Lệnh kiểm pin `grep -hE '^\s*-?\s*uses:' .github/workflows/*.yml | grep -vE '@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+$'` phải ra rỗng (trước khi sửa: 18 dòng).
    - Chạy cục bộ lệnh SBOM ra 2 file hợp lệ.
  - Mutation: đổi một SHA lại thành tag ⇒ lệnh grep ra 1 dòng; bỏ `--prod` ⇒ bước kiểm SBOM thấy `jest` ⇒ đỏ.
  - AC: int FULL xanh trên mongoose 9.11.4 (`vg-int-*` không tăng); vault spec xanh; YAML của workflow parse được (dùng gói `yaml` có sẵn trong node_modules, không cài mới); runbook §14 có đủ 4 mức × 2 loại.

- [x] **T2 [BE] DEBT-571 + DEBT-584 — OIDC Core §6.1/§6.2 và §5.3.1 (P0)**
  - `authorize.service.ts`: `AuthorizeParams` thêm `request?: unknown; request_uri?: unknown`. Trong `handle()`, **ngay đầu Phase 2** (sau `isRegisteredRedirectUri`, trước `repeatedParam(params, PHASE2_PARAM_KEYS)`):
    - `params.request !== undefined` ⇒ `AuthorizeRedirectError('request_not_supported', 'The request parameter is not supported.')`;
    - còn lại, `params.request_uri !== undefined` ⇒ `'request_uri_not_supported'`.
    - Không thêm hai khoá này vào `AUTHORIZE_PARAM_KEYS` (không đổi ngữ nghĩa tham số lặp). Lỗi đi đường catch hiện có (gắn `redirectUri`/`state`; controller thêm `iss`). Không tạo context, không audit thành công, không phát code.
  - `discovery.controller.ts`: thêm `request_parameter_supported: false`, `request_uri_parameter_supported: false`.
  - `userinfo.controller.ts`: thêm `@Post('/userinfo')` với cùng `@Header('Cache-Control','no-store')`; GET và POST gọi chung một private `handle(req, reply)`. Token chỉ lấy qua `bearerToken(req)`, không đọc `req.body`.
  - RED trước — int `be/test/run85-oidc-p0.int-spec.ts`:
    1. Client hợp lệ + `request=eyJhbGciOiJub25lIn0.e30.` ⇒ 302 về redirect_uri với `error=request_not_supported`, `state` gốc, `iss`; 0 context trong Redis, 0 code.
    2. `request_uri=https://rp.example/r` ⇒ `request_uri_not_supported`.
    3. Có cả hai ⇒ `request_not_supported`.
    4. `request=` rỗng, và `request=a&request=b` ⇒ `request_not_supported` (không 500).
    5. redirect_uri chưa đăng ký + `request` ⇒ trang lỗi first-party 400, **không** redirect.
    6. Discovery có hai khoá bằng `false`.
    7. `POST /userinfo` có header Bearer hợp lệ ⇒ 200, body **giống hệt** GET với cùng token, `cache-control: no-store`.
    8. POST chỉ có body form `access_token=<AT hợp lệ>` ⇒ 401 `invalid_token` + `WWW-Authenticate`.
    9. POST với ID token ⇒ 401; thiếu scope `openid` ⇒ 403 `insufficient_scope`; phiên `sid` đã logout ⇒ 401.
    10. POST từ Origin đã đăng ký cho client của token ⇒ có ACAO; Origin khác ⇒ không có.
  - Mutation: M1 bỏ kiểm `request` ⇒ (1) đỏ; M2 đổi chỗ hai mã lỗi ⇒ (1)/(2) đỏ; M3 chuyển phần kiểm lên trước Phase 1 ⇒ (5) đỏ; M4 bỏ `@Post` ⇒ (7) đỏ; M5 POST đọc `body.access_token` ⇒ (8) đỏ; M6 discovery khai `true` ⇒ (6) đỏ.
  - AC: các ca trên xanh; test discovery hiện có cập nhật tập khoá; `authorize-params.int-spec.ts` không đổi kỳ vọng.

- [x] **T3 [BE] DEBT-574 — mật khẩu phổ biến + từ ngữ cảnh (P0)**
  - Lấy file. Việc này cần người dùng cho phép tải 1 file (khoảng 816 KB) từ `raw.githubusercontent.com`; orchestrator hỏi trước.
    - `curl -fsSL https://raw.githubusercontent.com/danielmiessler/SecLists/64b41f2156e1ae3edb592535c1b4b4dd0d6fe26a/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt -o <scratchpad>/ncsc-raw.txt`
    - `git hash-object <file>` **phải** bằng `38eb37702244f55fda75cab281eb2145cd7685b6`; khác ⇒ dừng.
  - Script `be/scripts/derive-common-passwords.mjs <raw> <out>` (chỉ dùng Node stdlib): tách dòng (bỏ `\r`), NFKC + `toLowerCase()`, giữ dòng dài 8–128, bỏ trùng giữ lần xuất hiện đầu, cắt còn 10 000 dòng; in số dòng + sha256 của kết quả.
  - Commit kết quả vào `be/src/modules/authentication/password-policy/common-passwords.txt` (LF, kết thúc bằng `\n`), kèm `common-passwords.NOTICE.md`: URL, commit, blob, kích thước, giấy phép MIT của SecLists + ghi công NCSC/HIBP (CC BY 4.0), quy tắc dẫn xuất, số dòng, sha256. `be/nest-cli.json` thêm assets `"modules/authentication/password-policy/*.txt"`.
  - Mã: `be/src/modules/authentication/password-policy/password-policy.ts` export:
    - `loadCommonPasswords(path?: string): ReadonlySet<string>` — ném nếu thiếu file hoặc < 3000 dòng;
    - `assertAcceptablePassword(password: string, ctx: { email?: string }): void` — ném `BadRequestException` với câu cố định: lỗi độ dài giữ câu hiện có; thuộc danh sách hoặc trùng từ ngữ cảnh ⇒ `Choose a less common password.` (không echo).
    - So khớp trên `password.normalize('NFKC').toLowerCase()`, bị từ chối khi: thuộc tập; hoặc chứa `veyrigate`/`sso-idp`/`ssoidp`; hoặc chứa phần local của email (lowercase, chỉ khi ≥ 4 ký tự); hoặc bằng email.
    - Tập được nạp **một lần** khi import module, nên Nest khởi động là fail-closed.
  - Thay `AuthenticationService.validatePassword` bằng `assertAcceptablePassword`:
    - register: truyền `{ email }`, vẫn kiểm trước khi tra tài khoản tồn tại như hiện tại ⇒ không enumeration;
    - reset: kiểm trước `consume`. Lúc này chưa biết email, nên reset chỉ kiểm danh sách + từ sản phẩm; T5 truyền email ở đổi mật khẩu.
    - Không áp cho login và seed.
  - RED trước:
    - Unit `password-policy.spec.ts`: dòng đầu, giữa, cuối của file bị từ chối; cùng chuỗi đó viết HOA và dạng fullwidth (NFKC) cũng bị từ chối; `veyrigate2026!` bị từ chối; `alice.smith#2026` với email `alice.smith@example.com` bị từ chối; `x7#Qm2!vLp9@zR4w` được nhận. File: ≥ 3000 dòng, không trùng, toàn lowercase, độ dài 8–128. `loadCommonPasswords` với file rỗng hoặc không tồn tại ⇒ ném.
    - Int: register với mật khẩu trong danh sách ⇒ 400, 0 user, 0 thư, phản hồi giống hệt khi email đã tồn tại. Reset với mật khẩu trong danh sách ⇒ 400 và token **chưa** bị tiêu (dùng tiếp với mật khẩu tốt ⇒ thành công).
    - Build: `pnpm -C be build` rồi `test -s be/dist/modules/authentication/password-policy/common-passwords.txt`.
  - Mutation: M1 so khớp phân biệt hoa thường; M2 bỏ kiểm ở reset; M3 bỏ luật email; M4 `loadCommonPasswords` chấp nhận file rỗng; M5 bỏ NFKC.
  - AC: các ca trên xanh; image be (job CI `be-image`) chứa file. Dockerfile build từ `be/` nên không cần sửa Dockerfile; kiểm bằng build CI sau push.

- [x] **T4 [BE+UI] DEBT-575 (+ DEBT-016) — chống khoá có chủ đích (P0), hợp đồng D85.2**
  - Trust boundary: trình duyệt ẩn danh → form `/login`. Tài sản: khả năng đăng nhập của nạn nhân (availability) và mật khẩu (brute force). Actor: kẻ đoán từ 1 mạng, botnet nhiều mạng, kẻ chung NAT với nạn nhân, kẻ từng biết mật khẩu (giữ device cookie cũ).
  - File mới `be/src/modules/authentication/login-throttle.service.ts`:
    - `networkOf(ip)`: IPv4 giữ nguyên địa chỉ; IPv4-mapped IPv6 ⇒ IPv4; IPv6 ⇒ 4 hextet đầu sau khi mở rộng (`/64`); rỗng hoặc không parse được ⇒ chuỗi `unknown` (vẫn tính chung một bucket).
    - Khoá Redis, hash-tag theo email để cùng slot, cửa sổ 900 s:
      - `lt:{e:<sha256(email)>}:n:<sha256(network)>` (N = 5);
      - `lt:{e:<sha256(email)>}:a` (A = 20);
      - `lt:{e:<sha256(email)>}:d:<sha256(deviceToken)>` (D = 10).
      - email = `normalizeEmail` của chuỗi gửi lên (không cần tài khoản tồn tại).
    - Trust: ZSET `dc:{u:<sha256(userId)>}`, member `sha256(deviceToken)`, score = mốc ms của lần đăng nhập mật khẩu thành công gần nhất. Thiết bị tin cậy ⇔ score ≥ now − 90 ngày.
    - Khi đăng nhập thành công: `ZADD` + `ZREMRANGEBYSCORE` (cũ hơn 90 ngày) + `ZREMRANGEBYRANK 0 -21` (giữ 20) + `PEXPIRE` 90 ngày, trong một `MULTI`. Lỗi ⇒ log câu cố định, không đặt cookie mới, đăng nhập vẫn thành công (fail-safe: chỉ mất trạng thái tin cậy).
  - Cookie `idp_dc` qua `hostCookieName` (⇒ `__Host-idp_dc` khi `SESSION_COOKIE_SECURE=true`); giá trị `generateToken()` (32 byte base64url); `HttpOnly; SameSite=Lax; Path=/; Max-Age=7776000`; `Secure` theo `sessionCookie.secure`; không `Domain`. Đặt khi đăng nhập mật khẩu thành công; dùng lại giá trị cũ nếu cookie đã có và đúng dạng. Federation không đặt và không đọc cookie này.
  - Luồng `AuthenticationService.login`, thứ tự bắt buộc:
    1. Tra user theo email (như hiện tại).
    2. Xác định trusted: có cookie + user tồn tại + ZSCORE hợp lệ.
    3. `rateLimit.reserve(trusted ? [D] : [N, A], 900)` **trước** Argon2.
    4. Bị chặn: không chạy Argon2, không ghi gì vào user, ném `HttpException(429)` kèm `retryAfter` (filter HTML hiện có render, có header `Retry-After`). Câu cố định `Too many sign-in attempts. Try again later or reset your password.`, giống hệt cho mọi bucket và cho email không tồn tại. Audit `AUTH_LOGIN_THROTTLED` (enum mới) `result:'failure'`, `metadata:{scope:'network'|'account'|'device'}`, ip/requestId như audit hiện có; **tối đa 1 lần mỗi bucket mỗi cửa sổ** (`SET NX` khoá `lt:…:audited:<scope>`, TTL 900 s) để không bị lũ audit.
    5. Verify như cũ. Sai: audit `AUTH_LOGIN_FAILED` như cũ, **không** gọi `recordFailedLogin`, không còn `AUTH_ACCOUNT_LOCKED`.
    6. Đúng: `DEL` khoá N (hoặc D) của cặp này, `refund([A])` (chỉ khi untrusted), cập nhật ZSET, đặt cookie.
  - `ui.controller.ts` `loginPost`: limiter chung bỏ chiều `account` cho `login` (giữ `ip` + `deviceId`); register/forgot/reset giữ nguyên. Giữ kiểm `lockedUntil > now` (khoá admin `ADMIN_LOCKED_UNTIL`, và khoá tạm cũ còn sót, tự hết trong ≤ 15'). Xoá `UserService.recordFailedLogin` cùng test của nó (mã chết); giữ field trong schema (DEBT-589).
  - Thu hồi tin cậy: `revokeAllUserCredentials` thêm bước cuối best-effort `DEL dc:{u:…}`. Lỗi ở bước này ⇒ log câu cố định, không đổi lỗi trả về (3 bước cũ giữ thứ tự first-error-wins của DEBT-055). Bước này áp cho reset, khoá admin, admin revoke sessions, logout global, đổi mật khẩu (T5). Reset thành công còn `DEL` khoá A của email.
  - Failure semantics: Redis lỗi ở reserve/ZSCORE ⇒ ném lỗi (500/503 như limiter hiện tại), **không** chạy Argon2, không tạo phiên (fail-closed). Mongo lỗi xử lý như hiện tại.
  - Tài liệu (ASVS 6.1.1):
    - `spec.md` §6.3: bảng mọi bucket (limiter chung ip/device theo endpoint, login N/A/D, client-auth DEBT-029, đổi mật khẩu T5) và cách chống khoá: không khoá cứng; thiết bị tin cậy không chịu A; reset gỡ A.
    - Giới hạn còn lại cũng phải ghi: kẻ chung NAT hoặc chung mạng /64 với nạn nhân chặn được nạn nhân trên thiết bị mới, mỗi lần ≤ 15'; nạn nhân thoát bằng reset hoặc dùng thiết bị quen.
    - `security-matrix.md`: cập nhật AE5/G1.
  - RED trước — int `be/test/run85-anti-lockout.int-spec.ts` (spy đếm số lần `verifyPassword`):
    1. 5 lần sai từ IP A vào tài khoản nạn nhân ⇒ lần 6 từ A = 429, Argon2 không chạy; nạn nhân nhập đúng mật khẩu từ IP B ⇒ 302 + phiên (hôm nay: 401 vì bị khoá).
    2. 20 lần sai rải trên 5 IP ⇒ lần 21 từ IP mới = 429; nạn nhân có `idp_dc` từ lần đăng nhập trước ⇒ thành công.
    3. Cookie tin cậy của user X không làm user Y tin cậy; cookie bịa ⇒ không tin cậy.
    4. Email không tồn tại: 429 đúng ở lần 6, body và header giống hệt email tồn tại.
    5. 10 request sai song song cùng (email, IP) ⇒ đúng 5 lần Argon2, 5 lần 429, đúng 1 audit `AUTH_LOGIN_THROTTLED`.
    6. 4 lần sai + 1 lần đúng ⇒ khoá N về 0 (phải sai thêm 5 lần mới bị chặn ở lần thứ 6).
    7. Reset thành công ⇒ cookie cũ hết tin cậy, khoá A bị xoá.
    8. Redis lỗi (stub ném) ⇒ 5xx, không Argon2, không `Set-Cookie` phiên.
    9. `2001:db8::1` và `2001:db8::ffff` chung bucket; `2001:db8:0:1::1` khác bucket; `::ffff:203.0.113.7` trùng bucket với `203.0.113.7`.
    10. `SESSION_COOKIE_SECURE=true` ⇒ `Set-Cookie: __Host-idp_dc=…; Max-Age=7776000; Path=/; HttpOnly; Secure; SameSite=Lax`, không có `Domain`.
    11. Không còn `AUTH_ACCOUNT_LOCKED` mới; `lockedUntil` không đổi sau 30 lần sai.
    - Unit: bảng ca cho `networkOf`.
  - Mutation: M1 bỏ chiều mạng (chỉ theo email) ⇒ (1) đỏ; M2 bỏ ngoại lệ thiết bị tin cậy ⇒ (2) đỏ; M3 trust chỉ theo hash cookie, không theo user ⇒ (3) đỏ; M4 chạy Argon2 trước reserve ⇒ (5) đỏ; M5 fail-open khi Redis lỗi ⇒ (8) đỏ; M6 IPv6 dùng /128 ⇒ (9) đỏ; M7 không xoá ZSET khi revoke ⇒ (7) đỏ; M8 vẫn gọi `recordFailedLogin` ⇒ (11) đỏ.
  - AC: các ca trên xanh. Test cũ đổi kỳ vọng phải ghi lý do trong log: `rate-limit.int-spec.ts` "rotating IPs does not bypass the per-account limit…", `authentication.int-spec.ts` "ten concurrent failed logins persist ten failures and one lock audit event", unit `recordFailedLogin`. X3 42 xanh (có cookie mới), và ma trận X3 kiểm tên `__Host-idp_dc`.

- [x] **T5 [BE+UI] DEBT-573 — đổi mật khẩu (P0), hợp đồng D85.6** (BE + trang xong; E2E `password-change.spec.ts` chưa viết ⇒ DEBT-594, T6)
  - Trust boundary: trình duyệt có phiên → form. Tài sản: credential của user. Actor: chủ tài khoản, kẻ cướp phiên (không biết mật khẩu hiện tại), CSRF từ site khác.
  - Route trong `ui.controller.ts`:
    - `GET /account/password`: không có phiên sống ⇒ 302 `/login?returnTo=%2Faccount%2Fpassword`; user không có `passwordHash` (chỉ đăng nhập federation) ⇒ 200 trang thông báo `This account has no password. Use "Forgot password" to set one.`; còn lại ⇒ form `password-change.eta`, `no-store`, có CSRF.
    - `POST /account/password` với `@UseGuards(CsrfGuard)`, DTO `ChangePasswordDto extends FormDto { @IsString() @Length(1,128) current_password; @IsString() @Length(8,128) new_password }`.
    - Trang chủ khi đã đăng nhập (`/`) thêm link "Change password".
  - Luồng POST, thứ tự bắt buộc:
    1. Phiên sống; không có ⇒ 302 `/login`.
    2. `limit('password_change', req, session.userId)`.
    3. `reserve([pwc:{u:<sha256(userId)>}], 900)` giới hạn 5; bị chặn ⇒ 429 câu cố định, không Argon2, audit throttled 1 lần mỗi cửa sổ.
    4. Đọc user kèm `+passwordHash`; không có hash ⇒ 400, audit `no_password`.
    5. `verifyPassword(current)` sai ⇒ 400, render lại form với câu `The current password is incorrect.`, audit failure `invalid_current`.
    6. `assertAcceptablePassword(new, { email })` (T3) không đạt ⇒ 400, render lại form với câu cố định, audit `policy`, `refund`.
    7. Hash mật khẩu mới, gọi `UserService.changePassword(sub, oldHash, newHash)` (**mới**): `findOneAndUpdate({_id, passwordHash: oldHash, lockedUntil không > now}, {$set: {passwordHash: newHash}})`, không đụng `emailVerifiedAt` hay khoá. Kết quả null ⇒ 409 trang `Your password could not be changed. Sign in again and retry.`, audit `conflict`.
    8. `revokeAllUserCredentials(userId, now, onFailure ⇒ audit AUTH_PASSWORD_CHANGED failure revoke_failed + failedStep)`. Lỗi ⇒ 5xx, mật khẩu **không** rollback (DEBT-050).
    9. Xoá cookie phiên, `refund`, audit `AUTH_PASSWORD_CHANGED` success `metadata:{sessionCount, tokenCount}`.
    10. Thư `passwordChangedMessage(email, isoUtc)` fire-and-forget (`.catch` log câu cố định).
    11. 200 `message.eta`: `Your password has been changed. Sign in again with your new password.` (`no-store`).
  - `resetPassword` cũng gửi `passwordChangedMessage` sau audit success. Template mới trong `mailer/templates.ts`: không token, không link một lần, có link `<issuer>/forgot`; đi qua guard D84.1 của `SmtpMailer.send` như mọi thư.
  - Exposure: không echo mật khẩu hay email trong phản hồi/log/audit; mọi câu lỗi cố định; phản hồi không phụ thuộc gì ngoài các nhánh trên.
  - RED trước — int `be/test/run85-password-change.int-spec.ts`:
    1. GET/POST không có phiên ⇒ 302 `/login…` (POST thiếu CSRF ⇒ 403 trước); CSRF của identity khác ⇒ 403.
    2. Sai mật khẩu hiện tại ⇒ 400, hash không đổi, audit `invalid_current`, không revoke.
    3. Lần sai thứ 6 trong 900 s ⇒ 429, Argon2 không chạy.
    4. Mật khẩu mới thuộc danh sách, hoặc chứa phần local của email ⇒ 400, hash không đổi.
    5. Thành công ⇒ login bằng mật khẩu cũ 401, bằng mật khẩu mới 302; mọi phiên chết (kể cả phiên hiện tại, cookie bị xoá); refresh của mọi family ⇒ `invalid_grant`; AT mang `sid` cũ ⇒ `/userinfo` 401; device cookie cũ hết tin cậy; có audit success; recorder `MAILER` có đúng 1 thư tới email của user, không chứa `token=` hay `#token`; `cache-control: no-store`.
    6. Reset chen vào giữa verify và CAS (stub đổi hash) ⇒ 409, không revoke thêm.
    7. Admin khoá tài khoản giữa chừng ⇒ 409.
    8. User chỉ có federation ⇒ GET ra trang thông báo, POST 400.
    9. `sessions.revokeAllForUser` ném ⇒ 5xx, hash đã đổi, audit failure `revoke_failed` có `failedStep:'sessions'`.
    10. Reset thành công cũng gửi đúng 1 thư "password changed".
    - E2E mới `e2e/tests/password-change.spec.ts`: 2 context cùng user; đổi mật khẩu ở A ⇒ ở B, `/authorize?prompt=none` về RP với `login_required`; A phải đăng nhập lại; mật khẩu cũ bị từ chối.
  - Mutation: M1 bỏ verify mật khẩu hiện tại ⇒ (2) đỏ; M2 revoke trước CAS ⇒ (6) đỏ (spy thứ tự); M3 bỏ revoke ⇒ (5) đỏ; M4 bỏ policy ⇒ (4) đỏ; M5 CAS không lọc theo `passwordHash` ⇒ (6) đỏ; M6 reserve sau Argon2 ⇒ (3) đỏ; M7 `changePassword` set `emailVerifiedAt` ⇒ unit đỏ.
  - AC: các ca trên xanh; E2E 39 (38 + 1) xanh.

- [x] **T6 [QA] tester — checklist + gate** (tester 2026-11-11: lượt 1 FAIL — DEBT-600 race login mật khẩu cũ ∥ đổi/reset ⇒ backend-dev sửa; **retry 1 PASS**: unit 931, int 2143/2143, vault 31 (orchestrator), E2E 39, X3 42; xem `test-report.md`)
  - `release-checklist.md`:
    - B-6.1, B-5.3.1, C-6.1.1, C-6.2.2, C-6.2.4 ⇒ ✅, bằng chứng là tên test thật kiểm bằng `grep -F`.
    - C-6.2c ⇒ ⚠ (6.2.11 ✅, 6.2.12 DEBT-587); C-6.1b: phần từ ngữ cảnh ✅ (tài liệu gom vẫn thuộc DEBT-580).
    - C-6.3a và C-7.4b: đổi bằng chứng sang test mới.
    - C-15.1.1 ✅ (runbook-deploy §14 + job `sbom`); C-15.2a và D-2 chờ người dùng xác nhận mục 1–3 phần Dependabot; D-3 ✅; thêm dòng D-15 "audit dependency theo lịch" ✅.
    - Cập nhật bảng tổng và danh sách P0 còn lại (C-14.2.1 ⇒ run 86); `security-matrix.md`: AE5, G1, thêm dòng đổi mật khẩu.
  - Spec tester bổ sung (không trùng T2–T5): reset và đổi mật khẩu đồng thời (đúng 1 bên thắng, revoke của cả hai idempotent); login với cookie `idp_dc` quá dài hoặc có ký tự lạ ⇒ không tin cậy, không 500; `request_uri` URL-encode lạ; `POST /userinfo` `content-type: application/json` body lớn ⇒ 401/413, không 500.
  - Gate (tuần tự): typecheck/lint ⇒ be unit ⇒ int FULL (`vg-int-*` không tăng) ⇒ vault spec 31 ⇒ E2E 39 ⇒ X3 42. Test fe-admin **không** bắt buộc vì không đổi `fe-admin/` và lockfile chỉ đổi cây be (xác nhận bằng `git diff --stat`).

### Run 86 (X6 đợt 2b) — orchestrator mở sau khi đóng run 85; tech-lead fold lại trên code lúc đó

- DEBT-577 [BE+UI] (P0) theo D85.3:
  - `issueToken` dùng `link.hash = 'token=' + token`.
  - `verify.eta`/`reset.eta`: ô `token` để rỗng, thêm `<script src="/assets/token-fragment.js">` và `<noscript>` với ô mã hiện ra.
  - Script: regex `^#token=([A-Za-z0-9_-]{43})$`, điền ô, `history.replaceState(null, '', location.pathname)`. Thư in mã dưới link. GET bỏ qua `?token=`.
  - RED: link trong thư không có `?` mà có `#token=`; GET `/reset?token=x` không render `x`; POST body vẫn tiêu token; E2E đọc thư qua mailpit rồi đặt lại mật khẩu bằng link fragment (Chromium), có thêm ca không JS.
- DEBT-393 [BE] + [FE] theo D85.7: hai task, FE làm sau BE vì phụ thuộc OpenAPI.
- DEBT-572 [BE] (P1): POST `/logout` không có `_csrf` nhưng có tham số RP ⇒ render trang xác nhận như GET, không huỷ phiên; POST có `_csrf` giữ nguyên; chạy X3 42.
- DEBT-583 [BE] (P2): `base-uri 'none'` trong `csp.ts`, kèm test byte-identity với helmet (`main.ts`).
