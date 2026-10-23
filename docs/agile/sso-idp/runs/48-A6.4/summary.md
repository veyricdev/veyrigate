# Summary — run 48 A6.4 (M5, lane ADMIN) — ✅ PASS 5/5 task

- **Phạm vi**: T0 [BE] (a) `AdminAuditEventViewDto`/`AuditPageViewDto` + OpenAPI/snapshot; (b) `TOKEN_REUSE_DETECTED` gắn `tenantId` từ client đã xác thực (trước đó không admin nào thấy — DEBT-140 phần reuse), drill/runbook-ops §2 cập nhật. T1 [FE] DEBT-339 (family uncertain ⇒ khuôn lock), DEBT-340 (cleanup E2E token mới), DEBT-341 (`query(params)` chung). T2 [FE] `listAudit` GET, `AuditIdSchema` chặn `@`, input strict không `tenantId`, `safeMetadata` lọc lần hai server-side. T3 [FE] `/audit`: lọc action/actor/target/client/result/thời gian, cursor, highlight bằng text (reuse, rotate khẩn cấp, Failure), IP/UA chỉ trong Details, render text, link chỉ khi id hợp lệ, ghi chú DEBT-140; link từ user detail. T4 [E2E] lock/unlock ⇒ lọc `/audit`, không email/`eyJ`.
- **Verify**: fe-admin 1120/1120, be 415 + int 1215, fe-sso-test 269, E2E 32/32 (×2 dev, ×1 tester), audit high 0, `gen:api` không diff, check:bundle 0; mutation 8 + 6 RED; grep secret/email 0.
- **Commit**: `8ced241`.
- **Vòng lặp**: tech-lead=1, BE dev=1, FE dev=2 (T1, T2–4), senior=1 (PASS), tester=1 (PASS).
- **Debt**: đóng DEBT-339/340/341; mở DEBT-342 (CSV), 343 (filter subjectId), **344 🟡** (retention IP/UA — cần quyết định), 345, **346 🟡** (nút Details a11y), 347 (ponytail), 348.
- **Run 49**: A6.5 Keys (+ DEBT-346/347).
