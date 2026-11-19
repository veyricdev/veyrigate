# Backlog triage — run 96 T2

Ngày 2026-11-18. Phạm vi: mọi dòng DEBT chưa đóng trong `backlog.md`. Không sửa code; chỉ sửa `backlog.md` (ô đầu của dòng đóng, ô nguồn của dòng gắn mức) bằng script Python theo 5 lô (50/50/50/50/37 dòng), kiểm `git diff` sau mỗi lô: 50 dòng đổi, không thêm/xoá/đổi thứ tự dòng, số ô mỗi dòng giữ nguyên.

Cách kiểm: `codegraph sync` + CodeGraph, rồi grep/đọc code và tài liệu hiện tại; quét mọi `runs/*/summary.md`, `plan.md` §12, `release-checklist.md` và code tìm nhắc tới từng DEBT mở.

## Số dòng mở thật là 237, không phải 394

Con số 394 trong `tasks.md` đếm cả 156 dòng của bảng **"Đã đóng"** (dạng `| DEBT-N | <run đóng> | ghi chú |`, vd. DEBT-071, DEBT-159). Các dòng đó đã đóng sẵn và không gắn mức vì bảng đó không có cột mức. Từ dòng 445, file còn 81 dòng **mở** (dạng 5 ô, DEBT-417…DEBT-691) nằm sau tiêu đề "Đã đóng". Run này giữ nguyên vị trí của chúng (không đổi thứ tự).

| Mức | Trước | Đóng | Gắn mới | Sau |
|---|---|---|---|---|
| 🔴 | 0 | 0 | 0 | 0 |
| 🟡 | 50 | 4 (162, 194, 225, 500) | +2 (072, 126) | **48** |
| 🟢 | 8 | 1 (408) | 0 | **7** |
| 💭 | 140 | 6 (227, 255, 284, 351, 430, 501) | +27 | **161** |
| không gắn mức | 39 | 10 | −29 | **0** |
| **Tổng mở** | **237** | **21** | | **216** |

Không có dòng 🔴: không thấy lỗ bảo mật hoặc mất dữ liệu nào đang mở ở production. Các mục bảo mật còn mở đều đã có lớp chặn (fail-closed, TTL ngắn, hoặc yêu cầu khi deploy).

## Danh sách đóng (21)

| DEBT | Mức cũ | Lý do | Bằng chứng |
|---|---|---|---|
| DEBT-017 | — | đã xong | run 91 (DEBT-665/671/672, D91.4) chống chiếm tài khoản trước; federation không dò/ghép email chưa xác minh (`federation.service.ts:310,405`) |
| DEBT-049 | — | đã xong | `runbook-deploy.md` §3 `noeviction` + `ops/compose/prod.example.yml:109` `--maxmemory-policy noeviction` |
| DEBT-076 | — | đã xong | run 22 summary đóng DEBT-076 (seed user dev từ env `DEV_SEED_*`) |
| DEBT-078 | — | đã xong | run 22 đóng; `fe-sso-test/src/oidc/refresh.ts:97` `if (deps.tokens.get() === current)` |
| DEBT-079 | — | đã xong | run 22 đóng; `fe-sso-test/src/oidc/logout.ts:99` gọi `consumeLogoutState` |
| DEBT-080 | — | đã xong | run 22 đóng; `fe-sso-test/src/oidc/token-exchange.ts:57` chỉ giữ mã lỗi, không echo `error_description` |
| DEBT-083 | — | đã xong | E2E CI chạy Mongo `--replSet rs0` + `rs.initiate` (`.github/workflows/ci.yml:248-250`) |
| DEBT-085 | — | đã xong | nút social là link GET (`ui.controller.ts:193` `socialLogins` trả `{label, href}`), B5.2 xong, không qua form POST |
| DEBT-094 | — | đã xong | `be/src/common/logger/error-log.ts:25` xoá `user:password@` khỏi mọi URI trong log lỗi (DEBT-523) |
| DEBT-117 | — | đã xong | run 42 summary (đóng DEBT-117); `fe-admin/src/server/auth/bff.ts:204` step-up đổi danh tính ⇒ huỷ cả hai phiên |
| DEBT-162 | 🟡 | đã xong | `fe-admin/src/server/admin-api/client.ts:188-197` 401 ⇒ refresh cưỡng bức + gửi lại một lần (phủ 401 sau emergency rotate) |
| DEBT-194 | 🟡 | đã xong | job CI `be-image` (bắt buộc, D96.4) boot image `CMD node dist/main.js` (`be/Dockerfile:47`) và kiểm `/ready` (`be/scripts/docker-smoke.sh:176-184`, `ci.yml:491`) |
| DEBT-225 | 🟡 | đã xong | run 92 (CodeQL 40 alert triage ⇒ 0 mở, `.gitleaksignore` 11 fingerprint, promtool xanh) + run 93 CodeQL `paths-ignore`; CI #56 9/9 xanh gồm `secrets`/`promtool`/`quality` (run 95) |
| DEBT-227 | 💭 | đã xong | mọi action pin SHA (`.github/workflows/ci.yml:35-538`, `codeql.yml:36-54`, `audit.yml:20-24`); branch protection `develop` bắt buộc 9 job (D96.4) |
| DEBT-255 | 💭 | đã xong | fe-admin (A4–A6, run 42–50) là đường thao tác thường cho người trực, có step-up; runbook-ops §0 (dòng 13) chỉ dùng curl khi console không vào được |
| DEBT-284 | 💭 | đã xong (yêu cầu deploy) | biện pháp đề xuất đã thành yêu cầu deploy: `runbook-deploy.md:242` "Rate limit `/auth/login` ở proxy (DEBT-284)" |
| DEBT-351 | 💭 | đã xong | webServer BE E2E `timeout: 320_000` (`e2e/playwright.config.ts:62`, DEBT-464 run 68) |
| DEBT-408 | 🟢 | trùng | trùng DEBT-693 (đóng run 95: `docker logs` ghi file rồi grep, `be/scripts/docker-smoke.sh:259-260`) |
| DEBT-430 | 💭 | đã xong | `be/test/run80-tester.int-spec.ts:426` so tài liệu BE phục vụ với snapshot `fe-admin/openapi/admin.json` (run 80) |
| DEBT-500 | 🟡 | không còn áp dụng | giả thuyết sai: Dependabot có alert/security update npm (alert #40 picomatch dismiss ở D96.3; PR security #2 nhóm `npm_and_yarn`, run 96 T1). Phần sửa comment `dependabot.yml:5-7`/`runbook-deploy.md:273`/checklist D-2, E-500 ⇒ DEBT-585 |
| DEBT-501 | 💭 | trùng | digest CI/compose/smoke đã ghim (DEBT-590, run 87; vd. mailpit `ci.yml:211`); phần làm mới tay còn lại trùng DEBT-611 |

## Gắn mức mới (29 dòng trước đây không có mức)

| DEBT | Mức | Căn cứ (trạng thái hiện tại) |
|---|---|---|
| DEBT-025 | 💭 | vẫn 2 type `AuthzRedis`/`AuthCodeRedis` |
| DEBT-031 | 💭 | /revoke chưa theo thiết bị; `/account/sessions` (run 88) phủ phần tự huỷ phiên |
| DEBT-032 | 💭 | rotation chưa transaction (`token/` không `withTransaction`), fail-closed |
| DEBT-044 | 💭 | discovery chưa `frontchannel_logout_session_supported` |
| DEBT-047 | 💭 | chỉ khi có pairwise `sub` |
| DEBT-048 | 💭 | chưa có revocation epoch theo user (chỉ `at_revoked:{jti}` cho code reuse) |
| DEBT-062 | 💭 | ponytail còn (`...(familyId ? { familyId } : {})` ở token.service.ts:233) |
| DEBT-063 | 💭 | `authentication.service.ts:495` revoke lỗi ⇒ 5xx chung; `AUTH_PASSWORD_RESET` chưa trong `ALERT_ACTIONS` |
| DEBT-064 | 💭 | `/ready` vẫn public, runbook chưa giới hạn mạng nội bộ |
| DEBT-042 | 💭 | `keys.module.ts:3` vẫn import `ClientsModule` |
| DEBT-072 | 🟡 | limiter client auth chỉ theo IP và client+IP (`client-authentication.service.ts:55`), chưa có trần toàn cục theo client_id |
| DEBT-075 | 💭 | `introspect.controller.ts:273` 429 chưa có `error_description` |
| DEBT-077 | 💭 | `be/src/database/seed-dev.ts` vẫn tồn tại song song `seed.ts`/`bootstrap.ts` (chỉ dev) |
| DEBT-081 | 💭 | `callback.ts:32` `KNOWN_ERROR_CODES` còn (fe-sso-test, không production) |
| DEBT-082 | 💭 | `seed-dev.ts` `seedDevUser` vẫn `$set passwordHash` khi upsert (chỉ dev) |
| DEBT-092 | 💭 | `token-exchange.ts:20` set + `csp.ts:93` check `'null'` còn |
| DEBT-093 | 💭 | `e2e-main.ts` không nạp `.env` nhưng bước `db:sync-indexes`/`db:seed-dev` trong webServer E2E vẫn `--env-file-if-exists=.env` (`be/package.json:19-20`) |
| DEBT-097 | 💭 | ponytail e2e/int-preflight chưa làm |
| DEBT-099 | 💭 | fe-sso-test vẫn dựng lại phiên bằng redirect `prompt=none` (`router.tsx` probe) |
| DEBT-107 | 💭 | `fe-sso-test/src/router.tsx:113` nhánh `?error=` chưa so `state`/`iss` |
| DEBT-108 | 💭 | CI vẫn `trace: retain-on-failure` (`e2e/playwright.config.ts:40`) |
| DEBT-115 | 💭 | `router.tsx:34/63` gate kép `loadLab`+`withLab` còn |
| DEBT-118 | 💭 | `token.service.ts:30` `new URL('/admin/', issuer)` vs `demo.controller.ts:61` nối chuỗi (chỉ demo dev) |
| DEBT-124 | 💭 | chưa có thao tác xuyên tenant (chờ đa tenant thật) |
| DEBT-126 | 🟡 | guard admin (`identity/tenant-context/tenant-context.ts`) không audit/metric khi từ chối 401/403 |
| DEBT-127 | 💭 | `resource.schema.ts` chỉ unique `identifier`, `resourceId` chưa unique (`resource.service.ts:55`) |
| DEBT-140 | 💭 | audit OAuth/auth phần lớn chưa gắn `tenantId` (`admin-audit.controller.ts:47`) |
| DEBT-143 | 💭 | cùng DEBT-124, chờ đa tenant thật |
| DEBT-208 | 💭 | admin API chưa có endpoint thêm/suspend member (chỉ `GET /admin/tenants`, `admin-tenants.controller.ts:28`) |

## Top 10 việc còn mở nên làm tiếp (ưu tiên production)

| # | DEBT | Vì sao | Cỡ |
|---|---|---|---|
| 1 | DEBT-670 | Điều kiện go-live (2): alert `SsoBackgroundWriteFailed`/`SsoAuthMailFailed`/`SsoMailDropped` mới chỉ là rule trong repo; chưa nạp vào Prometheus/Alertmanager thật nên sự cố ghi nền hoặc mail sẽ không ai biết | M (ops, cần môi trường) |
| 2 | DEBT-506 | Điều kiện go-live (1): ma trận cookie X3 cột WebKit/Windows không đại diện Safari (`SameSite` không được áp); spec §9.6 đòi kiểm Safari thật trước launch | S–M |
| 3 | DEBT-375 | fe-admin chưa từng đăng nhập thật trên build prod/image (E2E chạy `vite dev`); đường production của console admin chưa được kiểm (P1 trong checklist) | M |
| 4 | DEBT-280 | fe-admin dùng chung Redis với IdP, `SESSION_REDIS_URL` chưa bắt buộc `rediss://`/ACL `~fea:*` ⇒ credential RP đọc/ghi được key phiên IdP (ASVS 12.3.1) | S |
| 5 | DEBT-392 | Redis Sentinel chưa TLS + ACL riêng cho app: phiên/code đi plaintext trong mạng nội bộ (P1) | M |
| 6 | DEBT-391 | Vault (HA raft, auto-unseal, snapshot, audit device) chưa có runbook hạ tầng; mất storage Vault = mất key ký | M (ops) |
| 7 | DEBT-218 | Counter reuse/rotation chỉ tăng sau khi audit ghi thành công (`audit.service.ts:139`) ⇒ Mongo lỗi lúc reuse thì alert reuse im (ASVS 16.3.3) | S |
| 8 | DEBT-591 | Không có cảnh báo CVE cho base image (`node:*-bookworm-slim`, redis, vault); Dependabot docker không có security update | S–M |
| 9 | DEBT-072 | Limiter client auth chỉ theo IP và client+IP ⇒ botnet xoay IP vẫn ép Argon2 hàng loạt (DoS); thiếu trần toàn cục theo `client_id` | S |
| 10 | DEBT-126 | Admin bị từ chối (401/403/`step_up_required`) không có audit/metric ⇒ không phát hiện được dò quyền trên control plane | S |

Kế tiếp (ngoài top 10): DEBT-585 (sửa comment `dependabot.yml:5-7`, `runbook-deploy.md:273`, checklist D-2/E-500 sau khi DEBT-500 đóng, cỡ S), DEBT-618 (app tự phát alert `ADMIN_RECOVERED`), DEBT-228/267 (`minimumReleaseAge: 0` vẫn tắt cooldown của pnpm), DEBT-633 (user có MFA không tự liên kết Google/GitHub được), DEBT-048 (chưa có epoch thu hồi AT theo user).

## Phần kiểm chưa sâu

- Mọi 🟡 (50), mọi dòng không gắn mức (39) và 6/8 🟢 đã kiểm trực tiếp trên code/tài liệu; bằng chứng của dòng đóng và dòng gắn mức nằm ở các bảng trên, dòng giữ mở có bằng chứng cụ thể thì mô tả của nó vẫn đúng với code hiện tại.
- 75 dòng **giữ mở** chỉ dựa trên đọc mô tả và lượt quét nhắc tới (summary/plan/checklist/code), chưa mở code. Lượt quét không thấy dấu hiệu đã xong, nhưng chưa kiểm từng dòng. Đa số là 💭 UX fe-admin, hạ tầng test/E2E hoặc tính năng hoãn sau phát hành. Gồm DEBT-217, 240, 245, 250, 270, 283, 285, 293, 305, 306, 307, 309, 311, 317, 320, 338, 342, 345, 350, 353, 354, 361, 363, 367, 377, 378, 381, 400, 402, 409, 416, 424, 425, 426, 440, 441, 467, 468, 481, 484, 485, 486, 497, 507, 508, 517, 534, 539, 545, 548, 549, 552, 560, 561, 562, 566, 568, 569, 578, 580, 592, 601, 609, 610, 611, 619, 623, 624, 625, 626, 636, 648, 658, 670, 691 (🟢 DEBT-400 và DEBT-648 chỉ xác minh được bằng cách chạy test, mà run này không chạy test).
- T1 (Dependabot) đang chạy song song và có thể làm thay đổi các dòng phụ thuộc: DEBT-229, 295, 431, 449, 479, 551, 552, 558, 690. Trạng thái ghi ở đây là của HEAD `8641174` cộng cây làm việc lúc triage.
- Lệch tài liệu đã thấy nhưng không sửa (ngoài phạm vi T2): `.github/dependabot.yml:5-7` và `runbook-deploy.md:273` vẫn ghi "npm không có Dependabot alert", nay đã bị bác bỏ (DEBT-585).
