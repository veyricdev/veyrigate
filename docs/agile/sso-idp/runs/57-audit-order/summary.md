# Summary — run 57 thứ tự audit lock/unlock (M7, lane BE) — ✅ PASS 2/2 task

- **Phạm vi**: T1 DEBT-420 — `users.adminLockMarkAt` (Date, không ra view/OpenAPI) đặt `max(now, prev+1ms)` trong cùng câu ghi pipeline; `adminLock` một pipeline nguyên tử (giữ mức super/legacy bằng `$cond`, bỏ vòng 2 lượt), `adminUnlock` pipeline giữ `returnDocument:'before'`; `AuditService.record(…, {timestamp})` (không qua HTTP input); LOCKED/UNLOCKED success dùng mốc, follow-up `max(now, mark+1)` ⇒ trail luôn kết thúc khớp DB; bật lại L6. T2 DEBT-422 — sort audit `{timestamp:-1,_id:-1}`, cursor `{t,i}`, cursor cũ `{t,e}` ⇒ 400, index `{tenantId,timestamp,_id}` thay index cũ; DEBT-427 cursor `t > 8.64e15` ⇒ 400 (trước đây 500).
- **Verify**: be unit 594, int 1366 (0 skip), L5/L6/L7 25×10 vòng không barrier xanh, M1 nhiều admin song song 12 vòng + M2 trùng ms, phân trang 36 event/3 ms ở 8 limit, 32 cursor giả ⇒ 400, fe-admin 1416, fe-sso-test 269, E2E 36/36 (thêm `fe-admin-audit-paging`), audit high 0; mutation 6 + 1 + 5 RED; fe-admin không đổi.
- **Việc người dùng**: chạy `pnpm -C be db:sync-indexes` trên DB dev `sso-idp` (index audit mới; E2E tự sync).
- **Commit**: (điền sau).
- **Vòng lặp**: tech-lead=1, BE dev=2 (impl, DEBT-427), senior=1 (PASS), tester=1 (PASS; bị ngắt giữa chừng do Docker tắt, resume).
- **Debt**: đóng DEBT-420/422/427; mở 424 💭 (brute-force lock ∥ admin unlock), 425 💭 (thứ tự giữa loại event khác/instance theo đồng hồ Node), 426 💭.
