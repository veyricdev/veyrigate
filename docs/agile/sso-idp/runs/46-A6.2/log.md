# Log — run 46 — A6.2 Resources UI (+ DEBT-318/319)

## tech-lead — 2026-10-23

**Kết luận: PASS (có fold).** Đã đối chiếu code `7f92122` qua CodeGraph. Fold vào `tasks.md` gồm:

- **Phạm vi và thứ tự**
  - Thêm **Task 0 [BE]**: OpenAPI thiếu schema response cho resources get/create/update. Task này chỉ thêm 3 decorator, cộng test và snapshot.
  - Thứ tự: Task 0 ‖ 1 → 2 → 3 → 4.
- **Quy tắc kiểm `identifier` (FE mirror BE)**: `new URL` + `hash === ""` + ≤2048. FE thêm luật chặn khoảng trắng đầu/cuối; đây là ngoại lệ duy nhất.
- **Quy tắc cho `resourceId` và `scopes`**
  - `resourceId` theo regex BE.
  - `scopes` tối đa 50 phần tử, mỗi phần tử ≤256, khớp `\S+`, không trùng. Các giới hạn này khác client.
- **Hành vi BE**
  - `identifier`/`resourceId` bất biến.
  - POST/PATCH đòi step-up + super_admin.
  - Resource là global.
- **API và key phía FE**
  - Giữ `listResources`/`useResources` của form client.
  - Key mới `resources.{all,options,list,detail}`.
- **Hiển thị**
  - Identifier chỉ hiện dạng text vì BE nhận cả `javascript:`.
  - UI ghi bị ẩn với viewer không có quyền super_admin.
- **E2E**: dùng tên duy nhất theo thời gian đảo ngược, không dọn dữ liệu, không step-up.
- **DEBT-318/319**: chốt cách sửa và test.

**Trả lời câu hỏi:** Q-46.1 (quy tắc), Q-46.2 (không reset DB, tên duy nhất), Q-46.3 (vừa 1 run).

**Debt mới:** mở DEBT-321…325.

**Bước tiếp:** → **backend-dev** (Task 0) ‖ **frontend-dev** (Task 1 → 2 → 3 → 4).

## frontend-dev — Task 1 (DEBT-318 + DEBT-319) — 2026-10-23
- DEBT-318: `hooks.ts` `useInvalidateOn(queryKey)` (throw lạ / `uncertain` / thành công ⇒ invalidate); 2 characterisation `client-secrets-risk.test.tsx` ⇒ "was re-read".
- DEBT-319: `confirm-action.tsx` `useActionNotice()` — `role="status"` luôn render (Status, Secrets), focus `h2` (`tabIndex=-1`) qua rAF; `ConfirmAction` chặn `onCloseAutoFocus` chỉ khi action xong. 3 test mới; 7 query `getByRole("status")` trong `clients-ui(-risk).test.tsx` scope vào `form[novalidate]` (nay có >1 vùng status).
- RED trước fix: 5 test đỏ. Mutation (sha256 khôi phục byte-identical): điều kiện cũ ⇒ 2 đỏ; bỏ focus ⇒ 3; bỏ preventDefault ⇒ 2; Status điều kiện ⇒ 2; Secrets điều kiện ⇒ 1.
- Verify: typecheck 0, lint 0, test 685/685 (31 files), build OK, check:bundle 0 hit. Không chạy E2E, không `gen:api` (Task 0 của backend-dev đang đổi `admin.json`/`schema.d.ts`; typecheck xanh với bản hiện tại).
- Bước tiếp: Task 2 (chờ giao), sau đó senior-reviewer.

## backend-dev — Task 0 — 2026-10-23

- `admin-resources.controller.ts`: `@ApiOkResponse(AdminResourceViewDto)` cho get/update, `@ApiCreatedResponse(AdminResourceViewDto)` cho create. Không đổi runtime/DTO request; không chạm trust boundary (chỉ metadata).
- `admin.spec.ts`: thêm 3 `$ref` (post 201, get 200, patch 200). RED trước fix (`Received: undefined`), xanh sau.
- Snapshot: BE dev :4000 không chạy ⇒ không `fetch:api`; dựng doc in-process (cùng `DocumentBuilder` + `adminOnly`, 7 admin controller, guard mock, không DB/Redis, spec tạm đã xoá). Diff với snapshot cũ chỉ đúng 3 `responses/*/content` ⇒ ghi `fe-admin/openapi/admin.json` (+24/−3), `gen:api` ⇒ `schema.d.ts` (+9/−3).
- Verify: be unit 32 suites/405 pass; `test:int` 45 suites/1203 pass (vg-test-*); be typecheck 0, lint 0, prettier OK; fe-admin typecheck 0. Không debt mới.

## frontend-dev — Task 2 → 3 → 4 — 2026-10-23
- Task 2: `client.ts` + `listResourcePage/getResource/createResource/updateResource` (`features/admin-api/resources.ts`); `inputs.ts` `PageInput` (alias `ListClientsInput`), `ResourcePathIdSchema` (luật lỏng), `CreateResourceInput`/`UpdateResourceInput` (strict, 50/256); keys `resources.{all,options,list,detail}`, hook ghi invalidate `resources.all` qua `useInvalidateOn`; `useResources` giữ nguyên (key `options`). Type test 3 response + 2 body. `resources-fn.test.ts` 44.
- Task 3: `/resources`, `/resources/new`, `/resources/$resourceId` + nav; `resource-form-schema.ts` (`identifierProblem` đúng thứ tự fold), `resource-form.tsx` (status/alert luôn render, focus h2); ghi chỉ cho super_admin; identifier luôn text. `resource-form-schema.test.ts` 35, `resources-ui.test.tsx` 27. Mutation 12/12 RED (fragment 2, trim 5, identifier vào patch 5, `<a href>` list 1 / detail 1, max 20 ⇒ 3, bỏ key 1, status điều kiện 1, key options ngoài `all` 1, luôn PATCH 2, tenant_admin thấy form 1, bỏ focus 1), sha256 khôi phục byte-identical.
- Task 4: `e2e/tests/fe-admin-resources.spec.ts` (`e2e-r<inv>`, không dọn — DEBT-322). Cổng :4000/:5173/:3000 trống ⇒ `pnpm -C e2e e2e` 2 lần: 30/30 (4.1m), 30/30 (3.3m); lần 2 POST `/admin/resources` 201 (resource mới), grep secret log 0.
- Verify: fe-admin typecheck 0, lint 0, test 792/792 (34 files), build OK, check:bundle 0 hit, gen:api không diff so với snapshot Task 0; root `pnpm lint` OK; e2e typecheck 0. Debt mới: DEBT-326.
- Bước tiếp: senior-reviewer.

## senior-reviewer — 2026-10-23
- **Kết luận: PASS** (0 🔴). Tự chạy: fe-admin test 792/792 (34 files), typecheck 0; không chạy E2E.
- BE Task 0 chỉ là metadata OpenAPI (3 decorator); snapshot/`schema.d.ts` khớp. FE: mirror identifier/resourceId/scopes đúng fold; identifier luôn text; PATCH strict chỉ `scopes`, base đóng băng, remount theo `resourceId`; step-up không auto-submit; uncertain không retry; UI ghi chỉ super_admin; ô chọn resource của client form không regress (key `options` dưới `all`). DEBT-318 điều kiện đúng; DEBT-319 `done` ref + rAF không race/leak đáng kể.
- 🟡: DEBT-327 (thông điệp uncertain update hứa "reloaded: check it" nhưng form đóng băng không hiện dữ liệu mới), DEBT-328 (ponytail: `messages`/`textareaClass`/`ResourcePathIdSchema` nhân bản, ~-12 dòng). 💭: notice trùng chuỗi không đọc lại; `waitForTimeout(500)` E2E; alert + form cùng hiện khi refetch lỗi (có chủ đích, như DEBT-316).
- Bước tiếp: **tester**.

## tester — 2026-10-23
- **Kết luận: FAIL [FE]** (1 lỗi đảo ngược ý định). Chi tiết và output: `test-report.md`.
- **Lỗi (case 9)**: `/resources/$resourceId`, sau PATCH `uncertain` đã ghi thật, admin hoàn tác về scopes ban đầu ⇒ "No changes to save.", không gửi; server giữ giá trị mới.
  - Nguyên nhân: `baseRef` chỉ dời khi có `saved`. Form đóng băng nên người dùng không thấy dữ liệu đọc lại (DEBT-327 có characterisation).
  - Test `resources-ui-risk.test.tsx` đang là `it.fails`; khi sửa xong, đổi thành `it`.
- **Test mới**:
  - `fe-admin/test/resource-form-parity.test.ts` (74): đối chiếu FE với verdict BE đo thật. Form không bao giờ nhận giá trị BE từ chối; mọi khác biệt đều do FE chặt hơn;
  - `fe-admin/test/resources-ui-risk.test.tsx` (19 + 1 `it.fails`): body POST ở biên, 10 lỗi field, tenant_admin không có đường ghi, DEBT-327, ô chọn resource của form client.
  - Mutation: trim ⇒ 8 đỏ; guard tenant ⇒ 1 đỏ; 50→51 ⇒ 2 đỏ. Khôi phục sha256 OK.
- **Kết quả chạy**:
  - fe-admin: typecheck 0, lint 0, test 885 + 1 expected fail (36 file), build OK, check:bundle 0 hit, gen:api không diff;
  - root: lint 0, typecheck 0, audit exit 0;
  - root test: be 405, fe-sso-test 268 + 1 flaky (chạy lại 269/269 ⇒ DEBT-331);
  - E2E (cổng trống): 30/30 hai lần (3.6m, 3.3m), grep secret 0.
- **Debt mới**: DEBT-329 (C0/tab trong identifier), DEBT-330 (cùng lỗi mốc base sau uncertain ở trang client, chưa test, đề nghị sửa cùng), DEBT-331 (flaky fe-sso-test).
- **Bước tiếp**: → **frontend-dev** sửa case 9 (gợi ý gộp DEBT-327/330), sau đó tester chạy lại.

## frontend-dev retry 1 — 2026-10-23
- **Case 9 (resources)**: `EditScopesForm` giữ cờ `unsure` sau `uncertain`/lỗi ném ⇒ lần lưu kế luôn gửi PATCH (thay cả mảng, idempotent); lưu OK ⇒ mốc biết lại. Dòng read-only "Currently saved: …" (dữ liệu đọc lại) dưới form, không đụng draft ⇒ đóng DEBT-327. `it.fails` ⇒ `it`.
- **DEBT-330 (clients)**: test tái hiện trước (`clients-ui-risk.test.tsx`, 2 RED); sửa: field của PATCH uncertain vào tập `unknown`, `changedValues(values, base, unknown)` gửi lại chúng, field khác không gửi; lưu OK xoá tập ⇒ đóng.
- **Verify**: fe-admin typecheck 0, lint 0, test 36 file **889/889**, build OK, check:bundle 0 hit, gen:api sha256 OK (không diff); root lint 0; E2E (cổng trống) **30/30** (3.3m).
- **Mutation** (khôi phục sha256 OK): bỏ guard `unsure` ⇒ 1 đỏ; ẩn "Currently saved" ⇒ 1 đỏ; bỏ `setUnsure(false)` ⇒ 1 đỏ; bỏ `unknown` ở clients ⇒ 2 đỏ; bỏ `clear()` ⇒ 1 đỏ.
- Không làm DEBT-326/328 (tránh phình diff). Không debt mới.
- **Bước tiếp**: → **senior-reviewer**, rồi tester chạy lại.

## senior-reviewer vòng 2 — 2026-10-23
- **Kết luận: PASS** (0 🔴). Tự chạy fe-admin: typecheck 0, test 889/889 (36 file). Không chạy E2E.
- Đã kiểm các tình huống sau, không tìm thấy đường nào làm lần lưu sau uncertain đảo ngược ý admin:
  - uncertain liên tiếp;
  - 4xx sau uncertain;
  - lỗi ném;
  - step-up remount, khi base là dữ liệu đọc mới;
  - refetch trong lúc `unsure`.
- PATCH clients chỉ gồm key của form, không có field bất biến.
- 🟡 mới: DEBT-332. Dòng "Currently saved" hiện giá trị cache khi refetch còn chạy hoặc bị lỗi.
- DEBT-327/330 đóng đúng.
- Bước tiếp: **tester** chạy lại.

## tester lượt 2 — 2026-10-23
- **Kết luận: PASS**. Chi tiết và output nằm ở `test-report.md`, mục "Lượt 2".
- **Case 9 và DEBT-330 đóng thật**: test `it.fails` cũ nay là `it` và xanh; repo không còn `it.fails`.
- **Test mới** (12 test, 2 file, xanh 3/3 lần chạy riêng):
  - `resources-ui-risk.test.tsx` (7): uncertain×2; uncertain → 4xx → lưu; lỗi ném; uncertain không ghi (gửi lại đúng giá trị, sau đó "No changes" hoạt động lại); refetch lúc `unsure` không ghi đè draft; DEBT-332 khi đang đọc lại và khi đọc lại lỗi;
  - `clients-ui-risk.test.tsx` (5): field unknown cộng field mới đổi, so body `toEqual`; unknown cộng dồn rồi xoá sau khi lưu OK; uncertain → 4xx → lưu; lỗi ném; uncertain không ghi.
- **Mutation**: 4 mutant (resources/clients × 4xx/lỗi ném), mỗi mutant chỉ bị test mới bắt (1 đỏ / 122). Khôi phục, sha256 OK.
- **DEBT-332**:
  - nửa "refetch lỗi": tái hiện được ("Currently saved" hiện cache cũ cạnh alert), không đảo ngược ý định ⇒ giữ 🟡;
  - nửa "đang refetch": không xảy ra với lần đọc lại ngay sau save, vì `onSettled` chờ invalidate.
- **Kết quả chạy**:
  - fe-admin: typecheck 0, lint 0, test 901/901 (36 file), build OK, check:bundle 0 hit, gen:api không diff;
  - root: lint 0, typecheck 0, audit exit 0;
  - root `pnpm test`: lần 4 xanh (be 405, fe-sso-test 269, fe-admin 901). 3 lần đầu fe-admin đỏ do timeout của `check-bundle.test.ts`/`bff.test.ts` dưới tải song song, ngoài diff ⇒ DEBT-333;
  - E2E (cổng trống trước và sau): 30/30 (3.7m);
  - grep secret: 0.
- **Debt mới**: DEBT-333 💭.
- **Bước tiếp**: → **orchestrator** đóng run 46.
