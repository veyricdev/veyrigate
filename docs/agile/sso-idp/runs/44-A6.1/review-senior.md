# Senior Review — 2026-10-22 (run 44 A6.1, lượt 1)

## Kết luận: REJECT

Một 🔴 [FE]: PATCH ở trang sửa client so với dữ liệu server **mới nhất** thay vì so với giá trị lúc form được nạp. Khi query refetch (mặc định khi cửa sổ lấy lại focus) sau lúc admin đã bắt đầu sửa, form gửi lại giá trị cũ của các field admin **không hề sửa**, ghi đè thay đổi của admin khác. Chuyển lại **frontend-dev**. Task 1 [BE] và Task 3E [E2E] không có blocker.

## Tổng quan

- **Task 1 [BE]**: chỉ là tài liệu. `admin.views.ts` là class không bao giờ được khởi tạo, `implements` interface của mapper; controller chỉ thêm decorator `@Api*Response`; `admin.dto.ts` chỉ thêm `type: String` vào `@ApiPropertyOptional` (class-validator giữ nguyên). Mapper/guard/handler không đổi ⇒ runtime không đổi. Test so key mapper với `properties` và `$ref` từng operation chặn lệch hai chiều — làm tốt.
- **Task 2 [FE]**:
  - DEBT-297: 2xx mutation với body không phải JSON hoặc sai schema ⇒ `uncertain`; log chỉ có method + route.
  - DEBT-299: `clearIntent()` được gọi trước.
  - `useStepUpDraft`: ref sống qua lần chạy lại effect của StrictMode.
  - DEBT-296: vòng lặp `refresh` kết thúc được. Mỗi lần lặp `await` một promise đã gắn `.finally(delete)`, nên khi tiếp tục thì `inflight` đã được xoá; vòng lặp thoát khi không còn refresh nào đang chạy, hoặc khi refresh dùng chung trả về AT khác AT cũ hay `null`. Không có đường treo vô hạn trừ khi refresh thường bị kích liên tục, và việc đó do chính traffic giới hạn.
- **Task 3 [FE]**:
  - Bảng ngữ nghĩa có `caption`, `th scope`. URI chỉ hiển thị dạng text, không có `<a href>`.
  - zod mirror khớp `validateRedirectUriFormat`/`validateCorsOrigin` (đã đối chiếu: wildcard, absolute, fragment, `;`/`,`/khoảng trắng trong host, chỉ https, http chỉ cho `localhost`, CORS `origin === value`). Chỉ chặt hơn BE ở chỗ bắt trùng và trim dòng.
  - Field bất biến là text read-only, không nằm trong state form. `ClientPatchSchema.strict()` + `CreateClientInput.strict()` chặn thêm một lớp.
  - Draft step-up đi qua allowlist (`ClientDraftSchema`/`NewClientDraftSchema`), không chứa secret, không tự gửi.
  - Lỗi BE render dạng text node (React escape) ⇒ không có XSS.
  - `adminCapable` tính ở server fn từ `OIDC_ISSUER`, chỉ dùng để hiển thị; issuer không xuống browser. BE vẫn là nơi quyết định.
  - A11y: `label`/`fieldset`+`legend`, `aria-invalid`, `aria-describedby` trỏ đúng hint/cảnh báo/lỗi, focus field lỗi đầu tiên, `role="alert"`/`role="status"`.
- **Task 3E [E2E]**: spec đi luồng thật, không có nhánh test trong code production. Có kiểm âm `fea:stepup` và kiểm token trong Web Storage; dọn client bằng PATCH `disabled`.
- **Phụ thuộc**: `@tanstack/react-form` 1.33.5 exact. Gián tiếp có `form-core` 1.33.5, `pacer-lite` 0.1.1, `devtools-event-client` 0.4.4. `devtools-event-client` có `bin` (`intent`) nhưng không có install script. Cả ba đều đủ tuổi ≥14 ngày ⇒ chấp nhận.
- **Verify lại ở lượt review**: `pnpm -C fe-admin typecheck` sạch, `lint` sạch, `test` 25 files / 512 pass; `pnpm -C be test -- admin.spec` 2 suites / 41 pass.

## 🔴 Blocker

- [x] **[FE] Mất cập nhật (lost update) giữa hai admin trên form sửa client** — `fe-admin/src/routes/clients/$clientId.tsx:91` (`toPatch(fields, client)`), `:98` (`changedValues(values, valuesFrom(client))`); `fe-admin/src/features/clients/client-form-schema.ts:201-209`.
  - **Vì sao**: `client` là `query.data` hiện tại của `useClient`. Query này có `staleTime` 0 và `refetchOnWindowFocus` mặc định, nên refetch khi tab lấy lại focus. Còn `ClientForm` giữ state riêng: form-core chỉ thay `defaultValues` khi form **chưa touched** (`FormApi.update`: `shouldUpdateValues = … && !this.state.isTouched`).
  - **Kịch bản**:
    1. Admin A mở `/clients/X` và sửa `scopes` (form đã touched).
    2. A chuyển sang tab khác để chép giá trị.
    3. Trong lúc đó admin B xoá một redirect URI bị lộ khỏi `redirectUris`.
    4. A quay lại tab ⇒ refetch ⇒ `client.redirectUris` là bản mới của B, nhưng form vẫn giữ bản cũ.
    5. A bấm lưu ⇒ `toPatch` thấy `redirectUris` khác ⇒ PATCH gửi `{scopes, redirectUris: <bản cũ>}` ⇒ URI B vừa xoá được thêm lại mà không ai hay biết.

    Kịch bản tương tự với `allowedResources` (cấp lại resource vừa bị thu hồi). Đường lưu draft step-up ở `:98` cũng dính lỗi: nó lưu cả field A không sửa, sau đó áp chúng lên dữ liệu mới. Như vậy biện pháp giảm thiểu mà fold tech-lead và DEBT-302 dựa vào ("chỉ gửi field đã đổi") không hoạt động. DEBT-302 chỉ chấp nhận xung đột **cùng field**; ở đây là ghi đè **field khác**, trên cấu hình nhạy cảm về bảo mật (redirect URI, resource được phép).
  - **Đề xuất**:
    - Lấy mốc là giá trị lúc form được nạp: `base = valuesFrom(client)` chụp khi `ClientForm` mount hoặc khi `reset` sau lưu thành công; với draft thì là dữ liệu server lúc khôi phục, **không** tính draft.
    - Field đổi = `changedValues(values, base)`. Body PATCH chỉ chứa những key đó, lấy giá trị từ `fields`. Có thể bỏ thêm key nào trùng với `client` hiện tại để tránh ghi vô ích.
    - Draft step-up dùng cùng `changedValues(values, base)`.
    - Test: render với client v1, sửa `scopes`, cập nhật query thành v2 có `redirectUris` khác ⇒ PATCH chỉ có `scopes`; làm tương tự cho đường step-up. Chạy mutation: đổi lại thành diff với `client` mới nhất ⇒ test phải đỏ.
    - Test `client-form-schema.test.ts` "diff is against the given (latest) server data" đang đóng đinh đúng ngữ nghĩa sai này, cần viết lại theo ngữ nghĩa mốc.

## Security invariants / trust boundaries đã kiểm

- **Exposure**:
  - Draft step-up là allowlist các field sửa được, không có clientId/type/method khi sửa, không có secret.
  - Log `read` 2xx sai schema chỉ có method + route (có test canary).
  - `adminResourceIdentifier` chỉ chạy phía server.
  - E2E kiểm `sessionStorage`/`localStorage` không chứa token và `fea:stepup` đã bị xoá.
- **Boundary input/output**:
  - Validator FE không lỏng hơn BE. BE vẫn chặn mọi thứ: wildcard, `javascript:`/`data:`, http ngoài localhost.
  - URI đã lưu chỉ render dạng text; lỗi BE render dạng text.
  - Input server fn qua zod `.strict()`, nên field bất biến hoặc lạ ⇒ bị từ chối trước khi gọi BE.
  - Không có thuộc tính `name` trên input, nên submit native trước hydrate không đưa giá trị lên URL (DEBT-305).
- **Authorization**: nhãn `adminCapable` chỉ để hiển thị, không ẩn lựa chọn. BE quyết định super_admin/confidential; 403 ⇒ thông điệp cố định.
- **State / chuỗi request**:
  - Draft dùng một lần: `takeIntent` được gọi một lần qua ref; DEBT-299 xoá draft cũ; draft gắn với `sub` + path + action.
  - Không tự gửi sau khi khôi phục (unit + E2E).
  - Create không retry; `uncertain` ⇒ báo, không gửi lại; submit bị khoá khi đang pending.
- **Failure behavior**: 2xx mutation có body hỏng ⇒ `uncertain` + invalidate (không coi là thành công hay thất bại sạch). GET sai schema ⇒ 500.
- **Concurrency**: refresh BFF (DEBT-296) — xem Tổng quan. Cập nhật đồng thời của admin ⇒ **🔴 ở trên**.

## 🟡 Nên sửa

- Không có ngoài 🔴. Các rủi ro còn lại đã có debt: DEBT-300…306.

## 💭 Nit

- [E2E] `e2e/config/env.ts:78`: `ACCESS_TOKEN_TTL=120` áp cho cả stack E2E để phục vụ một spec. Full suite xanh 2 lần nên chấp nhận được. Nếu sau này có spec kéo dài hơn 60 s qua nhiều lần ghi admin, cần nhớ rằng spec đó sẽ gặp step-up. Comment trong file đã ghi lý do, giữ nguyên.
- [E2E] `fe-admin-clients.spec.ts:72`: chờ cố định 65 s. Đây là cái giá được duyệt (Task 3E), không cần đổi.
- [FE] `$clientId.tsx:84` / `new.tsx:149`: lần render đầu luôn mount form "blank" rồi remount sang "restored" khi effect đọc được draft. Chỉ chớp một frame, không mất dữ liệu.

## ✂️ Ponytail

- `fe-admin/src/features/clients/client-form-schema.ts:L51`: shrink: `value.trim()` bị gọi hai lần. Gán `const v = value.trim()` một lần, hoặc dùng `URL.parse(v)` (trả `null`) thay cho cặp `canParse` + `new URL`.
- `fe-admin/src/features/clients/client-form-schema.ts:L139,L201`: shrink: có hai hàm diff (`changedValues` cho draft, `toPatch` cho body). Khi sửa 🔴, gộp thành một đường: các key đổi so với mốc ⇒ lấy giá trị đã parse cho các key đó.
- `fe-admin/src/features/clients/client-form-schema.ts:L188-195`: delete: `LIST_KEYS` sẽ thừa khi PATCH được dựng từ các key đã đổi.

net: -12 lines possible.

---

# Senior Review — 2026-10-22 (run 44 A6.1, lượt 2)

## Kết luận: REJECT

Fix retry 1 đúng hướng và đóng được kịch bản lượt 1 (sửa trước ⇒ refetch ⇒ lưu). Nhưng mốc `base` chỉ chụp lúc mount/sau lưu, trong khi form-core vẫn **theo** dữ liệu refetch khi form chưa touched. Mốc và giá trị trên form tách nhau ⇒ vẫn còn lost update trên field admin không sửa (đã tái hiện bằng test thăm dò). 🔴 lượt 1 **chưa đóng** (giữ `[ ]`). Chuyển lại **frontend-dev**.

## Tổng quan

- Đúng và tốt:
  - `changedValues(values, base)` dùng chung cho PATCH và draft.
  - `toPatch(fields, changed)` lấy giá trị đã parse của các key đổi; `LIST_KEYS` đã bỏ (ponytail lượt 1 đã làm).
  - Test cũ đóng đinh ngữ nghĩa sai đã viết lại.
  - 2 test UI refetch đi qua `focusManager` thật; mutation (mốc = latest, mốc gồm draft) ⇒ đỏ.
- Đã thử các biến thể bằng file test tạm (đã xoá; `git status` sạch phần test), render qua route tree thật dưới StrictMode:
  - **Lưu thành công rồi sửa tiếp** (refetch với field khác đổi trước lần lưu 2): PATCH 2 chỉ `{scopes}` ⇒ base dời đúng sang bản `saved`. Đạt (khi refetch sau lưu trả đúng bản `saved`; xem 🔴 cho trường hợp khác).
  - **`uncertain`**: base không dời. Form touched giữ giá trị của admin. Lưu lại chỉ gửi `{scopes}`. Đạt. Ghi chú: thông điệp "The latest data was reloaded" trong khi form vẫn hiện giá trị cũ thuộc DEBT-307.
  - **Draft khôi phục khi server đổi chính field trong draft**: draft đè lên (DEBT-302 chấp nhận). Nếu draft trùng giá trị server thì `changedValues` rỗng ⇒ "No changes to save". Đạt.
  - **Create form**: `new.tsx` không truyền `base`, `onSubmit(fields, values)` bỏ qua base ⇒ không ảnh hưởng. Đạt.
- Verify lượt 2: `pnpm -C fe-admin typecheck` sạch, `lint` sạch, `test` 25 files / 514 pass.

## 🔴 Blocker

- [x] **[FE] Lost update còn sót: mốc `base` đứng yên trong khi form chưa touched vẫn theo refetch** — `fe-admin/src/features/clients/client-form.tsx:78` (`baseRef = useRef(base ?? initial)`, chỉ đổi ở `:91`), `:82` (`defaultValues: initial`), `fe-admin/src/routes/clients/$clientId.tsx:85-87`.
  - **Vì sao**: `useForm` gọi `formApi.update(opts)` mỗi lần render. Trong `FormApi.update` của form-core 1.33.5 có điều kiện `shouldUpdateValues = defaultValues đổi && !isTouched`. Nên khi form **chưa touched**, refetch thay toàn bộ giá trị trên form bằng dữ liệu mới, còn `baseRef` vẫn là bản lúc mount. Từ đó `changedValues(values, base)` coi field người khác đổi là field "mình đổi". Khi refetch tiếp theo đến lúc form đã touched, form giữ bản trung gian, và PATCH gửi bản trung gian đó, ghi đè lần sửa sau của người khác.
  - **Tái hiện (test thăm dò, đã chạy)**:
    1. V1: `redirectUris = [cb, leaked, leaked2]`. Mở trang và chưa sửa gì.
    2. Refocus ⇒ V2 (B xoá `leaked2`): form hiện V2, base vẫn V1.
    3. A sửa `scopes`.
    4. Refocus ⇒ V3 (B xoá tiếp `leaked`): form đã touched nên vẫn giữ V2.
    5. A lưu ⇒ PATCH thực tế `{"redirectUris":["https://app.example/cb","https://leaked.example/cb"],"scopes":["openid","email"]}`.

    Kết quả: `leaked` mà B vừa thu hồi được **thêm lại**. Chuỗi thao tác rất thường gặp: mở trang, chuyển tab, quay lại, sửa, chuyển tab, quay lại, lưu.
  - Cùng cơ chế xảy ra ở hai chỗ khác:
    - **Sau khi khôi phục draft**: form restored chưa touched và theo refetch, nhưng base là dữ liệu server lúc remount.
    - **Sau khi lưu thành công**: `reset(saved)` làm form về trạng thái chưa touched. Refetch do invalidate trả bản mới hơn `saved` (có người ghi xen giữa) ⇒ form theo bản mới, base vẫn là `saved`.
  - Invariant bị vi phạm là chính câu trong comment `$clientId.tsx:92` ("never a field refetched since") và JSDoc `client-form.tsx:59` ("never follows a refetch"). Blast radius giống lượt 1: redirect URI hoặc resource bị thu hồi quay lại.
  - **Đề xuất** (chọn một, quan trọng là base và giá trị đang hiện luôn đi cùng nhau):
    - (a) **Đóng băng `defaultValues`**: `ClientForm` giữ `defaultValues` trong ref, chỉ đổi khi `reset(saved)` hoặc khi remount. Như vậy form không bao giờ theo refetch; giá trị mới chỉ hiện khi tải lại (khớp DEBT-307). Cần kiểm `reset(values)` có ghi `options.defaultValues` hay không: nếu render sau truyền lại bản cũ, form có thể bị kéo về bản cũ. Truyền đúng ref đã cập nhật sau lưu thì tránh được.
    - (b) **Cho base theo khi form còn chưa touched**: mỗi render, nếu `!form.state.isTouched` thì `baseRef.current = base` (prop = `valuesFrom(query.data)`, không gồm draft). Cách này đúng cả cho trường hợp restored và sau lưu.
  - Test bắt buộc (mutation: bỏ cơ chế đồng bộ ⇒ phải đỏ):
    - Kịch bản 5 bước ở trên ⇒ PATCH chỉ có `{scopes}`.
    - Biến thể restored: khôi phục draft ⇒ refocus V3 ⇒ sửa ⇒ refocus V4 ⇒ lưu ⇒ chỉ có field của draft cộng field vừa sửa.
    - Biến thể sau lưu: refetch sau invalidate trả bản khác `saved`.

## Security invariants / trust boundaries đã kiểm

- **State/concurrency**: phần lượt 1 đã đóng. Phần còn sót ⇒ 🔴 ở trên. Xung đột cùng field là người sau thắng (DEBT-302, chấp nhận).
- **Chuỗi request / step-up**: draft chỉ gồm key đã đổi (allowlist `EditDraftSchema`), dùng một lần, không tự gửi; `uncertain` không dời mốc, không gửi lại tự động.
- **Exposure / boundary / authorization**: không đổi so với lượt 1 (diff retry chỉ chạm `client-form.tsx`, `client-form-schema.ts`, `$clientId.tsx` và test). Không hồi quy.

## 🟡 Nên sửa

- Không có mới (REJECT, không mở debt). DEBT-307 giữ nguyên.

## 💭 Nit

- `client-form.tsx:59` và `$clientId.tsx:92`: comment khẳng định "never follows a refetch". Sau khi sửa 🔴, giữ comment khớp với cơ chế đã chọn.

## ✂️ Ponytail

- Lean already. Ship. (Ponytail lượt 1 đã được làm: gộp diff, bỏ `LIST_KEYS`. Phần `trim()` hai lần ở `client-form-schema.ts` vẫn còn, là nit nhỏ.)

# Senior Review — 2026-10-22 (run 44 A6.1, lượt 3)

## Kết luận: PASS

🔴 lượt 1 và 🔴 lượt 2 **đã đóng** (đã tick). `ClientForm` đóng băng `defaultValues` trong state `defaults`; `baseRef` chụp cùng lúc mount. Cả hai chỉ đổi khi: lưu thành công (`setDefaults(saved)` + `baseRef = saved` + `reset(saved)`, cùng một batch) hoặc remount theo `key` (khôi phục draft). Giá trị đang hiện và mốc diff luôn đi cùng nhau, nên `changedValues(values, base)` đúng là "những gì admin này đã sửa". Không hồi quy. Chuyển sang **tester**.

## Tổng quan

- Fix theo đề xuất (a) của lượt 2, gọn: thêm 1 `useState` và 1 `setDefaults`. Comment ở `client-form.tsx` (JSDoc + chỗ đóng băng) và `$clientId.tsx` đã khớp cơ chế (nit lượt 2 đã xong).
- Đã có 3 test bắt buộc (kịch bản 5 bước, restored, sau lưu). Các test đi qua route tree thật, dưới StrictMode, refocus thật qua `focusManager`. Mutation bỏ đóng băng ⇒ 3 đỏ; bỏ `setDefaults(saved)` ⇒ 1 đỏ.
- **Test thăm dò tạm** (`fe-admin/test/zz-probe-r3.test.tsx`, cùng harness, **đã xoá**):
  - P1. Lưu `uncertain`, rồi refetch (B xoá `leaked`), sửa CORS, refetch, lưu ⇒ chỉ gửi `{scopes, allowedCorsOrigins}`. Đạt.
  - P2. Khôi phục draft, refetch, lưu thành công, refetch trả bản mới hơn `saved`, sửa post-logout, refetch, lưu ⇒ PATCH 2 chỉ `{scopes}`, PATCH 3 chỉ `{postLogoutRedirectUris}`. Đạt.
  - P3. Lưu thành công, refetch bản mới hơn, không sửa, lưu ⇒ "No changes to save.", không gửi. Đạt.
  - P4. Sửa `redirectUris` rồi trả về như cũ, refetch, sửa `scopes`, refetch, lưu ⇒ chỉ `{scopes}`. Đạt.
  - P5. Khôi phục draft, refetch, sửa CORS, gặp step-up lần 2 ⇒ draft mới chỉ gồm `{scopes, allowedCorsOrigins}`. Đạt.
  - Kịch bản 5 bước của lượt 2 đã nằm trong test của dev (đã đọc và chạy).
  - Mutation trên probe (`defaultValues: initial`) ⇒ P2/P3/P5 đỏ. Nghĩa là probe phân biệt được lỗi. File được khôi phục bằng `cp`, sha256 khớp `f0adae23…`.
- Verify lượt 3: `pnpm -C fe-admin typecheck` sạch, `lint` sạch, `test` 25 files / 517 pass (sau khi xoá probe). Không chạy E2E (theo phạm vi). Dev đã báo E2E 28/28.

## 🔴 Blocker

- Không còn. (2 blocker trước đã đóng, xem tick ở lượt 1 và lượt 2.)

## Security invariants / trust boundaries đã kiểm

- **State/concurrency (lost update)**:
  - Field không sửa không bao giờ vào PATCH hoặc draft, qua mọi tổ hợp: refetch trước/sau khi sửa, `uncertain`, lưu thành công kèm refetch mới hơn, draft khôi phục, step-up lặp lại.
  - Xung đột trên cùng field vẫn là người sau thắng (DEBT-302, đã chấp nhận).
  - Form không hiện dữ liệu mới cho tới khi lưu hoặc tải lại (DEBT-307, đã chấp nhận).
- **Chuỗi request / step-up**: draft dùng một lần, theo allowlist, không tự gửi. Không đổi.
- **Exposure / boundary / authorization**: retry 2 chỉ chạm `client-form.tsx`, `$clientId.tsx` và test. Không hồi quy so với lượt 1.

## 🟡 Nên sửa

- Không có mới. DEBT-307 giữ nguyên (đã mô tả cả trường hợp đóng băng ở retry 2).

## 💭 Nit

- Không có mới. (`trim()` hai lần ở `client-form-schema.ts` từ lượt 2 vẫn là nit nhỏ, không mở debt.)

## ✂️ Ponytail

- Lean already. Ship.
