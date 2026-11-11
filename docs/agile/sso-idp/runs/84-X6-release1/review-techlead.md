# Tech Lead Review — 2026-11-11 (run 84, X6 release checklist đợt 1, BE + ops/docs + QA)

## Kết luận: PASS

Fold chi tiết (quyết định D84.1–D84.7, hợp đồng, AC, RED, mutation): `tasks.md` mục "Fold tech-lead (2026-11-11)".

| Task | Nội dung | P | Lane / người làm |
|---|---|---|---|
| T1 | DEBT-550 + 556: ngữ pháp email `local@domain` hẹp (D84.1) ở register, forgot, federation tạo/gắn mới, sink `SmtpMailer` | P0 | [BE] backend-dev |
| T2 | DEBT-157: `/jwks.json` `Cache-Control: no-cache` (D84.2) | P0 | [BE] backend-dev |
| T3 | Runbook: §1 JWKS/RP/fe-admin (157, 349), §9 secret 5xx (129), §10 email cũ + mục deploy | P1 | [ops-docs] backend-dev |
| T4 | `release-checklist.md` khung + bằng chứng + phân loại P0 (D84.6, D84.7) | P0 | [QA] tester |
| T5 | Gate | — | [QA] tester |

Thứ tự: T1 → T2 → T3 (backend-dev, một người, cùng `be/`) → senior-reviewer → T4 → T5 (tester). T4 đi sau để checklist ghi được bằng chứng của T1/T2.

## Kiến trúc đề xuất

Không đổi kiến trúc. Chọn đúng một điểm kiểm duy nhất cho ngữ pháp email (`be/src/common/validation/email-address.ts`), dùng ở 3 biên vào (DTO register/forgot, federation F5) và 1 sink (mailer). Không thêm dependency, không thêm config, không đổi schema.

### Đã kiểm trên code (`f87075b`)

- Email: `@IsEmail()` chỉ ở `ui.controller.ts:45` (`LoginDto`, `RegisterDto extends LoginDto`) và `:51` (`EmailDto` của `/forgot`); class-validator 0.14.2 nhận quoted local part (characterization trong `mailer.spec.ts`). Federation lấy email provider ở `federation.service.ts:356-358` rồi `normalizeEmail` và tra theo email. Không có route đổi email (`UserService.changeEmail` chỉ được test gọi). Thư gửi tại `authentication.service.ts:296` (fire-and-forget, `.catch` log câu cố định). Lỗi DTO đi qua `HtmlExceptionFilter`: 400, `no-store`, câu cố định, không echo ⇒ hợp đồng phản hồi của T1 không cần code mới.
- JWKS: `keys.controller.ts` chỉ `applyCors` (+ `Vary: Origin`) rồi 200, không `Cache-Control`. Lỗi qua `OAuthExceptionFilter` có `no-store`. fe-admin `server/auth/instance.ts:36` `createRemoteJWKSet(..., { timeoutDuration: 5000, cooldownDuration: 0 })` (cacheMaxAge mặc định 10 phút).
- Rotate thường: `LocalKeyProvider.rotateExclusive` và `VaultTransitKeyProvider.rotate`/`signWith` ký ngay bằng key mới (`set.latest`) ⇒ DEBT-393 đúng như mô tả.
- Secret: `issueSecret` ghi audit trước khi trả plaintext (fail-closed); `rotateSecret` chỉ hạ `expiresAt` của version cũ (`$or: [{expiresAt: null}, {expiresAt: {$gt: graceDeadline}}]`) ⇒ rotate lại không gia hạn grace, runbook phải nói rõ. fe-admin đã có `UNCERTAIN_ISSUE`.

## Quyết định (ghi lại đầy đủ, người dùng ủy quyền)

1. **D84.1 ngữ pháp email**: tập ký tự local `[A-Za-z0-9._+'-]`, domain LDH ASCII (A-label `xn--`), độ dài 64/253/254, không IP literal. Hẹp hơn RFC 5322 có chủ đích: an toàn của `email_verified` không được phụ thuộc vào parser địa chỉ của nodemailer (5 GHSA ở run 83, và 10.1.7 vẫn viết lại quoted local part — DEBT-556). Loại thêm `%`/`!` vì định tuyến relay cũ làm thư đi nơi khác chuỗi đã lưu, cùng lớp lỗi. Không áp cho login để không khoá tài khoản cũ; runbook §10 liệt kê tài khoản cũ bị ảnh hưởng. Đánh đổi: EAI/IDN dạng Unicode bị từ chối (DEBT-560).
2. **D84.2 JWKS `no-cache`**: loại `max-age` (run 80). `no-cache` cho emergency rotate có hiệu lực ngay ở tầng HTTP và rotate thường không bị cache trung gian chặn kid mới. Tải lên origin chấp nhận được (JWKS nhỏ, provider có cache). Cache trong process của RP nằm ngoài kiểm soát của IdP ⇒ chuyển thành yêu cầu trong runbook (≤ 10 phút + refetch khi kid lạ).
3. **D84.3 fe-admin giữ `cacheMaxAge` mặc định, đóng DEBT-349**: không có đường khai thác (chỉ verify ID token từ back-channel `/token` đã xác thực client), nên không đổi code.
4. **D84.4 DEBT-393 pre-publish: làm ở run 85**. Đây là phần còn lại của "quyết định cuối về cache JWKS": `no-cache` xử lý cache trung gian, pre-publish xử lý RP có giới hạn tần suất refetch khi gặp kid lạ. Hợp đồng sơ bộ trong fold (`pending`, `activatesAt`, `KEY_PREPUBLISH_SEC` = 3600, 0–86400). Đổi hợp đồng admin + fe-admin nên cần một run riêng có lane FE, không nhồi vào lô này.
5. **D84.5 DEBT-129: chỉ runbook**, giữ quyết định run 79 (không rollback grace).
6. **D84.6 tester viết checklist**: bằng chứng phải kiểm được bằng lệnh (`grep -F` như security-matrix), và người duyệt không tự viết thứ mình ký. Tech-lead cố định danh mục để phạm vi không trôi.
7. **D84.7 chuẩn**: RFC 9700, OIDC Core 1.0 (+ Discovery, RP-Initiated Logout), RFC 8707/9207/7009/7662/6749 §3.3, ASVS 5.0.0 L2 (bản hiện hành, có V10 OAuth/OIDC). Định nghĩa P0 ghi trong fold.
8. **Kế hoạch X6**: 4 đợt (run 84–87), bảng trong fold. AC X6 ("checklist ký duyệt; không còn P0 mở") chỉ đạt ở đợt 4.
9. **Không đưa vào lô 1**: DEBT-553/557 (pin action theo SHA, cần đọc ref từ GitHub) ⇒ đợt 2; diễn tập + DEBT-252/253 ⇒ đợt 3 (cần checklist trước để biết tiêu chí đạt); 🟡 hoãn có lý do (120, 121, 134, 192, 193, 517) ⇒ tester phân loại ở phần E, tech-lead chốt ở run 85.

## Cổng security design

**T1 (email)**
- Tài sản: quyền sở hữu hộp thư ⇒ claim `email_verified` IdP phát cho RP; link đặt lại mật khẩu (chiếm tài khoản). Actor: người đăng ký/quên mật khẩu ẩn danh; provider federation (đáng tin một phần); kẻ tấn công nhắm hộp thư khác. Trust boundary: form HTML BE → DTO; provider → federation; IdP → SMTP.
- Invariant: thư xác minh/đặt lại chỉ đi tới đúng một mailbox mà chuỗi đã lưu chỉ tới, không cần parser phải "hiểu đúng". Trước T1: chuỗi quoted/comment vào DB và vào `to`. Sau T1: chuỗi ngoài D84.1 không vào DB qua register/federation và không tới transport.
- Abuse case: quoted local part / comment / `<>` / `,` / `;` (GHSA run 83, DEBT-556), `%`/`!` relay, CR/LF/NUL, IP literal, U-label đánh lừa thị giác; enumeration (phản hồi chỉ phụ thuộc input, không phụ thuộc tài khoản); federation đổi email sang chuỗi lạ cho identity mới (bị chặn), identity cũ (không ảnh hưởng, tra theo providerId).
- Failure semantics: sink từ chối ⇒ throw, nơi gọi đã `.catch` + log cố định, request vẫn trả trang chung (không lộ). Không gọi ngoài mới.
- Exposure: không echo email trong 400/log/lỗi mailer; câu message decorator cố định. Ca âm đo được: 0 thư, 0 user, 0 token, body không chứa chuỗi.

**T2 (JWKS)**
- Tài sản: tập khoá công khai mà RP dùng để tin token. Actor: RP, CDN/proxy, kẻ giữ key đã lộ. Invariant: sau emergency rotate, mọi refetch thấy JWKS không còn key cũ; lỗi (503) không bị cache. Abuse case: cache trung gian giữ key đã lộ; cache lưu bản lỗi. Failure: provider lỗi ⇒ 503 `no-store` (characterization). Exposure: không đổi body. Ca âm: header so khớp chính xác, mutation `max-age=300` phải đỏ.

**T3/T4**: chỉ tài liệu; T3 có AC chạy lệnh thật trên DB test (không DB dev). T4 có AC kiểm bằng chứng bằng lệnh.

## Điểm mạnh

- Ứng viên đã gom đúng debt gắn X6 và nêu rõ quyết định cũ (run 79, run 80), nên lô 1 chỉ cần chốt chứ không phải điều tra lại.
- Hạ tầng sẵn có làm T1/T2 rẻ: recorder `MAILER` trong int, harness SMTP giả của run 83, `GatedKeyProvider`, `HtmlExceptionFilter`/`OAuthExceptionFilter` đã fail-closed và không echo.
- `security-matrix.md` (77 dòng, 76 `có`) là nguồn bằng chứng sẵn cho phần lớn checklist ⇒ T4 chủ yếu ánh xạ, không viết test mới.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Điểm ứng viên để mở đã chốt trong fold:

- [x] Ngữ pháp email chính xác, điểm áp và điểm KHÔNG áp (login, filter admin), giữ `@IsEmail()`.
- [x] Quyết định cuối cache JWKS (HTTP `no-cache` + pre-publish ở run 85), fe-admin giữ nguyên.
- [x] Người viết checklist, chuẩn và phiên bản đối chiếu, định nghĩa P0.
- [x] Chia X6 thành 4 đợt, mỗi đợt ≤ 6 task.
- [x] Sửa STATUS "Còn mở: Q7–Q9" (plan §12 đã chốt Q7–Q9 ngày 2026-11-06) ⇒ orchestrator khi đóng run.

## Đề xuất (không bắt buộc)

- DEBT-560 (💭): EAI/IDN — nhận U-label (chuyển sang A-label trước khi lưu) và/hoặc SMTPUTF8 nếu có người dùng thật cần.
- DEBT-561 (💭): trang 400 của register/forgot chỉ nói "The request could not be completed." ⇒ hiện lại form với câu cố định về định dạng email (không echo), cùng cách cho lỗi DTO khác của UI.
- Đợt 2: khi làm pre-publish, cân nhắc nâng `Cache-Control` lên `max-age` nhỏ hơn `KEY_PREPUBLISH_SEC` chỉ khi có số liệu tải thật; mặc định giữ `no-cache`.
