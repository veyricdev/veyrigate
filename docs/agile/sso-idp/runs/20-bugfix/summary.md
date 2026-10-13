# Summary — run 20 bugfix (DEBT-067/068, 029/039/006, 007, 021, 053/061) — ✅ PASS 5/5 task

- **Phạm vi**: (1) DEBT-067/068 — nhánh phiên chết: revoke lỗi vẫn ghi audit từ chối, ném lỗi gốc. (2) DEBT-029/039 — rate-limit xác thực client cho `/token`, `/revoke`, `/introspect`: Lua reserve/refund atomic trước `findByClientId`/Argon2, khoá `ip` + `clientId|ip` cùng hash tag, chỉ đếm thất bại, 429 `temporarily_unavailable` + `Retry-After`, Redis lỗi → 500, 429 không consume code. (3) DEBT-006 — `TRUST_PROXY` mặc định tắt, chỉ nhận IP/CIDR (chuẩn hoá `ipaddr.js`), từ chối số/`true`/prefix <8/IPv4-mapped </104/IPv4 không chuẩn. (4) DEBT-007 — rotate key ghi state tmp+rename trước, xoá PEM sau. (5) DEBT-021 — `insertNextVersion` + index unique `{clientId,version}` + retry E11000. DEBT-053/061 — spec §11, runbook §2b/§2d/§5.
- **Quyết định**: chỉ đếm thất bại (không khoá RP tải cao); reserve-then-refund thay peek→hit; bỏ hop count vì Fastify 5 bỏ qua giá trị số (orchestrator chốt, user cho thêm 1 lượt ngoài giới hạn).
- **Bug tìm ra trong review**: race peek→hit (200 request song song vượt hết giới hạn); `0.0.0.0/0`, `::ffff:0:0/96` và các cách viết IPv6 tương đương lọt guard; `TRUST_PROXY=1` không có tác dụng ở runtime; `010.0.0.0/8` bị hiểu thành dải public.
- **Verify**: tsc/eslint 0; unit 175/175; int 442/442 → **617/617**.
- **Commit**: `08adee8`.
- **Vòng lặp**: analyst=3 (2 lần lỗi mạng), tech-lead=2, dev=4, senior=4 (REJECT×3 → PASS), tester=1.
- **Debt**: đóng DEBT-006/007/021/029/039/053/061/067/068/074; mở DEBT-071/072/073/075.