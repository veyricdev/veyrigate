# Senior Review — 2026-10-23 (run 45, A6.1b)

## Kết luận: PASS

Không có 🔴. Ba 🟡 không chặn → DEBT-313…315 trong `backlog.md`. Chuyển **tester**.

Verify độc lập (không E2E): `pnpm -C fe-admin typecheck` 0, `lint` 0, `test` 650/650 xanh.

## Tổng quan (ấn tượng chung + điểm tốt)

Thay đổi bám sát fold F1–F4 và gọn.
- **F3.1**: issue gọi thẳng server fn. Plaintext chỉ nằm trong `useState` của `IssueSecretBody`, component chỉ mount khi dialog mở, nên không có `useMutation` và không vào Query/MutationCache.
- **F1**: `Fragment key={clientId}` bọc toàn bộ thân detail.
- **F2**: `client.ts` có `schema: null` ⇒ 204. 2xx ≠ 204 của DELETE ⇒ `uncertain`. `setNoStore()` được đặt trước `adminCall`, nên cả nhánh trả failure lẫn nhánh throw đều có header.
- **F3.4**: step-up không intent. `reauthenticate()` tách khỏi `startStepUp` và không ghi storage.
- **Test**: canary `S3CR3T-…` được kiểm trên DOM, QueryCache, MutationCache, storage, URL, console và toast, cả khi dialog đang mở lẫn sau khi đóng bằng nút, Escape, `pagehide` và đổi `clientId`. Có case double-click, step-up không re-send, version validator (0, -1, 1.5, 1e9, "01", NaN) và 2xx sai schema/5xx/timeout không lộ secret.
- **E2E**: chứng minh đúng bằng `/revoke` + Basic: 200 hoặc 401 sau issue, rotate (grace), revoke v1, disable và enable. Message của `expect` không nội suy secret.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Exposure của plaintext**:
  - Nguồn duy nhất là response `POST /_serverFn` (issue). `cache-control: no-store` + `pragma: no-cache` được đặt cho mọi kết quả trả về (`instance.ts` `setNoStore`, `secrets.ts` gọi trước `adminCall`).
  - `read()` không bao giờ log body. 2xx sai schema ⇒ `unavailable` + `uncertain` với message cố định.
  - `AdminApiFailure` không mang body. `error_description` chỉ đi ra với 400/409, không đi ra với step-up/5xx.
  - Nhánh `catch` của dialog chỉ dùng `err.code`/message cố định.
  - Không có toast hay console chứa secret. Copy chỉ báo "Copied" hoặc "Copy failed" và không kèm secret.
  - Secret hiển thị trong `<code>` text, không qua `value`, không nằm trong `aria-live`.
- **SSR/dehydrate**: không prefetch. `open` mặc định false, nên SSR không bao giờ render body dialog.
- **Vòng đời**:
  - Đóng bằng nút hoặc Escape ⇒ Radix unmount `DialogContent` ⇒ mất state.
  - Click ngoài bị chặn (`onInteractOutside`).
  - `pagehide` ⇒ `setIssued(null)` + close.
  - Đổi `clientId` ⇒ remount nhờ key (đã kiểm bằng test có app-2 trong cache).
- **Double-submit**: `busy` ref + `pending` disabled. Đóng dialog bị khoá khi đang pending nên không có cửa sổ thứ hai. Test double-click ⇒ đúng 1 lần gọi (issue và revoke).
- **Hợp đồng BE**:
  - Disable/enable gửi PATCH `{ disabled }` một mình qua `ClientStatus`, tách khỏi form Settings.
  - 409 chỉ map sang `SELF_DISABLE_CONFLICT` khi `next === true`.
  - Revoke 404 ⇒ thông điệp riêng + `refetch`. `uncertain` ⇒ `invalidateQueries(clients.all)` (bao phủ `secrets`).
  - Version được kiểm bằng zod int 1…999 999 999 trước khi gọi BE. Path dùng `String(version)`, `clientId` qua `encodeURIComponent` + `ClientIdSchema`.
- **Authorization**: cross-tenant/admin-capable do BE quyết (404/403). FE không ẩn trước. 403 hiển thị thông điệp `forbidden` (có test).
- **Step-up**: không còn intent nào cho các action mới, nên `takeIntent` của form không đụng tới được. Sau khi quay lại thì không có gì tự chạy (có test với `sessionStorage` rỗng và server fn không bị gọi lại).
- **Failure**: timeout/5xx/2xx sai schema của issue ⇒ `UNCERTAIN_ISSUE`, không tự gửi lại, danh sách được refetch. Trường hợp lỗi bị throw (không phải `AdminRequestError`) xem 🟡 DEBT-315.

## 🟡 Nên sửa

🟡 **[FE] Rủi ro thao tác: dialog Disable đang mở tự biến thành "Enable" khi kết quả `uncertain`** (DEBT-313)
`client-status.tsx:L159-185`: hai `<ConfirmAction>` nằm cùng vị trí trong ternary nên React giữ **cùng instance**, kể cả state `open`/`result`.
- Diễn biến: Disable trả `uncertain` ⇒ `useInvalidateClients` refetch detail ⇒ `disabled` thành `true` trong khi dialog vẫn mở và đang hiện "The result is unknown…". Lúc này title, nút confirm và `run` đã đổi sang **Enable**.
- Vì sao: admin muốn "thử lại" việc disable (ví dụ client bị lộ secret) có thể bấm lại nút confirm ở cùng vị trí, và thao tác đó **bật lại** client. Nhãn có đổi, nhưng chính thông điệp lỗi đang gợi ý thử lại.
- Đề xuất: thêm `key={disabled ? "enable" : "disable"}` cho mỗi `ConfirmAction`. Dialog cũ sẽ đóng khi trạng thái thật đổi, thông điệp chuyển ra `notice`. Thêm 1 test cho disable `uncertain` (hiện chưa có).

🟡 **[FE] Dialog secret bị unmount khi refetch danh sách version lỗi, plaintext mất trước khi admin kịp copy** (DEBT-314)
`client-secrets.tsx:L47-49`: `IssueSecretDialog` chỉ render khi `secrets.isSuccess`.
- Vì sao: trong TanStack Query v5, refetch lỗi khi đã có data thì `status` thành `error`, nên `isSuccess` là false. Các lần refetch như vậy gồm: `invalidateQueries` ngay sau issue, refetch khi focus lại cửa sổ (admin chuyển sang vault để dán secret rồi quay về), và retry 2 lần cho lỗi transient. Chỉ cần một lần BE chập chờn là cả `Dialog` bị gỡ khỏi cây và secret một lần biến mất. Hướng hỏng này vẫn fail-closed về bảo mật, nhưng làm hỏng mục tiêu "hiện **một lần**": admin buộc phải rotate lại.
- Đề xuất: gate bằng `secrets.data !== undefined` (hoặc luôn render trigger, chỉ disable khi chưa có data). Bổ sung test: secret đang hiện, refetch lỗi ⇒ `issued-secret` vẫn còn.

🟡 **[FE] Issue bị lỗi throw (không phải `AdminRequestError`) ⇒ "Something went wrong. Please try again."** (DEBT-315)
`confirm-action.tsx:L22` được dùng cho `client-secrets.tsx:L199`.
- Vì sao: với một POST không idempotent, việc fetch trình duyệt → BFF thất bại sau khi BFF đã gọi BE (mất kết nối, 500 từ boundary) là trường hợp *không biết kết quả*. Thông điệp hiện tại lại mời gửi lại, trái tinh thần F3.5. Hậu quả thấp: rotate thêm lần nữa chỉ rút ngắn grace (`client-credential.service.ts` rotate không revoke), nhưng có thể sinh version "lạ" mà admin không biết để revoke.
- Đề xuất: cho `outcomeOf` một tham số, hoặc để riêng dialog issue coi lỗi không phải `AdminRequestError` là `uncertainText`. Revoke/disable vốn idempotent nên giữ nguyên.

## 💭 Nit

- **Focus sau Revoke**: `client-secrets.tsx:L91`, sau khi Revoke thành công thì hàng chuyển `revoked`, trigger "Revoke" unmount nên focus rơi về `body`. Có thể đưa focus về heading "Secrets" hoặc vùng `notice`. Tương tự, Revoke `uncertain` làm dialog biến mất cùng thông điệp nếu version đã thật sự bị revoke.
- **Lọc `waitForResponse` trong E2E**: `e2e/tests/fe-admin-secrets.spec.ts:L40` bắt *mọi* POST `/_serverFn/`. Hiện tại chỉ issue là POST trong khoảng đó, nhưng sẽ dễ vỡ nếu thêm POST nền. Có thể lọc thêm theo `status()===200`, hoặc kiểm `issued-secret` xuất hiện sau đúng response đó.
- **Header khi boundary throw**: header `no-store` được đặt trên `getResponseHeaders()` trước khi `serverFnErrorBoundary` throw. Unit test chỉ phủ nhánh trả failure (mock Start), chưa phủ nhánh throw (unknown 4xx ⇒ 500). Nhánh này không mang secret nên rủi ro rất thấp, nhưng nếu muốn đúng nguyên văn "kể cả lỗi" thì nên kiểm trong E2E/integration.
- **Live region**: các `<p role="status">` được chèn cùng lúc với vùng chứa chúng, nên một số screen reader không đọc. Cảnh báo "Copy this secret now" nằm trong `DialogTitle`/`DialogDescription` mới được đọc chắc chắn. Có thể chuyển câu cảnh báo vào `DialogDescription` của màn issued.

## ✂️ Ponytail

- `client-secrets.tsx:L157-165`: shrink: `interface IssueSecretBodyProps` chỉ dùng một lần. Inline type vào tham số.
- `client-secrets.tsx:L219-220`: shrink: bỏ biến `refreshed`. Filter `grace && version < issued.version` đã đủ, vì danh sách cũ chưa có grace mới thì chỉ hiện grace cũ, và grace cũ vẫn đúng sự thật.

net: -10 lines possible.

---

# Senior Review — Vòng 2 — 2026-10-23 (sau frontend-dev retry 1)

## Kết luận: PASS

Đường đảo ngược ý định của DEBT-313 đã đóng, và không còn 🔴 nào. Tôi tự verify: fe-admin `typecheck` 0, `lint` 0, `test` **674/674**, không còn `it.fails`. Tôi không chạy E2E.

Ngoài ra tôi viết một test nháp tạm, chạy xong đã xoá; `git status test/` không đổi. Test nháp xác nhận hai điểm 🟡 bên dưới:
- Disable thành công ⇒ `document.activeElement === BODY`.
- Disable/revoke ném lỗi không phải `AdminRequestError` ⇒ `getClient`/`listSecrets` gọi 1 → 1 lần, tức là không đọc lại.

## Tổng quan

Bản sửa gọn và đúng chỗ.
- `key="enable"`/`key="disable"` tách hẳn state `open`/`result` của hai `ConfirmAction`.
- `uncertain` hoặc throw ⇒ `{ done: UNCERTAIN_STATUS }`. Dialog đóng và thông điệp nằm ở `notice` của `ClientStatus`. `notice` không bị unmount khi key đổi, vì nó là state của component cha.
- Ba test DEBT-313 mới phủ đủ ba nhánh: uncertain đã qua, uncertain không qua, và trạng thái đổi khi dialog đang mở.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **DEBT-313, không còn đường một click đảo ngược.**
  - Với uncertain là `AdminRequestError`: `onSettled` được await (invalidate + refetch) trước khi `mutateAsync` reject. Khi dữ liệu mới đến, `disabled` lật ⇒ key đổi ⇒ dialog cũ unmount. `setOpen(false)` gọi lên instance đã unmount là no-op, còn `onDone` vẫn ghi `notice` ở cha.
  - Sau đó, muốn Enable phải bấm **2** lần có chủ đích: trigger "Enable client" rồi confirm trong dialog có title "Enable this client?".
  - Với step-up, hoặc lỗi xác định (403/409): dialog giữ nguyên, nhưng ghi chưa xảy ra nên trạng thái không lật. Nếu trạng thái lật vì nguồn khác thì key thay dialog, 0 PATCH (test "replaced (not relabelled)").
  - Nếu trạng thái lật trong lúc đang pending: instance cũ unmount, `run` vẫn chạy xong, `notice` đúng. Không có PATCH thứ hai.
- **`notice`** chỉ bị ghi đè bởi kết quả `done` của lần bấm sau, và đó là hành vi đúng. Một lỗi xác định nằm trong dialog không xoá `notice`. Điều này chấp nhận được.
- **DEBT-315** (`outcomeOf`: throw ⇒ text uncertain cho cả issue/revoke/disable): **đúng về ngữ nghĩa**. Throw ở server fn/BFF có thể xảy ra *sau* khi BE đã ghi, nên "hãy thử lại" là sai với mọi lệnh ghi. Mở rộng như vậy cũng không tạo đường đảo ngược:
  - revoke lặp lại ⇒ 404 ⇒ "already revoked";
  - disable/enable lặp lại cùng giá trị ⇒ idempotent;
  - disable còn đóng dialog.

  Vòng 1 tôi đề xuất giữ nguyên revoke/disable. Tôi rút lại đề xuất đó: cách của dev nhất quán hơn. Còn một chỗ lệch, xem DEBT-318.
- **DEBT-314/316, plaintext vẫn fail-closed.** Secret vẫn chỉ ở `useState` của `IssueSecretBody`: không vào `useMutation`, Query/MutationCache, storage, URL hay log. Gate `data !== undefined` chỉ giữ cho dialog *đang mở* không bị unmount khi refetch lỗi; đóng, Escape hay pagehide vẫn xoá secret. `Fragment key={clientId}` (DEBT-308) giữ nguyên, nên đổi client vẫn remount. Đã đối chiếu test canary trong risk (7 case + DEBT-314/316).
- **DEBT-316, trade-off `not_found` khi refetch.** Thân trang cũ vẫn hiện dưới alert "This client does not exist in your tenant." **Tôi chấp nhận**:
  - Mọi lệnh ghi (PATCH, issue, revoke) đi qua BE, và BE trả 404 theo tenant ⇒ fail-closed ở trust boundary; UI hiện lỗi trong dialog/form.
  - Không có đường nào làm một lệnh ghi lên client đã xoá "thành công" mà không báo.
  - Chỉ còn rủi ro UX: alert nằm trên đầu trang, admin đang cuộn xuống có thể không thấy (💭 DEBT-320).
- **Exposure:** text `UNCERTAIN_*` là hằng, không nội suy `err.message` của throw (canary test "throw … message holding the canary").

## 🟡 Nên sửa

- **DEBT-318: throw không làm đọc lại, nhưng thông điệp nói "was reloaded".**
  - `fe-admin/src/features/admin-api/hooks.ts:L33` `useInvalidateClients` chỉ invalidate khi `!error || (error instanceof AdminRequestError && error.uncertain)`.
  - Từ DEBT-315, throw được coi là uncertain, nhưng hook vẫn không refetch. Với disable/enable, `UNCERTAIN_STATUS` ("The latest data was reloaded") và revoke ("The version list was reloaded") vì vậy **sai sự thật**: UI hiện trạng thái cũ. Issue không bị vì `finally` tự invalidate.
  - Vì sao chưa là 🔴: lặp lại cùng hành động là idempotent hoặc trả 404, nên không đảo ngược ý định. Nhưng admin "check status" sẽ nhìn vào dữ liệu cũ.
  - Đề xuất: `if (!error || !(error instanceof AdminRequestError) || error.uncertain)` (1 dòng), kèm 1 test cho throw ⇒ `getClient`/`listSecrets` được gọi lại.
- **DEBT-319: focus rơi về `body` sau khi đổi trạng thái** (WCAG 2.4.3).
  - Đây là hệ quả của `key`: `fe-admin/src/features/clients/client-status.tsx:L44-72`, Disable/Enable thành công (và uncertain đã qua) ⇒ refetch ⇒ cả `ConfirmAction` kèm trigger bị thay ⇒ Radix trả focus về trigger cũ, đã detach ⇒ `BODY` (đã đo bằng test nháp). Trước retry, focus về đúng trigger (cùng instance).
  - Thêm vào đó, `<p role="status">` (L37-41) được mount cùng lúc với nội dung, nên screen reader có thể không đọc `UNCERTAIN_STATUS`.
  - Đề xuất: luôn render vùng `role="status"` (rỗng khi chưa có notice); sau `onDone`, focus `h2#status-title` (`tabIndex={-1}`) hoặc trigger mới. Cách này gộp được 💭 "focus sau Revoke" của vòng 1.

## 💭 Nit

- **DEBT-320.** Khi refetch detail trả `not_found` (lỗi kết thúc, không phải tạm thời), có thể ẩn các nút ghi (Settings submit, Rotate, Disable) và chỉ giữ dialog secret đang mở. Admin cuộn xuống dưới không thấy alert, chỉ biết khi BE trả 404.
- `client-status.tsx:L27`: nhánh `!(err instanceof AdminRequestError) || err.uncertain` lặp một phần logic của `outcomeOf`. Chấp nhận được, vì ở đây cần `done` chứ không cần `error`; một comment đã giải thích.

## ✂️ Ponytail

Lean already. Ship. (Retry chỉ thêm 2 key, 1 nhánh, 1 điều kiện. Hai mục shrink của vòng 1 vẫn giữ nguyên, không có gì mới.)
