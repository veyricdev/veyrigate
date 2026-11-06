# Test Report — 2026-11-06 (run 67, tester)

## Kết quả: PASS — BE PASS, FE PASS

Sentinel 3/3 xanh (mutation 3/3 đỏ); int 1420/1420; unit be 630/630; vault 31/31; fe-admin 1533/1533; tsc/lint be + fe-admin exit 0. File production = HEAD (`git diff --quiet be/src fe-admin/src` exit 0).

## Lệnh đã chạy + output thực tế

### Case 1 — DEBT-478 sentinel (`up` → `pnpm -C be test:sentinel` → `down`, script loop ở scratchpad)
Bản sửa (diff hiện tại), 3 lượt liên tiếp:
```
fix run1 rc=0 [write after 3019 ms] [Tests: 2 passed, 2 total] no-good-slave=0
fix run2 rc=0 [write after 3311 ms] [Tests: 2 passed, 2 total] no-good-slave=0
fix run3 rc=0 [write after 2836 ms] [Tests: 2 passed, 2 total] no-good-slave=0
```
Mutation: backup `cp` NGAY trước; xoá dòng 35 `--add-host "vg-b73c-redis-a:$(ip vg-b73c-redis-a)" \` của redis-b. Kiểm áp dụng thật: `diff backup file` = `35d34 < --add-host "vg-b73c-redis-a:…"`, `grep -A2 'name vg-b73c-redis-b'` không còn add-host, `bash -n` OK. (Lần sed đầu theo pattern KHÔNG khớp — `cmp` báo unchanged — nên đã phát hiện và áp lại bằng số dòng trước khi chạy.)
```
mut run1 rc=1 [write after 15337 ms] [Tests: 1 failed, 1 passed, 2 total] no-good-slave=2
mut run2 rc=1 [write after 16079 ms] [Tests: 1 failed, 1 passed, 2 total] no-good-slave=2
mut run3 rc=1 [write after 15510 ms] [Tests: 1 failed, 1 passed, 2 total] no-good-slave=2
```
Restore: `cp backup` → `cmp` = backup chụp ngay trước mutate (`restored-eq-backup`). Sau cùng `docker ps -a | grep vg-b73c` rỗng, network `vg-b73c-net` không còn.

### Case 2 — DEBT-477 BE, mutation test-side (5 điểm trong 4 spec)
Backup 4 file + `git diff be/test` trước mutate. Mỗi điểm nối `MUT==='cursor' ? 'eyJ0IjoxfQ' : leakForms(issued.at(-1)!)[MUTK]` vào text đang kiểm:
- P1 `token-code-recheck` ca exposure DEBT-388 — `r.body` (`:957`, token cuối = token của refresh bị từ chối đã ký rồi bỏ)
- P2 `token-code-recheck` ca exposure — `logs.join('\n')` (`:962`, cô lập bằng `MUTLOGONLY`: body nhận cursor, log nhận leak)
- P3 `token-code-recheck` DEBT-067 — `res.body` (`:975`)
- P4 `b73c-tester` `contract()` — `hasIssued(res.body + …)`
- P5 `run56-tester` `expectInvalidGrant` — `res.body`
- P6 `run55-tester.vault-spec` V3 — `JSON.stringify(events) + leakForms(at)[k]` (`at` = access token admin đã phát hành)

`pnpm -C be test:int '(token-code-recheck|b73c-tester|run56-tester)[.]int-spec'`:
```
leak0   (raw)          rc=1 Tests: 11 failed, 77 passed, 88 total   (recheck :957 + :975 đỏ)
leak3   (base64url)    rc=1 Tests: 11 failed, 77 passed, 88 total
leak1   (signature)    rc=1 Tests: 11 failed, 77 passed, 88 total
cursor  eyJ0IjoxfQ     rc=0 Tests: 88 passed, 88 total
logonly (base64, log)  rc=1 Tests: 11 failed, 77 passed, 88 total   (recheck :962 đỏ, :957 không)
```
11 đỏ = recheck 2 (exposure, DEBT-067) + b73c 7 (R1×2, R2×2, R3, V1, V2: "token in body") + run56 2 (D1, D2).

Vault throwaway `vg-b73-vault` theo đúng START của `be/test/vault-preflight.mjs` (token `openssl rand -hex 16` trong file scratchpad umask 077, không in; file đã xoá). `pnpm -C be test:vault 'run55-tester[.]vault-spec'`:
```
leak0  (JWT thô)       rc=1 Tests: 3 failed, 2 passed, 5 total   (:282, 3 ca V3)
leak3  (base64url)     rc=0 Tests: 5 passed, 5 total             (xem Ghi chú 1)
cursor eyJ0IjoxfQ      rc=0 Tests: 5 passed, 5 total
```
Restore: copy backup → `cmp` từng file OK; `git diff be/test` y hệt bản chụp trước mutate (`be-test-diff-identical`); `grep MUTF` = 0.

### Case 3 — DEBT-477 FE, mutation production `fe-admin/src/server/auth/bff.ts` (catch của `refreshGrant` trong `doRefresh`)
Backup ngay trước; chèn `console.error` theo `FEMUT`. `pnpm -C fe-admin test log-canary`:
```
rt     (RT thô)                rc=1 Failed Tests 2  (refresh 400/500, expectCleanLogs :51)
at64   (AT base64url)          rc=1 Failed Tests 2
idsig  (chữ ký ID token)       rc=1 Failed Tests 2
cursor ('next=eyJ0IjoxfQ')     rc=0 Tests 4 passed (4)
```
Restore `cp backup`; `git diff --quiet be/src fe-admin/src` exit 0.

### Case 4 — Regression
```
pnpm -C be test:int     Test Suites: 53 passed, 53 total; Tests: 1420 passed, 1420 total (487.8 s)
vg-int-* (vg-test-mongo) trước 4 → sau 4 (+0)
pnpm -C be test         Test Suites: 39 passed; Tests: 630 passed, 630 total
pnpm -C be test:vault   Test Suites: 5 passed; Tests: 31 passed, 31 total   (sau đó docker rm -f vg-b73-vault)
pnpm -C fe-admin test   Test Files 66 passed (66); Tests 1533 passed (1533)
be typecheck rc=0 | be lint rc=0 | fe-admin typecheck rc=0 | fe-admin lint rc=0
```

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] Task 1 DEBT-478 — case 1 (≥ 3 xanh liên tiếp, no-good-slave=0; mutation ⇒ đỏ 3/3 với `-failover-abort-no-good-slave`; restore = backup; `vg-b73c-*` sạch)
- [x] Task 2 DEBT-477 BE — case 2 (leak ⇒ RED ở raw/signature/base64/base64url; cursor ⇒ GREEN; DEBT-388 `issued.length` tăng — test xanh ở int full); case 4
- [x] Task 3 DEBT-477 FE — case 3 (3 dạng rò từ production ⇒ RED; cursor ⇒ GREEN); case 4

## Coverage security invariants / risk matrix
- [x] Exposure × response body (P1, P3, P4, P5), log (P2, FE case 3), audit (P6)
- [x] Encoded payload: raw / signature-only / base64 / base64url (k=0..3) vs cursor base64url JSON `eyJ0IjoxfQ` (không đỏ giả)
- [x] State: token đã ký rồi bị bỏ (DEBT-388, refused/failed/revokeFamily throw) — token cuối trong `issued` là token bị bỏ, vẫn bị bắt
- [x] Dependency: Redis blackhole/refuse, key provider down (b73c), Vault down (run55 V3), Docker DNS stall (sentinel)

## Ghi chú (không chặn, không debt mới)
1. `run55-tester.vault-spec` V3 dùng regex hình dạng JWT 3 phần (đúng fold: ca rotate lỗi không ký token): bắt JWT thô, KHÔNG bắt dạng base64url của JWT — bằng HEAD (`/eyJ|hvs\./` cũng không bắt `ZXlK…`), nên không phải hồi quy.
2. Token in ra trong log mutation FE là token giả của fake IdP; không trích vào báo cáo.
