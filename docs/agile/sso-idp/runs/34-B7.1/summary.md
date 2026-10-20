# Summary — run 34 B7.1 (M7) — ✅ PASS 4/4 task

- **Phạm vi**: T1 `test:int` chạy đơn bằng khoá Redis `vg:int-lock` (SET NX PX + heartbeat Lua + `int-teardown.mjs`), `--testTimeout=20000`. T2 `security-matrix.md`: 77 dòng §14/§15 ⇒ 72 có / 1 một phần (INV-19 KMS) / 0 thiếu / 3 lỗi sản phẩm (DEBT-116) / 1 ngoài phạm vi (X3). T3 test song song thật (refresh N=5, logout ∥ `/token` K=10, verify-email N=5), enumeration HTTP so byte 4 route, login khi chưa verify, `resource` lặp. T4 CI job `int` (mongo/redis/mailpit).
- **Bug đã sửa**: INV-15 — `resource` lặp ở `/authorize` thành mảng ⇒ Mongoose `$in` ⇒ **cấp code** cho resource khớp đầu ⇒ `resolveResource` từ chối non-string (`invalid_target`).
- **Verify**: BE unit 303/303, int 827/827 ×2, FE 240/240, E2E 16/16; khoá: lần chạy song song bị từ chối ~1.9 s; mutation RED. CI job chưa chạy trên runner thật.
- **Commit**: `2007080`.
- **Vòng lặp**: tech-lead=1, BE dev=2 (T1; T3+T4), tester=2 (T2 ma trận; nghiệm thu — 1 lần bị ngắt phiên), senior=1 — không REJECT.
- **Debt**: đóng DEBT-004/195/199/201/202; mở DEBT-203–206 (204/205: tham số lặp ở `/authorize`, `scope`/`prompt` lặp ⇒ 500). Run 35: DEBT-116 (cross-tenant OAuth) + 128/141/144/156 + 204/205.
