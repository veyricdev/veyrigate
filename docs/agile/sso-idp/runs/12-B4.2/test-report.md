# Test Report — 2026-10-08 (run 12 — B4.2 Consent)

## Kết quả: PASS (269/269 test: unit 67 + int 202)

Verify độc lập mọi acceptance criterion trong `tasks.md` + security invariants. Chạy thật
typecheck + lint + unit + integration trên hạ tầng `vg-test-mongo@27117` (rs0) +
`vg-test-redis@6479`. Thêm 5 test mới (concurrency union/over-grant, cross-user isolation,
re-grant version bump, 2 cross-session negative-actor ở wire). Không sửa code sản phẩm.

## Lệnh đã chạy + output thực tế

```
# 1) Typecheck
$ pnpm.cmd typecheck            -> $ tsc --noEmit ; EXIT=0

# 2) Lint
$ pnpm.cmd lint                 -> $ eslint src ; EXIT=0

# 3) Unit (.spec.ts)
$ pnpm.cmd test
  Test Suites: 12 passed, 12 total
  Tests:       67 passed, 67 total          ; UNIT_EXIT=0

# 4) Integration (.int-spec.ts, --runInBand)
$ pnpm.cmd test:int
  Test Suites: 13 passed, 13 total
  Tests:       202 passed, 202 total         ; INT_EXIT=0
```

Lưu ý env: int-spec mặc định dùng `mongodb://localhost:27117/...?directConnection=true` và
`redis://localhost:6479` — khớp đúng hạ tầng test đang chạy (docker ps xác nhận `vg-test-mongo`,
`vg-test-redis` Up). Script `test` chỉ chạy `.spec.ts`; `.int-spec.ts` chạy qua `test:int`
(override `--testRegex`).

## Test mới thêm (tester, run 12)

- `test/consent.int-spec.ts`:
  1. grant under heavy concurrency — 12 grant đồng thời (mỗi cái xin 1 allowed + 1 NOT
     allowed). Assert: đúng 1 bản ghi (unique key giữ dưới concurrency) + KHÔNG BAO GIỜ
     over-grant scope ngoài allow-list. => chứng minh DEBT-027 là fail-closed (mất union chỉ
     ép re-consent, không bao giờ cấp dư quyền).
  2. cross-user isolation — grant của user A không đọc được/không quy cho user B.
  3. re-grant version bump — re-consent dưới version mới update tại chỗ (1 bản ghi) và
     khiến `isCovered` dưới version hiện hành = true.
- `test/authorize.int-spec.ts` (wire negative-actor):
  4. cross-session + A's _csrf — B gửi `request_id` của A kèm `_csrf` của A -> 403
     (token bound A's identity), không code, không consent cho A hay B; context A còn nguyên.
  5. cross-session + B's own _csrf — B dùng `_csrf` hợp lệ của B submit `request_id` của A
     -> không bao giờ ghi consent cho A (nếu có code thì bind về B).

## Test FAIL (nếu có)

- (không có) — 269/269 xanh.

## Coverage acceptance criteria

### B4.2a (Consent store)
- [x] isCovered: đủ scope + đúng version -> true — consent.int-spec "isCovered: enough scope..."
- [x] thiếu 1 scope -> false — cùng case trên
- [x] version lệch -> false dù đủ scope — consent.int-spec "version drift => false"
- [x] grant 2 lần đồng thời cùng key -> đúng 1 bản ghi — "idempotent/atomic" + test mới #1 (12x)
- [x] 2 resource của cùng user×client -> 2 bản ghi độc lập; revoke 1 không ảnh hưởng cái kia
      — consent.int-spec "two resources ... independent"
- [x] Version hiện hành đọc từ config (env) — `currentVersions()` dùng `config.getOrThrow('consent')`

### B4.2b (Wire /authorize + trang consent + approve/deny -> issue code)
- [x] Signed-in + chưa consent -> GET /authorize trả 200 trang consent (có `_csrf`, liệt kê
      scope đang xin), KHÔNG issue code — authorize.int "signed in + no consent => 200..."
- [x] Approve hợp lệ -> 302 có `code` + `state` echo + `iss`=issuer; code consume được đúng
      client_id/redirect_uri — authorize.int "approve => 302 ... code consumable"
- [x] Deny -> 302 `error=access_denied` + state + iss, không code, không tạo Consent
      — authorize.int "deny => 302 ... NO code, NO consent record"
- [x] Đã covered -> GET bỏ qua trang, 302 trả code ngay — "already-covered consent => ... 302s a code"
- [x] prompt=consent dù đã có consent -> vẫn render trang — "prompt=consent still shows"
- [x] prompt=none + chưa consent -> 302 `error=consent_required` (không UI)
- [x] prompt=none + đã covered -> 302 trả code (success OIDC Core, không error)
- [x] Resource sentinel mapping (undefined->"") ở wire — covered/approve dùng find(..., undefined)
      trên bản ghi `resource=""` (public client)

## Coverage security invariants / risk matrix

| Chiều | Case đã kiểm | Test |
|---|---|---|
| Identity anonymous | no session | authorize "no session => /login" / "prompt=none no session => login_required" |
| Identity owner | session user approve | "approve => 302 ... consent persisted" |
| Identity other user | cross-session | mới #4, #5 |
| Credential _csrf | absent/malformed | "POST consent without a valid _csrf => 403" |
| Credential _csrf | cross-session token | mới #4 (A's token on B's session -> 403) |
| Authorization/IDOR | owner-only, cross-user bleed | consent mới #2; authorize mới #4/#5 (never consent for A) |
| Input | sentinel resource undefined->"" | consent "normalizeResource" + "public client" |
| Input | scope/resource/max_age/PKCE invalid | authorize post-redirect errors block |
| State | ctx single-use / replay | authorize "replay: second approve => 400 expired, no second code" |
| State | concurrent grant | consent "idempotent/atomic" + mới #1 |
| State | version drift / bump | consent "version drift", "bumping version", mới #3 |
| State | session gone GET->POST | authorize "POST consent after session gone => /login, never code" |
| Exposure | code/nonce/state/code_challenge not logged | authorize "audit event without sensitive values" |

- [x] INV (no over-grant): grant không bao giờ cấp scope ngoài allow-list — mới #1 (dưới concurrency)
- [x] INV (anti-parameter-swap): redirect_uri/state/scope/resource/client_id lấy từ ctx đã consume
      — authorize "approve => code bound client/uri"
- [x] INV (fail-closed prompt=none): không auto-approve — 2 chiều đã test
- [x] INV (replay): approve lần 2 cùng request_id fail-closed (400 expired, no 2nd code)
- [x] INV (cross-session): consent không bị điều khiển bằng replay form của user khác

## DEBT quan sát

- DEBT-027 (race union scope trong `grant`): kiểm empiric dưới concurrency 12x — fail-closed,
  không bao giờ over-grant; mất union chỉ ép re-consent vô hại. Rủi ro KHÔNG chặn
  (không bypass/over-grant/cross-tenant/mất dữ liệu) -> giữ là DEBT, KHÔNG FAIL.
- DEBT-028 (ops: drop index cũ khi deploy) — ngoài phạm vi test (test tự sync index).

## Verdict

PASS — bàn giao orchestrator đóng run. Không commit (theo yêu cầu).