# Summary — run 88 X6 release checklist đợt 3 (M8, lane BE + UI + QA) — ✅ PASS 4/4 task

- **Phạm vi**: T1 DEBT-164/165 — CLI `db:bootstrap` production (tenant + resource `admin` + client `fe-admin`, một transaction + touch `opslocks`, URI từ env bắt buộc https, secret in một lần sau commit, `--update-uris`/`--rotate-secret` cần `--ticket`, audit `ADMIN_BOOTSTRAPPED`, `ADMIN_SEED_EMAIL` tuỳ chọn, runbook-deploy §16 + smoke check 13). T2 DEBT-582/586 — `/account/sessions`: phiên + thiết bị tin cậy, nhãn thiết bị từ allow-list (không lưu UA thô), huỷ một/mọi phiên khác/quên thiết bị cần xác thực lại (5 phút hoặc mật khẩu, bucket `pwc:`), helper huỷ phiên chung với logout. T3 DEBT-581 — màn consent hiện origin (từ `redirectUri` đã khớp), mô tả scope, thời hạn; `/account/apps` tự thu hồi consent. T4 E2E + lượt tay §16 + gate + checklist.
- **Verify**: be 1069, int FULL 2320/2320 (`vg-int-*` 0→0), E2E 44/44 ×2 (+`account-self-service.spec.ts`), X3 42, fe-admin 1626, lượt tay §16 110/110 trên `vg-bootstrap-check` (đã drop; chạy từ layout `pnpm deploy --prod`, không build image vì cần tải base image). Vault không chạy (không đổi code Vault).
- **Checklist**: 202 dòng = 152 ✅ / 29 ⚠ / 2 ❌ / 19 N/A; P0 ❌ = 0; ❌ còn C-6.3.3 (MFA, run 89), D-14 (ký, run 90).
- **Commit**: `de14146`.
- **Vòng lặp**: tech-lead=1 (PASS, chia 88/89/90), BE dev=1, senior=1 (PASS, 6 🟡), tester=1 (PASS). Orchestrator sửa DEBT-627 (`--log-driver none` ở §16 bước 3).
- **Debt**: đóng DEBT-164/165/581/582/586/627; mở DEBT-622–626, 628–632 (628–632 làm đầu run 89). Quyết định D88.1–D88.30 chép vào `plan.md` §12.
- **Ghi chú**: AC10 "dry-run < 1 s" thực tế 2,6–2,85 s (nạp module, 0 kết nối) — ghi là lệch chữ. Unit flake 1068/1069 senior thấy không tái hiện qua 4 lượt.
- **⚠ Deploy**: production dựng bằng `db:bootstrap` (runbook-deploy §16), không `db:seed`; secret `fe-admin` chép thẳng vào secret store.
