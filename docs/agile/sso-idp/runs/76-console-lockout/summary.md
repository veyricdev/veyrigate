# Summary — run 76 chống tự khoá client console fe-admin + gộp ADMIN_ROLES (M7, lane BE) — ✅ PASS 3/3 task

- **Phạm vi**: T1 DEBT-515 — `admin-clients.controller.ts` `assertKeepsOwnAccess`: khi PATCH đúng client đã cấp token đang dùng (`actor.clientId`), 409 `conflict` (thông điệp cố định, không ghi DB, không audit) nếu bỏ scope của token, gỡ resource `admin` khỏi `allowedResources`, hoặc gỡ `authorization_code` (+ `refresh_token` khi token có `offline_access`); chạy sau check self-disable, trước 403 tenant_admin. `AdminActor.scopes` từ `claims.scope`. Sửa từ client admin khác vẫn được (đường phục hồi). T2 DEBT-513 — `ADMIN_ROLES` dùng `identity/admin-roles.ts`. T3 spec §7 quy tắc 6, security-matrix, runbook-ops §7 phục hồi console.
- **Verify**: unit be 684, int 1516/1516 (`vg-int-*` 4 → 4), fe-admin 1567, E2E 37, X3 42; RED trước fix 9 ca; mutation M1–M8 RED đúng ca; tester thêm x1–x5 (tenant khác ⇒ 404, đổi thứ tự ⇒ 200, hoa/thường ⇒ 409, nhiều vi phạm ⇒ thứ tự quy tắc).
- **Commit**: `9abe1ea`.
- **Vòng lặp**: tech-lead=1, BE dev=1, senior=1 (PASS, 0 debt), tester=1 (PASS).
- **Debt**: đóng DEBT-513/515; mở DEBT-517 (console vẫn tự khoá được bằng gỡ redirect URI / xoá đúng secret version BFF đang dùng). `mailer.int-spec` flake Mailpit 1 lần (nghi `wslrelay` nghe :1025), dưới ngưỡng mở debt.
