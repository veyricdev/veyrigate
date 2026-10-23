# Summary — run 46 A6.2 (M5, lane ADMIN) — ✅ PASS 5/5 task

- **Phạm vi**: T0 [BE] `@ApiOkResponse/@ApiCreatedResponse(AdminResourceViewDto)` cho get/create/update resources + snapshot/`gen:api`. T1 [FE] DEBT-318 (`useInvalidateOn`: invalidate cả khi lỗi ném), DEBT-319 (vùng status luôn render, focus heading sau action). T2 [FE] server fns `listResourcePage/getResource/createResource/updateResource`, keys `resources.*` (picker client form giữ nguyên). T3 [FE] `/resources`, `/new`, `/$resourceId`: identifier mirror BE (≤2048, `URL.canParse`, hash rỗng, + chặn khoảng trắng), resourceId regex BE, scopes 50/256 không trùng, PATCH chỉ `scopes` khi đổi, base đóng băng, chỉ super_admin thấy control ghi, identifier luôn là text. T4 [E2E] `fe-admin-resources.spec.ts`.
- **Bug đã sửa**: (tester FAIL 1, case 9) sau `uncertain` base vẫn là mốc mount ⇒ đặt lại giá trị cũ bị "No changes" không gửi ⇒ cờ `unsure` + dòng "Currently saved" (DEBT-327); cùng lỗi ở `/clients/$clientId` (DEBT-330) ⇒ tập field `unknown` luôn gửi lại.
- **Verify**: fe-admin 901/901, be 405 + int 1203, fe-sso-test 269, E2E 30/30 (×2 dev, ×2 tester lượt 1, ×1 retry, ×1 lượt 2), audit high 0, `gen:api` không diff, check:bundle 0; mutation RED; grep secret 0.
- **Commit**: (điền sau).
- **Vòng lặp**: tech-lead=1, BE dev=1, FE dev=3 (T1, T2–4, retry 1), senior=2 (PASS, PASS), tester=2 (FAIL → PASS).
- **Debt**: đóng DEBT-318/319/327/330; mở DEBT-321–325 (BE, M7), 326/328 (gom helper dùng chung), 329, 331, 333 (💭 flaky), **DEBT-332 🟡** ("Currently saved" có thể là cache cũ khi re-read lỗi).
- **Run 47**: A6.3 Users & sessions (+ DEBT-326/328 gom helper).
