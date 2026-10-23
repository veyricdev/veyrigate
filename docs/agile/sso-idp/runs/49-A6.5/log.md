# Log — run 49 — A6.5 Keys (+ DEBT-346/347)

## tech-lead — 2026-10-23

**Kết luận: PASS (có fold).** Đã đối chiếu code `c8216f3` qua CodeGraph. Fold được ghi vào `tasks.md`, review ở `review-techlead.md`.

- **Phạm vi**
  - Thêm Task 0 [BE]: OpenAPI response cho `KeyListViewDto`/`AdminKeyViewDto`/`RotateKeyResultViewDto` + snapshot + `gen:api`.
  - Task 1 gộp thêm DEBT-348 (cùng phần `Details` của `/audit`).
- **Sự thật**
  - Key chỉ có `active`/`retiring`. Cả đọc lẫn xoay đều chỉ super_admin, xoay cần step-up 5'. Thao tác không idempotent.
  - Khẩn cấp gỡ mọi key cũ, KHÔNG thu hồi phiên/RT.
- **Rủi ro phát hiện**: fe-admin `createRemoteJWKSet` có cooldown 30s ⇒ callback/refresh với `kid` mới bị từ chối ⇒ bắt buộc `cooldownDuration: 0` (F2), kiểm bằng E2E context B + mutation (F4).
- **E2E**: chỉ xoay thường; dialog khẩn cấp chỉ mở rồi Cancel; skip khi `E2E_REUSE=1` (tránh xoay `be/keys`).
- **Debt mới**: DEBT-349 (fe-admin cache JWKS 10' sau khi xoay khẩn cấp), DEBT-350 (audit xoay key chỉ hiện ở tenant của người xoay).
- **Tiếp**: backend-dev (Task 0) ‖ frontend-dev (Task 1 → 4).

## frontend-dev — Task 1 — 2026-10-23

- DEBT-346: nút Details `/audit` thêm sr-only " for {action} at {timestamp}"; test RTL (đúng 1 nút `Details for TOKEN_REUSE_DETECTED at …`), 6 matcher cũ `"Details"` ⇒ `within(row)` + `/^Details for /`.
- DEBT-347: xoá `adminKeys.audit.all`, bỏ prop `nextPage`, caption cố định "Audit events". DEBT-348: metadata trong `<section>` "Metadata" riêng, key `m:${k}`; test "fixed label" cập nhật.
- RED trước fix: 6 fail. Mutation: bỏ span ⇒ 6 RED; metadata về `<dl>` cố định ⇒ 1 RED; sha256 khôi phục byte-identical (`fbf262d2…`).
- Verify: typecheck 0 lỗi, lint 0, test 43 files / 1121 passed, build OK, check:bundle 0 hit. Không chạy E2E. Không đụng file Task 0.
- Tiếp: Task 2 (chờ snapshot Task 0).

## backend-dev — Task 0 — 2026-10-23

- `admin.views.ts`: `AdminKeyViewDto implements KeyMetadata` (kid; alg enum RS256; status enum active/retiring; createdAt DATE; retireAt NULLABLE_DATE), `KeyListViewDto {items, nextCursor: string|null}`, `RotateKeyResultViewDto {newKid, oldKid nullable, mode enum}`. `admin-keys.controller.ts`: chỉ thêm `@ApiOkResponse` cho GET/POST rotate; runtime không đổi (allowlist controller giữ nguyên, view không có key material).
- `admin.spec.ts`: test "keys: …" gọi controller thật với `rotation.list()` trả KeyMetadata + `n/e/d/pem/path` ⇒ keys output == schema properties (không lọt material), enum/required/nullable, `$ref` 2 route. RED trước fix (schema absent).
- Mutation: bỏ decorator `retireAt` ⇒ RED; bỏ `oldKid`/`nextCursor` ⇒ RED; bỏ cả field ⇒ tsc RED (`implements`); bỏ `@ApiOkResponse` rotate ⇒ RED. Khôi phục sha256 byte-identical (views `45e0d9cd…`, controller `4a6a18a5…`).
- Snapshot: :4000 không chạy ⇒ dựng in-process (7 controller, guard mock, spec tạm đã xoá). `admin.json` +96/−2 (2 `content` + 3 schema); `gen:api` ⇒ `schema.d.ts` +27/−2.
- Verify: be unit 32 suites/416; `test:int` 45/1215; be typecheck 0, lint 0, prettier OK; fe-admin typecheck 0. Không E2E. Tiếp: frontend-dev Task 2 (snapshot sẵn sàng) → senior-reviewer.

## frontend-dev — Task 2→4 — 2026-10-23

- T2: `features/admin-api/signing-keys.ts` (list GET không input, rotate POST `RotateKeyInput` `.strict()`), `schemas.ts` `SigningKey*`/`RotateKeyResultSchema` (strip), `client.ts` `listSigningKeys`/`rotateSigningKey`, `keys.ts` `signingKeys.list`, hooks `useSigningKeys(enabled)`/`useRotateSigningKey`; type test hai chiều status/mode; `instance.ts` `cooldownDuration: 0`. Test `signing-keys-fn` 21. Mutation `.passthrough()` ⇒ 1 RED; bỏ `.strict()` ⇒ 1 RED.
- T3: `routes/keys/index.tsx` + sidebar "Signing keys" (`FileKeyIcon`); `ConfirmAction` thêm `confirmText?` (disabled + chặn trong `confirm`, xoá khi đóng). Cảnh báo khẩn cấp 5 ý Q-49.1 + câu phiên console + link audit; uncertain ⇒ `{done}` so `kidBefore`. `keys-ui` 13 test. Mutation: bỏ cổng confirmText ⇒ 2 RED; uncertain gửi lại ⇒ 2 RED; bỏ gate super_admin ⇒ 1 RED. sha256 khôi phục byte-identical.
- T4: `e2e/tests/fe-admin-keys.spec.ts` (skip khi `E2E_REUSE=1`): rotate thường K1→K2, JWKS BE có cả hai, không `d/p/q/dp/dq/qi`; context B đăng nhập ngay ⇒ OK; dialog khẩn cấp chỉ mở/kiểm/Cancel. Mutation bỏ `cooldownDuration: 0` chạy riêng spec ⇒ RED (context B: `JWKSNoMatchingKey`, B `/token` 4,7s sau lần tải JWKS của A); khôi phục sha256 khớp.
- Verify: fe-admin typecheck 0, lint 0, test 45 files/1156, build OK, check:bundle 0 hit, gen:api không diff mới; root lint OK; e2e typecheck 0. E2E (cổng trống, không REUSE): spec riêng 1 passed (lần đầu timeout webServer 120s ⇒ DEBT-351), full 33 passed ×2. `be/keys` sha256+mtime y nguyên. Grep secret output: 0.
- Debt mới: DEBT-351. Tiếp: senior-reviewer.

## senior-reviewer — 2026-10-23

- **Kết luận: PASS** (0 🔴, 1 🟡 ponytail ⇒ DEBT-352, 5 💭). Chi tiết: `review-senior.md`.
- **Đã kiểm**:
  - Key material: chặn ở cả 3 tầng (BE allowlist, BFF zod strip, JWKS/E2E).
  - `confirmText`: khớp chính xác, xoá khi đóng, caller cũ không đổi. Double-click chỉ gửi 1 lần. Uncertain không gửi lại.
  - `cooldownDuration: 0`: verifier chỉ có 2 đường gọi, cả hai là back-channel `/token` (callback `bff.ts:185`, refresh `bff.ts:302`) ⇒ không có DoS JWKS do người ngoài chọn `kid`. DEBT-349 giữ mức 💭.
  - E2E: skip khi `E2E_REUSE`; `reuseExistingServer` tắt ⇒ không đụng BE dev; `e2e/.keys` đã gitignore.
- **Chạy lại**: fe-admin typecheck 0; vitest 5 file / 72 passed; BE `admin.spec` 29 passed. Không chạy E2E.
- **Tiếp**: tester.

## tester — 2026-10-23

- **Kết luận: PASS [FE][BE]**. Chi tiết và output nằm trong `test-report.md`.
- **Test thêm** (không sửa code sản phẩm):
  - `fe-admin/test/keys-ui-risk.test.tsx` (30 test):
    - Cổng `EMERGENCY` với 11 biến thể look-alike/khoảng trắng, dán, Enter, gõ từng phím, pending.
    - Role gate: 7 biến thể và điều hướng trong app.
    - Key material ở DOM, query cache và notice.
    - Step-up không để lại dấu vết.
    - Uncertain khi chưa có list; characterisation `kidBefore`.
    - Không có câu sai sự thật trong cả hai dialog.
  - `fe-admin/test/signing-keys-fn-risk.test.ts` (20 test): material không lộ ra kết quả/log ở các ca lỗi; input `__proto__`/NUL/Cyrillic/… ⇒ 0 call BE.
  - `be/test/admin-keys.int-spec.ts` "run 49 QA" (6 test): BE từ chối 5 biến thể `mode`; chuỗi normal x2 rồi emergency ⇒ gỡ cả key active lẫn key retiring, audit đúng `mode`/`oldKid`.
- **Mutation** (khôi phục sha256 byte-identical):
  - So sánh NFKC/trim/upper ⇒ 6 RED.
  - Enter gửi ⇒ 1 RED.
  - Kiểm role lỏng ⇒ 3 RED.
  - `.passthrough()` ⇒ 1 RED.
  - BE emergency giữ key retiring ⇒ 4 RED.
- **Số liệu**:
  - fe-admin: typecheck/lint/build/check:bundle exit 0; test 47 file / 1206; `gen:api` không diff.
  - Root: lint 0, typecheck 0, audit 0 (2 low).
  - Root `pnpm test`: lần 3 xanh. Lần 1–2 có flake khi chạy song song ở phần ngoài diff ⇒ DEBT-355.
  - BE: unit 416, int 45 suites / 1221.
  - E2E: 33 passed (cổng trống, không REUSE), trong đó có `fe-admin-keys`.
- `be/keys`: sha256 và mtime không đổi. Grep secret trên log: 0.
- **Debt mới**: DEBT-353 (nit `kidBefore`), DEBT-354 (dialog chờ lần đọc list đang chạy dở), DEBT-355 (flake khi chạy root song song). Cả ba mức 💭.
- **Tiếp**: orchestrator đóng run.
