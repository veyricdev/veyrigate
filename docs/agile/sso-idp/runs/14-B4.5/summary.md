# Summary — B4.5 (M4 refresh grant + rotation + reuse detection + `/revoke`) — ✅ PASS 5/5 task

- **Phạm vi**: `RefreshTokenService` — rotation atomic `findOneAndUpdate` (bind `tokenHash`+`clientId`+active+`allowedResources` INV-14), hậu duệ cùng `familyId`/`parentId`, absolute lifetime giữ nguyên; reuse (`revokedAt && replacedBy`) → revoke family + audit `TOKEN_REUSE_DETECTED`. `/token` grant `refresh_token` (scope chỉ thu hẹp → `invalid_scope`, dedupe, rỗng = giữ nguyên RFC 6749 §6). `POST /revoke` RFC 7009 (revoke family, IDOR guard theo `clientId`, luôn 200 trừ 401/500). Mint refresh dùng chung 1 helper B4.4/B4.5.
- **Quyết định**: device-revoke hoãn (không có nguồn deviceId tin cậy) → DEBT-031; không transaction, lỗi giữa chừng → retry bị coi là reuse (strict rotation) → DEBT-032.
- **Bug đã sửa (senior REJECT ×2)**: (1) race rotate ‖ reuse — hậu duệ sống sót sau khi family bị revoke; (2) race rotate ‖ `/revoke`. Fix: `revokeFamily` luôn stamp `familyRevokedAt` trước `updateMany`, rotate re-read sau insert hậu duệ → self-revoke. Test race tất định (gate promise) + regression probe. Kèm: pre-check scope chỉ trên token active (chặn né reuse alert).
- **Verify**: typecheck/lint PASS; unit 80/80; int 262/262 → **342/342**.
- **Commit**: `b529c35`.
- **Vòng lặp**: analyst=1, tech-lead=1, dev=3, senior=3 (REJECT→REJECT→PASS), tester=1.
- **Debt**: mở DEBT-031..036 (034: gom revoke về 1 API trước B4.7/B6.3; 035: test tất định nhánh còn lại → B4.6; 033: discovery `revocation_endpoint` → B4.6).