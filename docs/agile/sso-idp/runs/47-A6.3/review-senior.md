# Senior Review — 2026-10-23

## Kết luận: PASS

Không có 🔴. Còn 3 mục 🟡 chưa sửa, đã ghi vào `backlog.md` (DEBT-339…341).

## Tổng quan (ấn tượng chung + điểm tốt)

Đã review toàn bộ diff chưa commit so với `edffce0`, trừ `.github/agents`, `.vscode/mcp.json`, `.mcp.json` và `.claude/`. Đối chiếu với mục "Fold tech-lead" trong `tasks.md`.

Đã tự chạy lại:
- fe-admin: `test` 38 file / 998 test xanh, `typecheck` 0 lỗi, `lint` 0 lỗi;
- be: `pnpm test` 32 suite / 414 test xanh, `typecheck` 0 lỗi.

Không chạy E2E và int-test, theo đúng chỉ dẫn. Kết quả của hai phần này lấy từ log của dev.

Điểm tốt:
- **BE Task 0 chỉ đổi metadata.** Diff controller chỉ thêm `@ApiOkResponse`/`@ApiNoContentResponse`, không đụng runtime, mapper hay DTO request. Các view DTO `implements` interface của mapper, nên nếu mapper đổi thì compile sẽ báo lệch. `admin.spec.ts` kiểm key, `$ref`, và kiểm 3 op 204 không có `content`.
- **Seed E2E đúng ranh giới tin cậy:**
  - giữ guard `NODE_ENV=test` + DB `sso-idp-e2e` (hai lớp);
  - kiểm email trùng admin/dev **trước khi kết nối**, và kiểm lại email trùng admin trước mọi lần ghi;
  - tách `resetAdminUser` nên không còn `return` sớm;
  - user và membership chỉ được ghi khi lệch, nên chạy lại là hội tụ;
  - log chỉ in id, không in password hay hash.

  Mutation test của dev (bỏ return sớm, bỏ guard, bỏ check roles) đều bị bắt.
- **Email filter không lọt ra ngoài.** `listUsers` là server fn POST. Email là state của form: input không có `name`, submit được chặn. Route trong log là template. `describe(err)` chỉ log name/message, và message của mình không chứa query. Test canary có phủ các trường hợp timeout, 5xx và sai schema.
- **zod allowlist ở chế độ strip.** Có test với `passwordHash`/`failedLoginCount`/`tokenHash` cho thấy các field này bị loại khỏi dữ liệu trả về.
- **Lý do uncertain đúng theo từng loại ghi:**
  - lock/unlock: đóng dialog và hiện thông điệp bên ngoài (theo khuôn DEBT-313). Mỗi dialog có `key` riêng nên một Lock đang mở không bao giờ bị biến thành Unlock;
  - revoke-all và revoke family: idempotent nên giữ dialog và cho bấm lại an toàn;
  - consent: không idempotent nên đóng dialog và hiện thông điệp DEBT-151.

  Không có đường ghi nào tự gửi lại. `retry` mặc định là 0. `busy` ref chặn double click.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Identity / tự khoá**
  - `self` được so sánh bằng lowercase `user.id` với `viewer.sub`.
  - Nút Lock bị ẩn với chính mình. BE vẫn trả 403, nên gate ở FE chỉ là UX.
  - Tự revoke-all: có cảnh báo `role="alert"`. Khi thành công thì gọi `signInAgain()` với `returnTo` = `/users/<hex>`, không chứa email.
  - Tự revoke-all mà kết quả `uncertain` nhưng thực ra đã áp dụng: `onSettled` invalidate ⇒ refetch nhận 401 ⇒ BFF refresh thất bại vì family đã bị revoke ⇒ `QueryCache.onError` gọi `signInAgain()`. Không kẹt ở trạng thái nửa đăng nhập.
  - Tự revoke family: có cảnh báo "signs you out when the console next refreshes". Mô tả này khớp BE: access token vẫn sống tới `exp`.
- **Authorization**
  - BE là điểm thực thi duy nhất. Với tenant_admin xem tài khoản admin, FE ẩn Lock/Unlock/Revoke-all.
  - Families/consents không bị gate theo `protectedTarget`. Điều này đúng với BE: không qua `assertMayTouchAccount`, đã giới hạn theo client của tenant.
  - Mọi id được validate bằng regex trước khi gọi server fn, và được `encodeURIComponent` trong path. Test xác nhận các id `../x`, `a/b` hay 25 hex đều không gây `fetch`.
- **Failure behavior**
  - GET 5xx không bị coi là `uncertain`. POST/DELETE gặp timeout, 5xx hoặc sai schema thì là `uncertain`.
  - Lỗi ném ra ngoài `AdminRequestError` được coi là uncertain (DEBT-315).
  - `not_found` (kể cả khi đọc lại sau một lần ghi) thì ẩn mọi nút ghi (DEBT-320).
- **Exposure**
  - Email chỉ nằm trong body POST và trong query key ở bộ nhớ. List chỉ chạy phía client, nên query key không được dehydrate vào HTML SSR.
  - Ngày hiển thị dạng ISO text. email/clientId/resource render dạng text; link của user đi theo id.
  - E2E có kiểm `page.url()` và mọi request URL không chứa email.
- **Đảo ngược ý định / leo thang quyền**
  - Không có UI cho roles (47b).
  - Lock và Unlock là hai instance khác nhau (`key`), và lock uncertain thì đóng dialog. Vì vậy một lần bấm không thể vô tình đảo ngược ý định.
  - Revoke-all lặp lại chỉ làm cùng một việc.
- **Seed**: không ghi gì ngoài DB E2E. Email trùng admin/dev thì throw trước khi ghi. Không có admin role cho user E2E. Không log password.

## 🟡 Nên sửa

🟡 **A11y/thông điệp: dialog revoke family biến mất khi kết quả uncertain nhưng thực ra đã áp dụng** (DEBT-339)
`fe-admin/src/features/users/user-grants.tsx:96,134` — khi uncertain, `outcomeOf` giữ dialog mở, nhưng `useInvalidateOn` đọc lại danh sách. Nếu family thực ra đã bị revoke thì `f.active` thành false, và `ConfirmAction` nằm trong hàng đó bị unmount cùng dialog.
Vì sao: thông điệp uncertain biến mất, vùng `role="status"` không được cập nhật, và focus rơi về `body`. Người dùng trình đọc màn hình mất ngữ cảnh. Không mất dữ liệu: bảng vẫn hiện "Revoked …".
Đề xuất: cân nhắc dùng khuôn của lock (`{ done: FAMILY_UNCERTAIN }`, đóng dialog rồi announce + focus heading), hoặc giữ instance dialog bên ngoài hàng. Cần thêm test "uncertain, refetch trả family đã revoke ⇒ status có thông điệp, focus ở heading".

🟡 **E2E: bước dọn trong `finally` dùng access token có thể đã hết hạn** (DEBT-340)
`e2e/tests/fe-admin-users.spec.ts:29,108` — `accessToken` được lấy ở đầu test, trong khi stack E2E chạy `ACCESS_TOKEN_TTL=120` và `test.setTimeout(120_000)`. Ở nhánh lỗi chậm (đúng lúc cần dọn), lệnh unlock nhận 401 và bị `.catch` nuốt, nên dọn dẹp không có tác dụng mà không ai biết.
Vì sao: rủi ro thấp, vì seed reset user mỗi lần chạy và không spec nào khác dùng `e2e-user`. Nhưng comment "never leave it locked" đang hứa nhiều hơn những gì code làm.
Đề xuất: lấy token mới trong `finally` (`adminToken(newContext)`), hoặc sửa comment cho đúng sự thật (seed là cơ chế dọn chính).

🟡 **Ponytail** (DEBT-341): xem mục ✂️. Đây là các thu gọn nhỏ, không ảnh hưởng hành vi.

## 💭 Nit

- `fe-admin/src/routes/users/index.tsx:121`: state `nextStatus` của `<select>` khởi tạo từ search một lần, nên Back/Forward làm đổi `status` trên URL mà select không theo. Bảng vẫn đúng.
- `be/test/e2e/seed-e2e-admin.ts:113`: guard lần hai trong `seedE2eAdmin` chỉ so với email admin. Email dev chỉ được chặn ở `readE2eUserConfig`. Hiện chấp nhận được vì `main` luôn đi qua hàm đó.
- `be/test/e2e/seed-e2e-admin.ts:219`: `$min: { emailVerifiedAt }` không ghi đè nếu field là `null` tường minh (theo thứ tự so sánh BSON, null nhỏ hơn date). Codebase dùng `$unset` nên hiện không xảy ra; dùng `$set` có điều kiện thì chắc hơn.
- `e2e/tests/support/fe-admin.ts:41`: `waitForTimeout(500)` là một khoảng chờ cố định. Có thể thay bằng `expect.poll` trên URL, nhưng đã xanh ×2 nên không gấp.

## ✂️ Ponytail

- fe-admin/src/features/admin-api/hooks.ts:L176: shrink: `useInvalidateUsers` chỉ dùng một lần. Gọi thẳng `useInvalidateOn(adminKeys.users.all)` trong `useUserWrite`.
- fe-admin/src/server/admin-api/client.ts:L309-L315: shrink: `listUsers` tự dựng `URLSearchParams` 4 dòng, lặp lại `pageQuery`. Có thể mở rộng `pageQuery` nhận thêm `email`/`status` (bỏ qua `undefined`).
- fe-admin/src/routes/users/index.tsx:L54: shrink: biểu thức ternary 4 nhánh cho trạng thái rỗng. Hai nhánh "No more users on this page." và "No matching users." có thể gộp vào nhánh mặc định, vì cursor rỗng là hiếm.

net: -8 lines possible.
