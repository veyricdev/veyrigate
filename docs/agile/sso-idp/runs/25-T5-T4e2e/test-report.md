# Test Report — 2026-10-16 (run 25 — T5 security lab + T4 E2E + DEBT-101/102)

## Kết quả: PASS (FE 240/240, E2E 12/12 x2, BE unit 211/211)

Phạm vi: thay đổi chưa commit kể từ `4d67f3b` trong `fe-sso-test/` và `e2e/` (Task 1–4). `be/` không đổi (`git diff --stat 4d67f3b -- be` rỗng).
Preflight: `codegraph --version` 1.6.2, `status` up to date, `sync` xong. Git Bash; UTF-8 không BOM. KHÔNG compose up, KHÔNG FLUSH/drop `aegate-*`, KHÔNG commit. Port 4000/5173 trống trước khi chạy, đã nhả sau mỗi lượt E2E (Playwright tự dừng webServer).

## Lệnh đã chạy + output thực tế

| # | Lệnh | Kết quả |
|---|---|---|
| 1 | `pnpm -C fe-sso-test typecheck` | `tsc -b --noEmit` exit 0 |
| 2 | `pnpm -C fe-sso-test lint` | `eslint .` exit 0 |
| 3 | `pnpm -C fe-sso-test test` (trước khi thêm test) | `Test Files 30 passed (30)` / `Tests 236 passed (236)` |
| 4 | `pnpm -C fe-sso-test build` | exit 0, `✓ built in 332ms`; chunk: `index`, `router`, `production`, `env.app`, `rolldown-runtime` (không có chunk `Lab`) |
| 5 | `grep -rlE 'data-testid="lab-\|lab-tampered-state\|oidc:lab_\|lab-replay\|prompt-none-max-age-0\|Security lab\|runRefreshReplay\|checkStateTamper\|recordLabCallback' fe-sso-test/dist/` | **0 file** (grep exit 1); `"/lab"` 0 lần trong mọi chunk. Chỉ còn `labScenario` (3 lần, spread trong `beginLogin` — code chung) |
| 6 | `pnpm -C e2e typecheck` | `tsc --noEmit` exit 0 |
| 7 | `pnpm -C e2e e2e` lượt 1 | exit 0, **12 passed (48.2s)** — có màn consent `other` |
| 8 | `pnpm -C e2e e2e` lượt 2 (liên tiếp) | exit 0, **12 passed (42.5s)** |
| 9 | Quét output lượt 1 + 2 (206 dòng mỗi lượt): `code=` / `state=` / `eyJ` / cookie (`set-cookie\|cookie:`) / `refresh_token[:=]` | **0 / 0 / 0 / 0 / 0** cả 2 lượt |
| 10 | `pnpm -C be test` (hồi quy BE unit) | `Test Suites: 21 passed` / `Tests: 211 passed` |
| 11 | Test tester mới `npx vitest run test/lab-replay.test.ts` | `Tests 4 passed (4)` |
| 12 | Mutation trên `src/oidc/lab.ts` (bản sao trong scratchpad, khôi phục `cmp` byte-identical): M1 bỏ `clearTransient` trong `recordLabCallback`; M2 `pass: matches` (bỏ `issOk &&`); M3 bỏ `removeItem(LAB_EXPECT_KEY)` | **3/3 RED** (mỗi lượt `1 failed \| 3 passed`); `RESTORED_IDENTICAL` |
| 13 | `pnpm -C fe-sso-test test` + `lint` + `typecheck` sau khi thêm test | `Test Files 31 passed (31)` / `Tests 240 passed (240)`; lint exit 0; typecheck exit 0 |

Danh sách 12 test E2E (lượt 2, giống lượt 1):
`api-test.spec.ts` A/B/C (2.7s); `lab.spec.ts` redirect_uri mismatch ⇒ 400 không redirect; pkce-plain / no-code-challenge / resource-unknown / resource-relative / prompt-none-max-age-0 / prompt-none-no-session ⇒ PASS; no-nonce ⇒ IdP trả code, lab không đổi; state tamper ⇒ bị từ chối, 0 `/token`; refresh replay (cuối) ⇒ 3 bước PASS; `login.spec.ts` (hồi quy).

Ghi chú: log Vite in cảnh báo `No HydrateFallback element provided` mỗi lần tải trang (đã ghi DEBT-111, không ảnh hưởng kết quả).

## Test FAIL (nếu có)

Không có.

## Test bổ sung của tester

`fe-sso-test/test/lab-replay.test.ts` (4 test, chiều State/Replay chưa có trong test dev):
- replay cùng một lab callback lần 2 ⇒ không ghi gì, giữ nguyên verdict lần 1, transient đã tiêu (consume-once);
- `state` + `iss` khớp nhưng không có `error` lẫn `code` ⇒ `rejected`, không PASS;
- `no-nonce`: `code` + `state` khớp nhưng thiếu `iss` ⇒ FAIL (iss bắt buộc mới xanh);
- cờ tamper one-shot: callback forged-state thứ hai không còn được coi là kiểm tra lab.

## Coverage acceptance criteria

- [x] **Task 1 (a)** điều hướng Home→Profile→Tokens→ApiTest giữ session — `navigation.test.tsx:66`; E2E `api-test.spec.ts` đi `/profile → /api-test` bằng link không mất phiên.
- [x] **Task 1 (b)** `/callback?error=` xoá transient — `router.test.tsx:128` (DEBT-102).
- [x] **Task 1 (c)** mutation ⇒ RED — frontend-dev log (11/11); không chạy lại.
- [x] **Task 2** 3 bước replay với fetch giả, đúng/sai kỳ vọng ⇒ xanh/đỏ, không render token, 5xx/network ⇒ inconclusive đỏ — `lab.test.ts:242-340`, `Lab.test.tsx:72,102`; E2E `lab.spec.ts:73` (thật, đúng 2 exchange, không lộ secret).
- [x] **Task 3b** URL đúng từng kịch bản (đổi đúng 1 param từ `beginLogin`) — `lab.test.ts:54-93`; callback lab không `/token`, một lần, không lưu code/state — `lab.test.ts:95-183`, `router-lab.test.tsx:96,104`, `lab-replay.test.ts`; E2E `lab.spec.ts:10,37,49` (8 kịch bản thật, `iss` ok, 0 `/token`).
- [x] **Task 3c** state giả ⇒ từ chối, 0 `/token`, có đối chứng chống tautology — `lab.test.ts:185-240`, `router-lab.test.tsx:111`; E2E `lab.spec.ts:60`.
- [x] **F4** `/lab` không guard cấp route, ẩn danh thấy link sign-in — `router-lab.test.tsx:129`.
- [x] **F5** dev-only — `router-lab.test.tsx:80,85` + build/grep `dist/` (lệnh 4–5).
- [x] **Task 4** `pnpm -C e2e e2e` xanh 2 lần liên tiếp (lệnh 7–8); A 200 / B PASS 401 / C 200, `sub` trùng, không token trong DOM/storage/URL (`api-test.spec.ts`); log không chứa `code`/`state`/cookie/token (lệnh 9). Nhánh B ổn định ⇒ không cần hạ xuống A+C.

## Coverage security invariants / risk matrix

- [x] **Credential — replayed** (INV-10/11): replay RT cũ ⇒ `invalid_grant`, hậu duệ ⇒ `invalid_grant` — unit + E2E thật (BE log `TOKEN_REUSE_DETECTED` rồi 400, 400).
- [x] **Credential — malformed/forged state** (CSRF): state lệch ⇒ `rejected` (`lab.test.ts:140`), tamper qua `finishLogin` thật ⇒ 0 `/token` (unit + E2E).
- [x] **State — already consumed / retry**: replay lab callback, cờ tamper one-shot, `takeLabResult` one-shot — `lab-replay.test.ts`, `lab.test.ts:174,235`; mutation M1/M3 RED.
- [x] **Request chain — redirect/callback**: `iss` thiếu/sai ⇒ FAIL (`lab.test.ts:146`, `lab-replay.test.ts`; mutation M2 RED); E2E kiểm `iss` ok trên 6 kịch bản lỗi; nhánh B chuỗi redirect + khôi phục `prompt=none` xanh 2 lượt.
- [x] **Authorization — wrong audience** (INV-8): B ⇒ `/demo/me` 401 với token `other` (E2E).
- [x] **Input — injection payload**: `error=<script>` ⇒ `unknown_error`, `error_description` không được lưu (`lab.test.ts:103,153`).
- [x] **Dependency — unavailable**: `/token` 5xx/network ⇒ inconclusive đỏ (`lab.test.ts:307,326`); discovery lỗi ⇒ thông báo cố định (review senior).
- [x] **Exposure — DOM/storage/URL/log**: E2E `expectNoSecretsExposed` với mọi secret `/token` thu được; output E2E 0 khớp (lệnh 9); prod bundle không chứa lab (lệnh 5).
- [ ] Concurrency thật (2 tab replay song song) — không áp dụng: atomic rotate/revoke là bất biến BE đã có int-test các run trước; lab chỉ quan sát phản hồi.

## Debt

Không mở debt mới. Xác nhận lại DEBT-111 (cảnh báo `HydrateFallback`) và DEBT-110 (stdout webServer ~206 dòng/lượt) vẫn còn — đã có trong backlog.
