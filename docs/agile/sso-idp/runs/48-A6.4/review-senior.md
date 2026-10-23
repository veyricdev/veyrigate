# Senior Review — 2026-10-23

## Kết luận: PASS

Phạm vi: diff chưa commit so với `2e171cc` (bỏ `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`). Đối chiếu fold tech-lead trong `tasks.md` (F0–F4).

Đã chạy lại:
- `pnpm -C fe-admin typecheck`: 0 lỗi.
- vitest `audit-fn`, `audit-ui`, `users-risk`, `users-ui`, `admin-schema-types`: 5 file / 121 passed.
- BE `pnpm test -- admin.spec.ts oauth/token`: 3 suite / 64 passed.
- Không chạy int và E2E. Tin số liệu backend-dev (int 1211) và frontend-dev (E2E 32 ×2).

## Tổng quan (ấn tượng chung + điểm tốt)

Đây là run gọn và bám sát fold.

**BE (Task 0)**
- `tenantId` được thêm đúng một điểm, đi theo đường `token.controller` (client đã load và xác thực) → `issueForRefresh` → `rotate` → `classifyMiss` → `revokeFamily`.
- Không đọc giá trị nào từ body, header hay query.
- Các ràng buộc cũ giữ nguyên:
  - stamp-first và family revoke vẫn như trước;
  - `classifyMiss` vẫn tìm theo `{ tokenHash, clientId }`, nên family bị revoke và tenant gắn vào luôn thuộc cùng client;
  - audit lỗi vẫn fail-closed.
- `TOKEN_REFRESHED` có assert là vẫn không có tenant.

**FE**
- `safeMetadata` chạy ở server-only (`schemas.ts`), trước khi dữ liệu tới trình duyệt.
- `z.object` mặc định strip `tenantId`/`_id`.
- Mọi giá trị render dạng text. Link chỉ dựng qua `<Link params>` sau khi id qua schema.
- Đọc search theo key có tên, nên `tenantId` lạ trong URL không lọt vào server fn. Input server fn có `.strict()` thêm một lớp nữa.

**Test**: có test âm cho XSS, email, `javascript:`, key lạ và metadata lồng nhau. Mutation được ghi đủ.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Tenant attribution (BE)**
  - `tenantId` chỉ lấy từ `client.tenantId`. Field này `required: true` ở `client.schema.ts:30`, và client đã qua `clientAuth`.
  - `classifyMiss` lọc `{ tokenHash, clientId }`, nên client của tenant B không thể làm event bị gắn vào tenant A hay làm revoke family của A.
  - `{ ...audit, tenantId }` chỉ được truyền vào `rotate`. `recheckAfterRotate` và các event khác không nhận tenant, đúng phạm vi DEBT-140.
  - Event không có client thì vẫn hành xử như cũ.
- **Read authorization**
  - `listForTenant` gán `tenantId` sau cùng. Int test (`admin-users.int-spec`) cho thấy tenant A thấy event, tenant B nhận `[]`.
  - View không có `tenantId`, đã assert `not.toHaveProperty`.
- **Runbook drill §2**
  - Đổi kỳ vọng là ĐÚNG: test là characterisation của DEBT-140, và hành vi đổi có chủ đích.
  - `runbook-ops.md` §2 vẫn nói mongosh là nguồn đầy đủ và không cho kết luận "không sự cố" chỉ từ API. Cách viết này đúng, vì các event khác vẫn chưa gắn tenant.
- **Exposure**
  - URL chỉ chứa enum, id opaque (`AuditIdSchema` không cho `@` hay khoảng trắng, áp ở `validateSearch`, ở form và ở input server fn) và ISO.
  - IP và UA chỉ hiện trong Details.
  - Metadata đi qua denylist (mirror `isSecretKey` của BE, thêm `hash`) và chỉ nhận primitive.
  - Key `__proto__` khi gán primitive thì bị bỏ qua, không gây prototype pollution.
- **Output encoding**
  - Không có `dangerouslySetInnerHTML` và không có `href` dựng từ dữ liệu.
  - `/clients/$clientId` chỉ link khi qua `ClientIdSchema`; `/users/$userId` chỉ link khi id là 24 hex.
- **Failure**
  - Đây là thao tác đọc nên không có trạng thái uncertain. 5xx hiện `unavailable` kèm "Try again".
  - Cursor sai trả `invalid_request` và có nút "First page".
- **Lệch fold `z.unknown().optional().transform(safeMetadata)` thay cho `z.record(...)`**: HỢP LÝ.
  - Với `z.record`, metadata là mảng hoặc chuỗi (dữ liệu `Mixed` cũ) sẽ làm fail parse cả trang, trái yêu cầu "shape lạ không làm fail trang".
  - `safeMetadata` tự loại non-object và array, nên giữ được cả hai yêu cầu.

## 🟡 Nên sửa

🟡 **A11y: tên nút Details không phân biệt**
`fe-admin/src/routes/audit/index.tsx:L186-L195`: mọi hàng có một nút tên đúng "Details".
Vì sao: người dùng screen reader mở danh sách nút (rotor hoặc Tab) sẽ nghe 20 lần "Details, collapsed" mà không biết nút thuộc event nào (WCAG 2.4.6). `aria-controls` không giúp ở đây vì phần lớn AT không đọc nó.
Đề xuất: thêm text ẩn, ví dụ `<span className="sr-only"> for {e.action} at {e.timestamp}</span>`. E2E dùng `getByRole("button", { name: "Details" })` không `exact`, nên vẫn khớp. → DEBT-346.

## 💭 Nit

- `fe-admin/src/routes/audit/index.tsx:L241` (`Details`): React key là label `k`. Nếu metadata có key trùng với nhãn cố định ("IP", "Reason"…) thì key bị trùng. BE hiện dùng camelCase nên chưa xảy ra. Cân nhắc dùng `key={i}`, hoặc tiền tố `m:` cho metadata.
- `fe-admin/src/routes/audit/index.tsx` `toLocalInput`: cắt mili giây. Nếu URL có `from` kèm ms (vd. link ngoài), bấm Filter lại sẽ làm tròn xuống giây và mở rộng khoảng thời gian một chút. Vô hại.
- `fe-admin/src/routes/users/index.tsx:L53`: "No users." giờ hiện cả khi lọc `status` hoặc ở trang `after`, nên mất thông tin "No matching users" / "No more users on this page". Fold DEBT-341 đã chấp nhận gộp, ghi lại để biết.

## ✂️ Ponytail

- `fe-admin/src/features/admin-api/keys.ts:L29`: yagni: `audit.all` không có caller nào (audit chỉ đọc, không invalidate). Xoá dòng, giữ `list`.
- `fe-admin/src/routes/audit/index.tsx:L96,L128,L133`: shrink: prop `nextPage` chỉ để thêm " (next page)" vào caption sr-only. Bỏ prop, caption để "Audit events".

net: -3 lines possible.

→ DEBT-347 (gộp 2 dòng ponytail).
