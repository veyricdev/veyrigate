# Tech Lead Review — 2026-10-26 (run 55, sweep debt bảo mật OAuth)

## Kết luận: PASS (có fold, không tách run)

Ràng buộc cụ thể đã fold vào cuối `tasks.md`, mục "Fold tech-lead (2026-10-26)". Fold ưu tiên hơn text gốc khi mâu thuẫn. Thứ tự giao **backend-dev**: Task 4 → Task 2 → Task 3 → Task 1. Không có [FE].

Đối chiếu code thật ở HEAD `e94267b` (CodeGraph 1.6.2, `status`/`sync` OK):

| Debt | Còn đúng? | Bằng chứng ở HEAD | Rủi ro thật | Quyết định |
|---|---|---|---|---|
| DEBT-123 | Còn | `AuthorizeRequestContext` không có trường phiên; `decideConsent` (`authorize.service.ts:338`) cấp code cho `session` lúc POST, không so với phiên tạo context. `CsrfGuard` chỉ ràng buộc token CSRF với cookie phiên **của người POST**, không ràng buộc `request_id` | Thấp: ai có `request_id` của nạn nhân (form body, khó lộ) POST bằng phiên mình ⇒ code cho tài khoản kẻ tấn công kèm `state` + `code_challenge` của nạn nhân ⇒ login CSRF ở RP | Làm (F1) |
| DEBT-130 | Còn | Nhánh `ctx.kind !== 'consent'` và `!approve` trả `ctx.redirectUri` trước khi `findByClientId`; `resume` nhánh `reauthAfter` cũng redirect `ctx.redirectUri` không kiểm lại | Thấp: không có code, nhưng lộ `state` + `iss` tới URI admin vừa gỡ / client vừa disable | Làm (F1, gồm `resume`) |
| DEBT-177 | Còn | `isAccessTokenLive` (`access-token-liveness.ts:68`) chỉ kiểm sid/client/aud/user; `ClientLookup` chỉ trả `allowedResources`. Chỉ `AdminTokenGuard` tự kiểm `isAdminCapableClient` | Thấp: `/introspect` `active:true`, `/userinfo` 200 với AT `aud=admin` của client đã hạ cấp (≤ 15'); không cấp quyền admin | Làm (F2) |
| DEBT-216 | Còn, **rộng hơn sau run 54** | Callback `recheck` ở `handleRefreshGrant` chỉ kiểm `fresh` tồn tại + `subjectFailure`; `rotate` lọc theo identifiers từ client lúc client-auth. Run 54 đặt bước ký (Vault, tới 2–4 × `VAULT_TIMEOUT_MS`) giữa client-auth và `rotate` ⇒ cửa sổ race dài hơn trước | Thấp–vừa: 1 AT `aud` cũ (≤ 15') + successor | Làm (F3) |
| DEBT-409 | Còn, nhưng nhỏ hơn mô tả | Nhánh refresh-metadata của `signOnce` chỉ chạy với `VaultStatusError` 400/5xx, không với timeout. Hố đen: 2 × timeout (cache còn) hoặc 4 × (cache hết) ≈ 4–8 s mặc định, trần ~40 s | Không phải lỗ hổng: fail-closed, trong TTL code 60 s | **Rút khỏi run 55**, giữ mở (X6). AbortSignal xuyên `KeyProvider` là đổi interface khi chưa có số đo p99 |
| DEBT-410 | Còn | `listKeys` (`vault-transit-key-provider.ts:175`) không bọc `asUnavailable`; `AdminAuthErrorFilter` chỉ `@Catch(AdminAuthError)` nên `KeyProviderUnavailableError` sẽ tự ra 503 qua filter toàn cục khi được bọc. Có thể xảy ra khi cache JWKS của verifier còn mà cache key-set của provider hết | Vận hành (500 thay 503) | Làm `listKeys`; `rotate` giữ 500 (F4) |

Không debt nào "đã xong gián tiếp", nên không đóng mục nào trong backlog ở bước này.

## Kiến trúc đề xuất

Không đổi kiến trúc, không đổi cấu trúc Redis/Mongo (ngoài một trường tuỳ chọn `sessionRef` trong JSON context Redis có TTL 10'). Mọi sửa đổi đều là thêm điều kiện fail-closed vào các predicate đã có:

- **F1**: `decideConsent` theo thứ tự consume → kiểm lại client + URI (mọi nhánh) → kind → `sessionRef` → deny → resource/admin (approve) → member → grant. Lệch phiên ⇒ trang first-party, **không** redirect `login_required` như gợi ý cũ của backlog, vì redirect đó cũng trao `state` của nạn nhân cho phiên lạ. Không đụng DEBT-121 (lệch clock `reauthAfter`): `sessionRef` của context consent không giải quyết được DEBT-121, nên không gộp.
- **F2**: một điều kiện trong `isAccessTokenLive` dùng đúng `isAdminCapableClient`; `adminAud` truyền vào (hàm vẫn thuần, không phụ thuộc config).
- **F3**: callback `recheck` nhận thêm `result.resource`, dùng cùng predicate/reason với `recheckCodeGrant` (`resource_not_allowed`). Vẫn chạy **sau** `rotate`, đúng vị trí re-check của run 54, nên thiết kế ký-trước-commit không bị ảnh hưởng.
- **F4**: một `try/catch asUnavailable` ở `listKeys`.

### Không phá run 54

F3 là thay đổi duy nhất chạm `/token`. Nó chỉ thêm lý do refuse trong `recheckAfterRotate`, dùng đường revoke + unlink + audit + `invalid_grant` sẵn có. Không thêm bước ký, không đổi `peek`/`consume`/`rotate`, không đổi thứ tự. Bảng interleaving refresh của run 54 vẫn đúng, chỉ thêm một dòng: "A ký xong, admin gỡ resource, A rotate thắng ⇒ recheck ⇒ revoke family, `invalid_grant`, token đã ký bị bỏ" (cùng loại với dòng #4 của run 54).

## Điểm mạnh

- Phạm vi gọn, đúng nhóm "re-check trạng thái hiện tại trước khi tin dữ liệu đã lưu", nhất quán với DEBT-207/210/174.
- Hạ tầng test đã đủ: harness `afterRotate`/`dropResource` (`token-code-recheck.int-spec.ts`), helper đổi client của `admin-public-client.int-spec.ts`, filter 503 toàn cục, fetchFn giả của provider.
- Không cần migration, không đổi API công khai.

## Vấn đề (đã fold, dev bắt buộc theo fold)

- [x] Tasks chưa xác minh từng debt với HEAD ⇒ đã làm (bảng trên). DEBT-409 không đáng làm trong run này ⇒ rút ra, ghi lý do ở backlog.
- [x] Gợi ý DEBT-123 trong backlog (`login_required` khi lệch phiên) vẫn lộ `state` ⇒ đổi thành `null` (trang first-party), đặt trước nhánh deny (F1.2).
- [x] DEBT-130 chỉ nêu `decideConsent`; `resume` nhánh `reauthAfter` cùng lỗi ⇒ thêm (F1.3).
- [x] Thiếu test âm, mutation cụ thể và cổng security ⇒ F1–F4 + mục "Cổng security".
- [x] Thiếu ràng buộc giữ thiết kế ký-trước-commit của run 54 ⇒ "Ràng buộc chung" trong fold.

## Đề xuất (không bắt buộc, đã đưa vào backlog)

- **DEBT-413** 💭: context `login` (`request_id` trong URL `returnTo`) không gắn với trình duyệt tạo nó ⇒ cùng lớp transplant như DEBT-123 nhưng cho luồng chưa đăng nhập. Cần ràng buộc bằng cookie trình duyệt; ngoài phạm vi run 55.
- DEBT-409: giữ mở, ghi chú lại số liệu thực tế (2–4 × timeout).
