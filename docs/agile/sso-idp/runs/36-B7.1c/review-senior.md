# Senior Review — 2026-10-20

> Run 36 (B7.1c). Phạm vi: diff chưa commit từ `1e8573c` trong `be/` + docs (bỏ `.github/agents`, `.vscode`, `.mcp.json`, `.claude/`). Đọc code qua CodeGraph + `git diff`. Tự chạy: `pnpm -C be typecheck` sạch; `pnpm -C be test` 317/317; `test:int` 5 suite chạm (`token-code-recheck`, `ui-auth`, `federation`, `oauth-tenant-isolation`, `admin-users`) 185/185.

## Kết luận: PASS

## Tổng quan

Diff gọn và bám sát fold G0–G8. Cả ba điểm chặn đều theo một mẫu: ghi trạng thái (rotate/establish/insert) trước, đọc lại sau. Mẫu này đối xứng với phía huỷ ("ghi state trước, quét sau"), nên không interleaving nào để lọt family/session. Điểm tốt:
- G1 làm đúng. `subjectFailure` chỉ coi khoá admin (so sánh chính xác `ADMIN_LOCKED_UNTIL`) hoặc user mất là `user_locked`. `recordFailedLogin` chỉ đặt `lockedUntil` khi đang không khoá, nên brute-force không thể hạ khoá admin xuống thành khoá tạm để lọt qua grant. Có test âm cho cả code grant lẫn refresh (tạm khoá ⇒ 200, family sống). Mutation M8 `> now` ⇒ đỏ.
- `recheckAfterRotate` chạy TRƯỚC `signTokensForRefresh`. Khi bị từ chối, không có token nào được ký. Successor đã insert bị `revokeFamily` quét theo `familyId`. Nếu revoke ném thì successor sống trong DB nhưng giá trị chưa từng rời server, nên vô hại.
- Refactor `refuseGrant`/`failClosed` giữ nguyên số audit ở mọi nhánh. Catch dùng `true` thay `!!familyId`, tương đương vì chỉ chạy khi có `familyId`. Nhánh `session_ended` vẫn có `TOKEN_REVOKED` riêng. `return this.failClosed(...)` không nằm trong try ngoài nào, nên rejection không bị nuốt.
- Login/federation: post-check đặt trước `AUTH_LOGIN_SUCCESS`/`SESSION_CREATED`. Nhánh từ chối không tăng counter và trả cùng thông điệp chung. Cookie chỉ được set sau khi service trả về, nên không có cookie. Test đã kiểm `sessions.exists(sha256(id)) === false`, `listByUser` rỗng và body 401 trùng với body sai mật khẩu.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Identity / khoá (G1)**: khoá admin ⇒ grant chết (code + refresh, race spy gọi bản gốc trước). Khoá tạm ⇒ grant sống, không có DoS lockout giết `offline_access`. Login chặn mọi khoá. Admin lock sau `establish` ⇒ session chết (cả password, federation và link c2).
- **Authorization / tenant**: `not_member` lấy tenant từ client đọc lại (INV-24) ở cả refresh lẫn code grant. Ở `admin-users`, user rời tenant B ⇒ refresh B bị từ chối và family B bị revoke (thay đổi có chủ đích, ghi log).
- **State / concurrency**: refresh theo thứ tự rotate → recheck → revoke family → audit → `RefreshRotationError`. Replay token cũ ⇒ không có token (`invalid_grant`, hoặc `invalid_client` khi client bị disable). Xem 🟡 DEBT-215 về phân loại reuse.
- **Failure behavior**: lỗi DB khi recheck refresh ⇒ revoke best-effort, audit `recheck_failed` best-effort, 500. Login/federation lỗi DB ⇒ revoke session best-effort, 500, không cookie, không lộ `secret-detail` (có test).
- **Exposure / oracle**: body refresh bị từ chối byte-identical với token rác. Audit chỉ có `reason`/`resource`/`familyId`, không có token (có assert). `access_denied` not_member byte-identical với deny thật ở cả GET `/authorize` lẫn POST approve (DEBT-211). Federation `account_locked` KHÔNG tạo oracle mới: `loginExisting` vốn đã trả trang này trước run 36, và muốn tới được trang thì phải xác thực upstream đúng identity đã liên kết (tức chính chủ). Nó không dùng để dò email được.
- **Boundary input**: DEBT-210 dùng đúng predicate `decideConsent` (`adminTargetForbidden` + `resolveForClient` theo `resourceId`), không so URI với `resourceId`.

## 🟡 Nên sửa (không chặn — đã vào backlog)

🟡 **[BE] Báo reuse giả sau khi refresh bị từ chối sau rotate (DEBT-215)**
`refresh-token.service.ts` `recheckAfterRotate` (~L246–264) kết hợp với `classifyMiss` (`isReuse = revokedAt && replacedBy`).
Vì sao: sau khi bị từ chối (nhất là 500 `recheck_failed`, nơi RP thường retry), doc cũ ở trạng thái `revokedAt` + `replacedBy`. Retry bằng token cũ vì vậy bị coi là reuse và ghi `TOKEN_REUSE_DETECTED` (count 0). SOC nhận cảnh báo "token bị trộm" sai. Không có bypass vì family đã chết. Cùng lớp với DEBT-032 có từ trước.
Đề xuất: đánh dấu doc cũ khi successor không được giao (ví dụ `undeliveredAt`) để `classifyMiss` coi là invalid thường. Thêm assert "0 `TOKEN_REUSE_DETECTED`" sau bước replay trong `expectRefreshRefused`.

🟡 **[BE] Refresh không kiểm lại resource theo client đọc lại (DEBT-216)**
`token.controller.ts:399–403`: callback đọc lại client nhưng chỉ dùng `tenantId`. `rotate` lọc `resource $in identifiers`, mà identifiers được resolve từ client nạp lúc client-auth.
Vì sao: admin gỡ resource giữa client-auth và `rotate` thì vẫn ra 1 AT với aud cũ (≤15') cộng 1 successor (lần refresh sau sẽ hỏng). Đối xứng với DEBT-210 ở code grant. Cửa sổ rất hẹp và cần quyền admin.
Đề xuất: truyền `result.resource` vào `recheck` và áp cùng predicate DEBT-210, hoặc chấp nhận và gộp vào DEBT-156 (AT ≤15').

## 💭 Nit

- [test] `admin-users` đổi 3 test (vượt G4) từ "refresh B ⇒ 200" sang `familyUntouched` (đếm doc `revokedAt: null` = 1). Đây là oracle đúng cho mệnh đề "admin A không đụng family B", đọc thẳng từ DB, không che lỗi thật: nếu admin A revoke thì count = 0 ⇒ đỏ. Chấp nhận.
- [test] `ui-auth` xoá `rl:*` trước mỗi test khối DEBT-154: `test:int` chạy `--runInBand` với khoá `vg:int-lock`, và mẫu này đã có ở `client-auth-rate-limit`/`introspect`. Không che test rate-limit nào. Chấp nhận.
- [test] `token.int-spec` cho client giữ `res-api`: fixture trước đây thiếu resource thật (code mint thẳng vào Redis). Đây là sửa fixture đúng, không nới kiểm.
- [BE] `token.controller.ts` import `ResourceService` nằm giữa các import `../code` và `../consent` (thứ tự). Linter lo được, bỏ qua.

## ✂️ Ponytail

- be/src/modules/authentication/authentication.service.ts:L162: shrink: khối đọc lại user + revoke-on-throw + điều kiện khoá lặp gần nguyên văn với federation.service.ts:L193. Gom thành 1 helper (vd. `lockedOrGoneAfterEstablish(userId, sessionId)`), mỗi nơi chỉ giữ phản hồi riêng (DEBT-217).
- be/src/modules/oauth/token/refresh-token.service.ts:L266: shrink: hai nhánh `try { revokeFamily } catch { refuse().catch; throw }` + `refuse` có thể dùng chung 1 hàm `revokeThenAudit(reason, strict)`. Lợi rất nhỏ, chỉ làm nếu chạm lại.

net: -12 lines possible.
