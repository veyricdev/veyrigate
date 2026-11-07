# Test Report — 2026-11-07 (run 75, tester)

## Kết quả: PASS

| Gate | Lệnh | Kết quả thật |
|---|---|---|
| 1 | `pnpm -C be typecheck` + `pnpm -C be lint` | exit 0 / exit 0, không lỗi |
| 2 | `pnpm -C be test` | 41 suites, **679/679** |
| 3 | `pnpm -C be test:int` (FULL, in-band) | 57 suites, **1497/1497** (1494 dev + 3 tester), 539.8 s, exit 0, không có dòng "Jest did not exit" |
| 4 | `pnpm -C fe-admin test` | 67 file, **1567/1567** |
| 5 | `pnpm -C e2e e2e` | **37 passed** (4.3 m), exit 0 |
| 6 | `pnpm -C e2e e2e:x3` | **42 passed** (9.4 m), exit 0 |

- Chạy tuần tự. Cổng 4000/5173/3000 trống trước E2E và sau E2E; 4100/5273/5274/8443 trống trước X3 và sau X3. `pnpm dev` người dùng không chạy lúc đo, không dừng process nào.
- DB `vg-int-*` trên `vg-test-mongo`: **4 trước → 4 sau** (đều là `vg-int-vault-v7-*` cũ, đã biết).
- Log WebServer trong E2E (`federation failed: invalid_state`, `federation link failed: credentials`, fe-admin `server function failed`) là ca âm chủ đích của suite, không phải lỗi.

## Lệnh đã chạy + output thực tế

1. Spec run 75 riêng (sau khi thêm test tester): 3 lượt liên tiếp `Tests: 18 passed, 18 total`.
2. Gate 1–6 ở bảng trên (dòng tổng kết copy nguyên văn).
3. Runbook §12 q1–q3 (sau sửa DEBT-516), `mongosh --file` trên `aegate-mongo` DB `sso-idp-e2e`, `ISSUER=http://localhost:4000`. Script trích từ khối ```js của runbook, đã kiểm bằng regex không có `$out`/`$merge`/`insert*`/`update*`/`delete*`/`drop*`/`replace*`/`findOneAnd*`/`bulkWrite`/`createIndex*`:
   - `q1: [{ resourceId: 'admin', scopes: ['admin.read','admin.write'] }], ok: true`
   - `q2: []`
   - `q3: { narrow: 0, revoke: 0, samples: [] }`
   - Không chạm DB dev `sso-idp`.
4. Chứng minh q2 mới bắt đúng ca DEBT-516 (không ghi DB nào): cùng các stage `$unwind`/`$project`/`$match` của runbook chạy trên `$documents` trong bộ nhớ (Mongo 7.0.41). Client `c1` có `allowedResources [a, b]`, scope `x` chỉ ở `a` ⇒ kết quả `[{ clientId: 'c1', resource: 'https://b/', lost: ['x'] }]`. q2 cũ (hợp scope mọi resource) cho `[]` ở ca này. Client không có resource không bị liệt kê (không thu hẹp gì).

## Test FAIL (nếu có)

Không có. Lần chạy đầu, test mới (t2) của tester FAIL do assert của chính tester sai: tester kỳ vọng 1 successor ⇒ 1 response 200. Thực tế, khi refresh song song, request thua bị coi là reuse (ngữ nghĩa có sẵn từ trước run 75) và revoke cả family, nên request thắng cũng nhận `invalid_grant` (fail closed). Đã sửa assert theo đúng bất biến: không response và không RT nào mang scope đã gỡ, tối đa 1 successor, không còn 200 thì mọi doc đều bị revoke. Code sản phẩm không đổi.

## "Jest did not exit" (yêu cầu 3) — KHÔNG phải hồi quy run 75

- Lần full int này **không** in cảnh báo (exit 0 ngay sau dòng tổng kết).
- Khi chạy riêng một spec dùng Nest app, cảnh báo có xuất hiện, nhưng ở cả spec run 75 lẫn spec cũ:
  - Working tree: `run75-resource-scopes` có, `introspect` (file không bị sửa) có, `refresh-token` có, `token` có, `session-reflection` có. `token-code-recheck`, `authorize`, `userinfo` thì không.
  - **Baseline HEAD `5fafa48`** (git worktree tạm ở scratchpad, node_modules junction, đã gỡ): `introspect`, `refresh-token`, `token` **đều đã có** cảnh báo, exit 0.
- Chẩn đoán: `process.getActiveResourcesInfo()` 1,5 s sau `afterAll` chỉ còn 1 `Timeout` (không còn socket TCP Mongo/Redis). Cảnh báo không phụ thuộc test case nào (thử từng ca a/r1/r7/t3 riêng đều có), tiến trình tự thoát exit 0 sau vài giây.
- Kết luận: hành vi có sẵn trước run 75, chỉ hiện khi chạy riêng spec. Full suite vẫn tự thoát (đúng DEBT-054 run 61). **Không mở debt mới.** Code chẩn đoán đã gỡ: file được khôi phục từ backup, `grep RES0|HANDLES` = 0.

## Coverage acceptance criteria

- [x] Unit `grantableScopes` 4 ca (giao, OIDC với resource `[]`, không có resource, resource có client không có) — `be/src/modules/oauth/scope-policy.spec.ts`.
- [x] T1 authorize/consent (a)–(f), (f) assert DB `consents.grantedScopes` — `run75-resource-scopes.int-spec.ts`.
- [x] T1 code exchange (c1) resource bỏ scope, (c2) client bỏ scope ⇒ `invalid_grant` + audit `scope_not_allowed` — như trên.
- [x] T1 guard resource `admin` (g) 3 biến thể thiếu ⇒ 400, DB không đổi, không audit; (g2) giữ đủ ⇒ 200, resource khác về `[]` ⇒ 200 — `admin-api.int-spec.ts`.
- [x] T2 refresh (r1)–(r7): thu hẹp ở response, claim AT và doc RT kế nhiệm; thêm lại không sống lại; (i)/(ii)/(iii) ⇒ revoke, 1 audit, 0 reuse; requested ngoài giao ⇒ `invalid_scope`, RT còn sống; revoke lỗi ⇒ 500 không lộ chi tiết — `run75-resource-scopes.int-spec.ts`.
- [x] T3 fe-admin: chuỗi hint "Enforced: …" + aria-describedby; PATCH `admin` 400 ⇒ alert đúng mô tả, không `unsure` — `fe-admin/test/resources-ui.test.tsx` (trong 1567).
- [x] T4 runbook §12 q1–q3 chạy read-only trên `sso-idp-e2e` (đã sửa q2, DEBT-516).
- [x] Hồi quy: int full 1497, E2E 37, X3 42 (authorize đổi ⇒ X3 bắt buộc).
- [x] Mutation M1–M9: theo log backend-dev, tester không chạy lại.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp | Test |
|---|---|---|
| Authorization: owner / non-owner | Client B (kể cả khi được phép trên resource của nạn nhân) gửi RT của client A sau khi resource A về `[]` ⇒ `invalid_grant`, family A KHÔNG bị revoke, 0 audit `scope_not_allowed`; chính chủ gửi ⇒ refuse như (r3) | **(t1) mới** |
| State: concurrent | 3 refresh song song cùng RT sau khi thu hẹp ⇒ không response hay RT nào chứa `api.write` (trừ doc gốc), tối đa 1 successor, nếu không có 200 thì cả family bị revoke | **(t2) mới** |
| State: concurrent + refuse | 3 refresh song song sau khi resource về `[]` ⇒ cả 3 `invalid_grant`, không phát token, không successor, family revoke, 0 `TOKEN_REUSE_DETECTED` | **(t3) mới** |
| State: replay | Gửi lại RT đã bị refuse ⇒ `invalid_grant` thường, 0 reuse | r3, r5, r7 |
| State: stale (đổi cấu hình giữa chừng) | resume sau login, consent render→approve, code đã cấp | e, f, c1, c2 |
| Input: scope ngoài giao / union | a, d, r6 | dev |
| Dependency: failure | `revokeFamily` reject ⇒ 500 fail closed, giữ audit | r7 |
| Exposure | body không lộ RT/chi tiết lỗi; audit không chứa RT (`expectNoIssued`, `not.toContain(rt)`) | r3, r7, c1, t1, t3 |
| Authorization: tự khoá | guard `admin.*` | g, g2 |

Không còn invariant bảo mật nào chưa có bằng chứng. Không mở debt mới.

## File tester đổi

- `be/test/run75-resource-scopes.int-spec.ts`: +describe `tester: negative actor + concurrency` (t1–t3).
- `docs/agile/sso-idp/runbook-deploy.md` §12 q2 (DEBT-516; 556 → 560 dòng, LF giữ nguyên).
- `docs/agile/sso-idp/backlog.md` DEBT-516 ⇒ ĐÓNG run 75 (535 → 535 dòng).
- `runs/75-resource-scopes/test-report.md`, `log.md`, `STATUS.md`.
