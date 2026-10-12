# Senior Review — 2026-10-12 (run 16, B4.7) — Lượt 3 (cuối)

## Kết luận: PASS

Chuyển sang **tester**. 🔴 cuối cùng của lượt 2 (thiếu bằng chứng cho thứ tự stamp-first của INV-11) đã đóng. Tôi đã tự chạy lại mutation để xác nhận. Không phát sinh 🔴 mới. Các 🟡 còn mở đã ghi vào `backlog.md` (DEBT-043 mở rộng, DEBT-045, DEBT-046).

## Tổng quan

Đã chạy lại trên vg-test-mongo/redis: `tsc --noEmit` OK, `pnpm lint` (`eslint src`) OK, unit **123/123**, int **346/346**.

**Mutation lượt 3** (sửa tạm, chạy test, khôi phục và đối chiếu sha256 trước/sau `8d04c36e…1bd4`, byte-identical):

| # | Mutation | Kết quả | Kết luận |
|---|---|---|---|
| M2' | `revokeWhere`: chuyển stamp `familyRevokedAt` xuống **sau** `revokedAt` (giống hệt M2 lượt 2) | refresh-token.int-spec: **344 pass / 2 fail**. Đúng 2 test `ordering (INV-11)` ({userId}, {userId,sessionRef}) fail: `Expected 400, Received 200` (S sống sót) | 🔴 lượt 2 đóng ✅ |

Điểm tốt:
- `gateInsertBeforeAndFirstUpdate` (refresh-token.int-spec.ts:~L184–260) làm đúng interleaving nguy hiểm: park A **trước** insert S, park B ngay **sau** lần ghi `updateMany` đầu tiên (bọc `exec`). Test tất định, không dùng timer.
- Assert đủ chặt. A nhận `400 invalid_grant`, mọi doc của family có `revokedAt`, parent có `familyRevokedAt`. Comment giải thích rõ vì sao S không cần stamp.
- Vì `revokeFamily` (B4.5) dùng chung `revokeWhere`, guard thứ tự này cũng bảo vệ luôn đường `/revoke` và reuse. Việc gap từ B4.5 (nêu ở lượt 2) vì thế cũng đã đóng, không cần DEBT riêng.
- Tên test L996 + comment L1001–1002 đã sửa đúng: test này chỉ chứng minh "cả hai stamp đều được ghi", còn thứ tự do test ordering chứng minh.
- 🟡 lượt 2 đã sửa:
  - `redirect-uri.validator.spec.ts` L55–83 có 3 case âm (`;`, `,`, `%3B`) + 1 case dương (IPv6 `[2001:db8::1]`, IDN punycode).
  - POST /logout nhánh no-session (ui.controller.ts:L226–241) giờ fail-open: `try/catch` → `defaultRedirect`, kèm test ui.int-spec.ts:L897. Cookie được clear **trước** `try`. `defaultRedirect` là hằng relative, nên không tạo open-redirect. Không log hint.

## 🔴 Blocker

Không còn.

- [x] Thứ tự stamp-first INV-11 có test bắt hồi quy (M2' → 2 FAIL).

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả |
|---|---|
| INV-11 rotate↔`revokeWhere` (3 scope: family, user, user+session) | ✅ Re-read guard (M3), kế thừa scope (M4), **thứ tự stamp-first (M2')** đều có bằng chứng. Code `revokeWhere` không đổi so với lượt 2 (hash khớp) |
| Guard filter rỗng | ✅ (M1 lượt 2, code không đổi) |
| Fail-closed POST /logout có session (token → session → audit → clear) | ✅ (M5 lượt 2, không đổi) |
| Fail-open sau revoke + nhánh no-session | ✅ Cả 2 nhánh catch → hằng `defaultRedirect`. Nhánh no-session không có gì để hủy nên fail-open đúng. Không lộ hint/lỗi |
| Open redirect / CSP front-channel / validator | ✅ Không đổi code validator. Spec mới khoá thêm hành vi `;`/`,`/`%3B` và case dương IPv6/IDN |
| Exposure | ✅ Catch mới không log, không phản chiếu input |

## 🟡 Nên sửa (đã ghi backlog)

- **DEBT-043 cũng áp dụng cho local logout** (mở rộng mô tả). Code mint trước khi logout (Redis TTL 60s) vẫn đổi được thành family mới mang `sessionRef` của session đã chết. Hướng sửa trong DEBT-043 (`/token` kiểm session còn sống theo `sessionRef`, fail-closed) xử lý được cả 2 trường hợp.
- **DEBT-045: lint không phủ `test/`.** Script `lint` = `eslint src`. `npx eslint src test` báo 2 lỗi prettier: refresh-token.int-spec.ts:L148 (chữ ký `gateInsert`) và ui.int-spec.ts:L882. Không phải lỗi logic, nhưng code test không được gác format/rule nên lỗi sẽ tích tụ dần. Cân nhắc đổi thành `eslint src test` và chạy `--fix`.
- **DEBT-046: ponytail + nit tồn từ lượt 1–2** (gộp 1 dòng): `forwardRef` thừa (ui.module.ts:L1,L10–12), đọc `findByClientId` 2 lần (logout.service.ts:L66), early-return thừa (session.service.ts:L245), comment "No length cap" mâu thuẫn với `@Length(0,4096)` (ui.controller.ts:L55), lý do cast ObjectId trong comment chưa đúng (refresh-token.service.ts:L397).

## 💭 Nit

- refresh-token.int-spec.ts:L146 (doc của `gateInsert`): "proves the mark-then-check guard self-revokes S for ANY interleaving" là nói quá. Helper này chỉ phủ trường hợp S đã tồn tại, còn thứ tự do `gateInsertBeforeAndFirstUpdate` chứng minh. Nên sửa thành "for the S-already-exists interleaving".
- Retry sau khi `sessions.revoke` lỗi sẽ mất `TOKEN_REVOKED` (giữ như lượt 1–2). Tester/summary nên ghi lại.

## ✂️ Ponytail

Diff lượt 3 (helper + 2 test, 4 case validator, try/catch no-session + 1 test): gọn, không có gì thừa. Các mục lượt 2 vẫn còn, đã gộp vào DEBT-046:

- be/src/modules/ui/ui.module.ts:L1,L10-12: yagni: `forwardRef` + comment. Import `OauthModule` trực tiếp.
- be/src/modules/oauth/logout/logout.service.ts:L66-67: delete: lần đọc `findByClientId` thứ 2. Cho `verifyHint` trả luôn `client`.
- be/src/modules/sessions/session.service.ts:L245: delete: `if (sessions.length === 0) return [];`.
- be/src/modules/oauth/logout/logout.service.ts:L34: shrink: `defaultRedirect` public → hằng module.

net: -5 lines possible.

## Lịch sử

- Lượt 1: REJECT (6 🔴).
- Lượt 2: REJECT. 5/6 🔴 đóng. Thứ tự stamp-first chưa có test (M2 xanh).
- Lượt 3: PASS. M2' → 2 test ordering FAIL. 🟡 validator spec + no-session fail-open đã sửa.