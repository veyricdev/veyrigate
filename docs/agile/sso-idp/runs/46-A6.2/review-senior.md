# Senior Review — 2026-10-23

## Kết luận: PASS

Không có 🔴. Còn 2 🟡 chưa sửa, đã ghi vào backlog là DEBT-327 và DEBT-328.

## Tổng quan (ấn tượng chung + điểm tốt)

Diff bám sát fold của tech-lead và tái dùng khuôn A6.1 mà không tạo abstraction mới đáng kể.

**Đã tự kiểm lại**
- `pnpm -C fe-admin test`: 34 file, 792/792 xanh.
- `pnpm -C fe-admin typecheck`: 0 lỗi.
- Không chạy E2E. Theo log, dev đã chạy E2E 30/30 hai lần.

**BE (Task 0)**
- Chỉ thêm 3 decorator `@ApiOkResponse` / `@ApiCreatedResponse(AdminResourceViewDto)` và import. Không đổi runtime, guard hay DTO request.
- `admin.spec.ts` khẳng định đúng 3 `$ref`.
- `fe-admin/openapi/admin.json` chỉ thêm 3 khối `content`, khớp `schema.d.ts`.

**FE: điểm tốt**
- `identifierProblem` đúng thứ tự fold: rỗng → ≤2048 → trim → `URL.canParse` → `hash`. Không thêm luật nào khác (scheme, `*`).
- Bảng test có cả nhóm qua lẫn nhóm chặn, gồm `https://a/#` và `urn:`.
- `resourceId` dùng hằng `RESOURCE_ID` trùng regex BE. Scopes dùng 50/256 riêng, không lẫn hằng của client.
- `identifier` không bao giờ là link:
  - danh sách: `<code>`;
  - chi tiết: `<dd>`;
  - có test cho `javascript:`.
- PATCH:
  - `UpdateResourceInput.patch` là `.strict()` ở server fn, nên trình duyệt không thể chèn `identifier`/`resourceId`;
  - so mảng theo thứ tự; không có thay đổi thì không gửi;
  - `base` nằm trong `useRef` và đóng băng lúc mount; `defaults` là `useState`, nên refetch không ghi đè form. Có test "a refetch while editing never overwrites the edit".
  - `<Fragment key={resourceId}>`, có test chuyển A → B.
- Step-up: dùng lại `useStepUpDraft` (ref chống StrictMode); restore bằng `key`; không tự gửi, có test.
- Đường path id: `ResourcePathIdSchema` (luật lỏng) cộng `encodeURIComponent`. Test `../x`, `a/b` khẳng định `fetch` không được gọi.
- Quyền super_admin chỉ ẩn UI, không gọi BE vô ích. BE vẫn là nơi thực thi.
- `useResources` (ô chọn resource của form client) giữ nguyên hành vi, chỉ đổi key sang `resources.options`. Mọi lần ghi resource invalidate `resources.all`, có test "re-reads the client form's resource options". Không regress.
- DEBT-318: điều kiện `!error || !(error instanceof AdminRequestError) || error.uncertain` đúng ý. Lỗi đã biết (400/403/404/409/step-up) không refetch; throw lạ và uncertain thì refetch.
- DEBT-319:
  - `done` ref chỉ chặn `onCloseAutoFocus` khi action đã xong. Cancel và Escape vẫn trả focus về trigger.
  - Thứ tự Radix (unmount `setTimeout(0)`) và rAF không gây tranh chấp, vì auto-focus đã bị `preventDefault`.
  - Focus trap tắt khi `open=false`, nên focus vào heading ngoài dialog không bị kéo lại.
  - rAF không được huỷ khi unmount, nhưng `headingRef.current?.focus()` là no-op an toàn, không leak.
- E2E:
  - mỗi lần chạy tạo một resource duy nhất (`inv` đảo ngược) và có comment ghi DEBT-322;
  - ngưỡng 50 s được khẳng định tường minh, nên nếu vượt thì fail có thông điệp rõ chứ không flaky ngầm;
  - chặn identifier sai được chứng minh hai cách: đếm POST `_serverFn` và admin API trả 404.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Identity / authentication**: không đổi. Server fn đi qua `adminCall` (BFF), AT không xuống trình duyệt. Step-up draft chỉ chứa text form đã qua allowlist zod, gắn với action + path + `sub`, dùng một lần, TTL 10 phút.
- **Authorization**: resource là dữ liệu global, nên không có IDOR hay cross-tenant. BE thực thi `admin.write` + `RequireRecentAuth(5)` + `assertSuperAdmin`. UI ẩn cho tenant_admin; có test "no create call".
- **State / concurrency**:
  - double submit: `isSubmitting` vô hiệu nút; có test double click gửi 1 lần;
  - create không idempotent: `uncertain` không tự retry; có test `toHaveBeenCalledTimes(1)`;
  - PATCH thay nguyên mảng nên gửi lại là idempotent;
  - last-write-wins giữa hai super_admin đã ghi nhận (DEBT-323).
- **Chuỗi request**: step-up → `/auth/login?stepup=1&returnTo=<path>` (path nội bộ, encode) → restore. Không auto-submit.
- **Failure behavior**:
  - GET 5xx ⇒ `unavailable`, không `uncertain`;
  - POST/PATCH 5xx, timeout hoặc 2xx sai schema ⇒ `uncertain` + invalidate;
  - có unit test; không fail-open.
- **Exposure**: log dùng route template (`/admin/resources/:resourceId`), không log body; có test "a BE error body is never logged". Thông điệp 400/409 của BE (có thể chứa `identifier`) render dạng text.
- **Boundary input / output**:
  - XSS qua `identifier` (`javascript:`) bị chặn vì chỉ render text, có test;
  - path traversal chặn bằng validator, sau đó `encodeURIComponent`;
  - `after` đi qua `URLSearchParams`, `?after=` validate bằng zod `.catch(undefined)`;
  - patch strict.

## 🟡 Nên sửa

🟡 **Thông điệp uncertain khi update hứa điều UI không làm được (DEBT-327)**

`fe-admin/src/routes/resources/$resourceId.tsx:107-110`: thông điệp là "The latest data was reloaded: check it before saving again."

**Vì sao:** với super_admin, scopes chỉ hiện trong `ResourceForm`, mà form này cố ý đóng băng (không theo refetch). Sau uncertain, `query.data` đã được đọc lại, nhưng trên màn hình không có chỗ nào hiện scopes mới của server. Người dùng được bảo "kiểm tra" mà không có gì để kiểm. Test "uncertain update" chỉ khẳng định `get` được gọi lại, không khẳng định người dùng thấy dữ liệu mới. Hệ quả không nguy hiểm, vì PATCH là replace và gửi lại là idempotent, nhưng thông điệp sai sự thật.

**Đề xuất:** khi `query.data.scopes` khác `base`, hiện thêm một dòng read-only "Currently saved: …" ngoài form. Hoặc đổi thông điệp thành "Reload the page to see the saved scopes before saving again." Kèm test khẳng định dòng đó xuất hiện.

🟡 **Ponytail: helper bị nhân bản (DEBT-328)**

Xem mục ✂️ bên dưới: `messages` và `textareaClass` chép từ `client-form.tsx`, `ResourcePathIdSchema` chép chuỗi refine của `ClientIdSchema`.

**Vì sao:** hai bản sẽ trôi lệch nhau. Ví dụ, sửa luật path id cho client mà quên resource.

**Đề xuất:** gom cùng lúc với DEBT-326 (chuyển helper dùng chung sang `features/admin-api/` hoặc `components/`).

## 💭 Nit

- `confirm-action.tsx` `useActionNotice`: `announce` cùng một chuỗi hai lần liên tiếp (ví dụ "No changes to save.") không làm DOM đổi, nên screen reader không đọc lại. Cân nhắc xoá notice rồi set lại trong rAF, hoặc thêm bộ đếm. Mức độ thấp.
- `e2e/tests/fe-admin-resources.spec.ts:53`: `waitForTimeout(500)` là sleep cố định. Validate phía client chạy đồng bộ, và dòng 51–52 đã chờ thông điệp lỗi hiện ra, nên có thể bỏ. Giữ cũng không flaky, chỉ tốn 0,5 s.
- `$resourceId.tsx`: khi refetch lỗi mà còn `query.data`, trang hiện cả alert "Try again" lẫn form. Hành vi này nhất quán với DEBT-316 của clients; ghi lại để biết là có chủ đích.

## ✂️ Ponytail

- `fe-admin/src/features/resources/resource-form.tsx:L30`: shrink: `messages` giống hệt `client-form.tsx:50`. Export một bản rồi import.
- `fe-admin/src/features/resources/resource-form.tsx:L166`: shrink: `textareaClass` giống hệt `client-form.tsx:298`. Export và dùng lại.
- `fe-admin/src/features/admin-api/inputs.ts:L72`: shrink: `ResourcePathIdSchema` lặp nguyên chuỗi `min/max/refine` của `ClientIdSchema`. Tách `const pathIdSchema = (label: string) => z.string().min(1).max(128).refine(…, \`Invalid ${label} id\`)` và dùng cho cả hai.

net: -12 lines possible.

---

# Senior Review — Vòng 2 (sau frontend-dev retry 1) — 2026-10-23
## Kết luận: PASS

## Tổng quan
Bản sửa nhỏ và đúng chỗ. Ở resources, cờ `unsure` khiến lần lưu sau một kết quả không chắc chắn luôn được gửi, nên case 9 không còn đảo ngược ý định. Ở clients, tập `unknown` chỉ gửi lại những field đã nằm trong PATCH uncertain, các field khác vẫn không gửi (giữ DEBT-307). Test tái hiện đúng lỗi thật: revert về giá trị lúc mount, `toEqual` chặt trên body PATCH, và trường hợp lưu thành công thì base được biết lại. Tự chạy: fe-admin typecheck 0, test 36 file 889/889. Không chạy E2E.

## 🔴 Blocker
(không có)

## Security invariants / trust boundaries đã kiểm
- **Đảo ngược ý định sau uncertain** (state, chuỗi request):
  - *Uncertain liên tiếp*: `unsure` / `unknown` chỉ bị xoá khi lưu thành công. Lỗi 4xx không uncertain không xoá chúng, nên vẫn giữ đúng.
  - *Lỗi ném (không phải `AdminRequestError`)*: được coi là uncertain, đúng như DEBT-315.
  - *Lưu thành công một phần*: PATCH luôn chứa mọi key trong `unknown`, vì `changedValues` thêm chúng và `toPatch` giữ nguyên key. Vì vậy `clear()` toàn bộ sau khi lưu OK là đúng.
- **Step-up giữa chừng**: `startStepUp` điều hướng toàn trang (test mock `assign`). Khi quay lại, component remount nên `unsure` và `unknown` mất, nhưng `base` lúc này là dữ liệu đọc mới từ server. Draft được so với giá trị thật, nên không tái tạo lỗi case 9. Với clients, payload step-up chứa cả field unknown bằng base, việc này vô hại. Nếu có đường SPA không remount thì cờ vẫn còn, vẫn an toàn (chỉ gửi thừa).
- **Refetch đổi base trong lúc unsure**: base vẫn đóng băng như thiết kế DEBT-307. `unsure` buộc gửi, và PATCH resources thay cả mảng nên idempotent. Draft không bị refetch ghi đè (có test).
- **PATCH clients không gửi field bất biến**: key trong `unknown` chỉ lấy từ `Object.keys(patch)`, tức là `ClientFormValues`. Các field bất biến (type, auth method, status…) nằm ở `ClientFacts`, không thuộc form. `toPatch` chỉ ánh xạ key của `changed`, nên không mở rộng phạm vi PATCH.
- **Exposure**: không đổi. "Currently saved" render dạng text, không dùng `dangerouslySetInnerHTML` và không có link.

## 🟡 Nên sửa
🟡 **Thông điệp: "Currently saved" có thể hiện giá trị cũ** (DEBT-332)
`fe-admin/src/routes/resources/$resourceId.tsx:131-135`: dòng này hiện `resource.scopes` ngay khi `unsure` bật. Trong lúc refetch do `useInvalidateOn` còn chạy, hoặc khi refetch lỗi (TanStack giữ `data` khi `isError`, và trang còn hiện cả alert "could not be loaded"), giá trị hiển thị là bản cache trước khi lưu, nhưng nhãn lại khẳng định đó là giá trị đã lưu.
Vì sao: thông điệp phải đúng sự thật, vì admin có thể tin rằng lần ghi chưa vào. Không đảo ngược ý định, vì lần lưu kế vẫn luôn gửi, nên đây không phải blocker.
Đề xuất: truyền `isFetching`/`isError` xuống. Khi đang tải thì ghi "Reloading…", khi tải lỗi thì ghi "unknown". Thêm test cho trường hợp refetch treo hoặc lỗi.

## 💭 Nit
- Thông điệp ở clients không còn hứa "reloaded: check it" mà nói đúng việc sẽ xảy ra. Có thể thêm dòng "Currently saved" như bên resources cho nhất quán (không bắt buộc).
- Resources dùng một cờ boolean, clients dùng một tập field. Hai cách khác nhau nhưng đều hợp lý, vì resources chỉ có một field.

## ✂️ Ponytail
Lean already. Ship. (Phần nhân bản cũ vẫn theo dõi ở DEBT-328.)

DEBT-327 và DEBT-330 đã đóng đúng. Chuyển sang **tester** để chạy lại.
