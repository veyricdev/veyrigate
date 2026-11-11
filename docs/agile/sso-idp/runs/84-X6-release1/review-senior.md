# Senior Review — 2026-11-11 (run 84, X6 đợt 1: T1 email D84.1, T2 JWKS `no-cache`, T3 runbook)

## Kết luận: PASS

Không có 🔴. Hai mục 🟡, ba mục 💭 và một dòng ponytail đã vào `backlog.md` (DEBT-563 đến DEBT-567). DEBT-563 và DEBT-564 rẻ (khoảng 15 dòng test và một đoạn runbook). Nếu orchestrator muốn đóng sạch thì có thể làm luôn trong run này trước T5, nhưng không bắt buộc.

Phạm vi review: `git diff` + file untracked theo danh sách của backend-dev trong `log.md`: `be/src/common/validation/email-address.ts` (+spec), `ui.controller.ts`, `federation.service.ts`, `smtp.mailer.ts`, `mailer.spec.ts`, `keys.controller.ts`, `be/test/run84-email.int-spec.ts`, `be/test/run84-jwks-cache.int-spec.ts`, block run 84 trong `federation.int-spec.ts`, `runbook-ops.md` §1/§9/§10, `runbook-deploy.md` 5'' và §13. Không đọc và không đánh giá `.vscode/mcp.json` hay `.mcp.json` (ngoài phạm vi, không được đụng).

Tôi đã chạy lại:
- `pnpm -C be test`: 44 suite, **896/896** ✅.
- `pnpm -C be test:int run84`: 2 suite, **26/26** ✅.
- `pnpm -C be test:int federation.int -t "run 84"`: **7/7** ✅ (117 skipped).
- `vg-int-*` sau các lượt trên: **0**.
- Đối chiếu độc lập regex §10 (PCRE, chạy `$regexMatch` qua `$documents` trên `vg-test-mongo`, không ghi DB) với `isDeliverableEmail` (`be/dist`) trên 19 ca biên: LF cuối, LF trong local, nhãn cuối kết thúc `-`, nhãn cuối 1 chữ, nhãn cuối bắt đầu bằng số, chữ hoa, A-label, `..`, `.` đầu, hai `@`, local 64/65, nhãn 63/64, dấu chấm cuối domain, U-label, domain 254. Kết quả: **19/19 khớp**.

Không chạy E2E/X3.

## Tổng quan (ấn tượng chung + điểm tốt)

Đây là một lô gọn và đúng hợp đồng D84.1/D84.2. Điểm tốt:

- **Một điểm kiểm duy nhất** `isDeliverableEmail`: hàm thuần, không ném, nhận `unknown`. Hàm được dùng ở đủ 3 biên vào và 1 sink.
  - Thứ tự ở F5 đúng: kiểm ngữ pháp **trước** `findByEmail`, nên chuỗi ngoài ngữ pháp không dò được tài khoản. `states.createLink(... normalizeEmail(identity.email!))` chỉ chạy sau F5.
- **Luật giao hai phía**: `@IsEmail() @IsDeliverableEmail()` không bao giờ nới.
  - `LoginDto` giữ nguyên.
  - `RegisterDto` tách khỏi `LoginDto` thay vì kế thừa, nên sau này sửa login không vô tình nới register.
  - Grep xác nhận `@IsEmail()` đứng một mình chỉ còn ở `ui.controller.ts:46` (`LoginDto`), đúng AC.
- **Test đo hệ quả, không đo cài đặt**:
  - Ở biên HTTP, test đếm user/verify/reset/outbox/khoá `rl:*` trước và sau, và kiểm body không chứa chuỗi.
  - `/forgot` được so **byte-for-byte** giữa hai trường hợp có và không có tài khoản legacy.
  - Federation có ca "identity đã liên kết vẫn đăng nhập" và ca "tài khoản local legacy trùng chuỗi hostile không sinh pending link".
- **Mutation ghi đủ** (M1–M7 + M5b, J1/J2) và có ghi lại sự cố `cp` backup một cách trung thực.
- **Runbook §10 truy vấn chỉ đọc, an toàn**:
  - In `DB:` trước, chỉ in `_id`, neo `\z`, không cờ `m`.
  - Có giải thích vì sao không dùng `$` (PCRE `$` khớp trước `\n` cuối chuỗi).
  - Đã chạy thật trên DB tạm của `vg-test-mongo` rồi drop. Không chạm `sso-idp`.

### Ngữ pháp D84.1: đánh giá chi tiết

| Mục | Code | Đánh giá |
|---|---|---|
| Dot-atom local | `LOCAL = /^[A-Za-z0-9_+'-]+(?:\.[A-Za-z0-9_+'-]+)*$/` | Đúng. Không có `.` đầu/cuối, không có `..`, và đây là tập con thật của atext RFC 5322 §3.2.3. `$` của JS (không cờ `m`) **không** khớp trước `\n` cuối, ca `LF at end` chứng minh điều này. |
| Một `@` | `indexOf === lastIndexOf`, `at >= 1` | Đúng. `@x.io`, `a@@x.io`, `a@b@x.io` bị loại. `a＠x.io` (fullwidth) bị loại vì không có `@` ASCII. |
| Độ dài | tổng ≤ 254, local ≤ 64, domain ≤ 253, nhãn ≤ 63 | Đúng RFC 5321 §4.5.3.1: path 256 trừ `<>`. Fixture 254/255/64/65/63/64 có test tự kiểm độ dài. |
| Domain LDH | `LABEL`, ≥ 2 nhãn, nhãn cuối bắt đầu bằng chữ | Đúng. `split('.')` cho nhãn rỗng khi có dấu chấm cuối, `..` hoặc `.` đầu, nên các trường hợp này bị loại tự nhiên. `a@1.2.3.4` và `a@x.123` bị loại. `xn--p1ai` (TLD A-label) được nhận. |
| IDN | chỉ ASCII | U-label và EAI bị loại, đúng D84.1 (DEBT-560). A-label `xn--bcher-kva.de` được nhận. |
| Chữ hoa, `+`, `'` | nhận | Đúng. `normalizeEmail` hạ chữ thường **sau** khi kiểm. Chuỗi ASCII sau `toLowerCase` vẫn là ASCII, nên không có đường nào biến chuỗi hợp lệ thành không hợp lệ hay ngược lại. |
| Không trim | kiểm chuỗi thô | Đúng D84.1. Ca ` victim@good.test` cho 400 dù `normalizeEmail` có `trim()`. |

### Cái gì còn có thể vỡ (đã kiểm)

- **Seed / E2E / X3 / fe-sso-test**: mọi email literal đều dạng `xxx@example.com`:
  - `admin@example.com`, `dev@example.com`, `e2e-user@example.com`;
  - `e2e-fed-${rand()}@example.com` (rand = base36);
  - `x3-fed-${hex}@example.com`.

  Tất cả đều đạt D84.1. `ADMIN_SEED_EMAIL` đã qua `z.string().email()` (zod, cũng loại quoted).
- **Mailpit**: `SMTP_URL=smtp://localhost:1025` chỉ là host transport, không phải địa chỉ. Guard chỉ kiểm `to`, không kiểm `from` (`no-reply@localhost` trong test timeout vẫn chạy). Int FULL lần 2 xanh, bao gồm `mailer.int`.
- **Federation Google/GitHub**:
  - Gmail và Workspace chỉ cho chữ, số, `.`, `_`, `-`, `'`.
  - GitHub noreply có dạng `<id>+<login>@users.noreply.github.com`.
  - Cả hai đều đạt. Các ca bị chặn thật trên thực tế: domain U-label và local có `&`, `#`, `=` (DEBT-560). Với identity **đã liên kết** thì không ảnh hưởng, vì tra theo `providerId` trước F5. Có test chứng minh.
- **Login và tài khoản cũ**: `LoginDto` không đổi. Test characterization `/login` với quoted local trả 401 chung (không phải 400 ngữ pháp). Tài khoản legacy ngoài ngữ pháp mất khả năng tự `/forgot`; runbook §10 có ghi.
- **Một token có thể bị ghi mà không gửi thư**: `issueToken` ghi one-time token rồi mới `mailer.send`. Nếu sink từ chối thì còn 1 token mồ côi. Điều này chỉ xảy ra được khi email đã lưu ngoài ngữ pháp **và** request đi qua DTO. Với `/forgot`, input phải qua D84.1 và `normalizeEmail(input)` phải bằng email đã lưu; chuỗi ASCII đã lowercase vẫn khớp D84.1, nên email đã lưu cũng khớp. Với `/register`, input cũng phải qua DTO. Kết luận: hiện không có đường nào tới được. Token mồ côi cũng vô hại (không ai có plaintext, có TTL).

### `/forgot` và enumeration

Không có khác biệt. DTO chạy trước controller, nên phản hồi 400 chỉ phụ thuộc input. Int test so `unknown.body === res.body` và cùng status giữa có và không có tài khoản legacy, đồng thời kiểm 0 reset token và 0 thư. Đường hợp lệ (201) không đổi so với trước.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Identity / ownership hộp thư** (`email_verified`, link reset):
  - Chuỗi ngoài D84.1 không vào DB qua register hay federation tạo mới. Kiểm bằng int: 0 user, 0 FI, 0 pending link, 0 token.
  - Chuỗi đó không tới transport: unit dùng SMTP giả, 0 RCPT.
  - Guard sink còn chặn cả dữ liệu legacy đi vòng qua biên vào.
- **Authorization / confused deputy (federation)**:
  - Tài khoản local legacy có chuỗi hostile trùng với email do provider gửi thì không sinh `fed_link:*` và không có FI. Ca này đã được test.
  - Không auto-link theo email (INV-22 giữ nguyên).
- **Thứ tự kiểm (F5)**: grammar trước `findByEmail`, nên không có oracle "email có tồn tại" qua provider.
- **Failure behavior**:
  - Sink ném `Error('mailer: recipient rejected')` cố định. Nơi gọi `.catch` và log câu cố định, request vẫn trả trang chung. Fail closed, không chuyển thành "đã gửi".
  - JWKS khi provider lỗi trả 503 `no-store`, body không lộ `SECRET-DETAIL`.
- **Exposure**:
  - Message decorator cố định (unit kiểm không chứa giá trị).
  - Trang 400 không echo (int kiểm cả `evil.test`, `good.test` và nguyên chuỗi).
  - Lỗi mailer không chứa địa chỉ.
  - Runbook §10 chỉ in `_id`.
- **Boundary input**: CR/LF/TAB/NUL/DEL, khoảng trắng đầu/cuối, quoted, comment, `<>`, group, `%`/`!` relay, IP literal, U-label, fullwidth `@`, kiểu không phải string (number/null/array/object có `toString`) đều có ca test.
- **Rate-limit**: request bị DTO từ chối không tạo khoá `rl:*`. Điều này đúng và không mở bypass, vì request bị từ chối không làm gì cả.
- **JWKS (T2)**:
  - 200 GET/HEAD × 3 kiểu Origin cho `cache-control` **đúng bằng** `no-cache` và `Vary: Origin`.
  - Sau emergency rotate, GET kế tiếp chỉ có `newKid`.
  - Mutation `public, max-age=300` cho đỏ.
  - Comment trong `keys.controller.ts` đã sửa cho đúng nghĩa.

## 🟡 Nên sửa

🟡 **Mất regression của addressparser nodemailer ở tầng transport** (DEBT-563)
`be/src/modules/mailer/mailer.spec.ts:135-159`: 4 ca GHSA và 2 ca DEBT-556 của run 83 (RCPT thực tế qua SMTP giả) bị **thay** bằng ca "guard từ chối".

Vì sao:
- Ca mới đi qua `SmtpMailer.send`, nên guard chặn trước nodemailer. Chúng chỉ chứng minh guard tồn tại, không còn chứng minh gì về addressparser.
- Run 83 dùng chính các ca này làm bằng chứng nâng cấp (đỏ trên 10.0.12, xanh trên 10.1.7). Hiện nếu ai hạ hoặc đổi nodemailer thì không còn test nào đỏ.
- DEBT-560 đã lên kế hoạch **nới** D84.1 ("nới từng ký tự atext có ca int RCPT TO"). Khi đó guard thôi che, mà harness RCPT cho chuỗi hostile lại không còn.
- `rcptsFor` hiện chỉ được ca baseline dùng.

Đề xuất: giữ cả hai lớp.
- (a) Ca guard hiện tại (đúng, giữ).
- (b) Khôi phục 4 ca GHSA + 2 ca quoted ở **tầng transport**, gọi thẳng `createTransport(url).sendMail({ from, to, ... })` qua cùng SMTP giả (hoặc `rcptsFor` nhận tham số "bỏ qua guard" ở mức test). Kỳ vọng giữ như run 83: không có RCPT ở `evil.test` hoặc `EENVELOPE`; quoted chỉ có 1 RCPT ở `good.test`.

Khoảng +15 dòng, không đổi code sản phẩm.

🟡 **Runbook-ops §1 bước 5 (ii): sau emergency, RP cache ≤ 10' được hiểu là không cần làm gì** (DEBT-564)
`docs/agile/sso-idp/runbook-ops.md` §1 bước 5 (ii) viết: "Sau emergency: báo RP; RP nào cache lâu hơn hoặc không refetch theo kid phải restart/xoá cache".

Vì sao:
- Khi key **bị lộ**, kẻ giữ key ký AT với `kid` cũ. RP dùng jose mặc định có `oldKid` trong cache, nên **không** gặp kid lạ và tiếp tục chấp nhận AT giả tới 10 phút.
- "Refetch khi kid lạ" không giúp gì ở kịch bản này. Nó chỉ giúp AT hợp lệ mới được nhận.
- Bản cũ ("Báo các RP xoá cache JWKS") mạnh hơn. Bản mới vô tình nới hành động khắc phục trong quy trình sự cố.

Đề xuất sửa câu: "Sau emergency: báo **mọi** RP/RS tự verify JWT xoá cache JWKS **ngay** (restart hoặc reload JWKS). Nếu không làm thì cửa sổ tối đa vẫn chấp nhận token ký bằng key đã lộ = thời gian cache của RP (jose mặc định 10')." Đồng thời tách ý "refetch khi kid lạ" sang (iv) (rotate thường). Ngoại lệ fe-admin ở (iii) vẫn đúng, vì nó không verify AT.

## 💭 Nit

💭 **Fixture "backslash" thực ra là backspace** (DEBT-565)
`be/src/common/validation/email-address.spec.ts:67` `['backslash', 'a\b@x.io']`: trong literal JS, `\b` là U+0008, nên ký tự `\` chưa hề được test. Ca vẫn đúng là bị loại, nhưng sai lý do.
Đề xuất: `'a\\b@x.io'`. Có thể thêm `'"a\\"b"@x.io'` (quoted-pair) nếu muốn.

💭 **Federation từ chối theo ngữ pháp dùng chung mã `email_unverified`** (DEBT-566)
`federation.service.ts:359`: người dùng Google hoặc GitHub có email **đã verify** nhưng ngoài D84.1 (vd. domain U-label) thấy "verified email address is required". Người hỗ trợ không phân biệt được hai nguyên nhân, vì log và audit giống nhau.
Đề xuất: giữ trang và mã như hiện tại (không tạo oracle mới), nhưng thêm một log cố định `federation: provider email outside grammar` (không kèm giá trị) hoặc metadata audit `reason: 'grammar'`. Xử lý cùng lúc với DEBT-561 hoặc DEBT-560.

💭 **Runbook-ops §10, câu "/forgot trả 400 … như với địa chỉ không có tài khoản"** (DEBT-567)
Câu này chỉ đúng với **cùng chuỗi ngoài ngữ pháp** không có tài khoản. Một địa chỉ hợp lệ không có tài khoản trả 201 "Check your email".
Đề xuất: "(trùng byte với cùng chuỗi đó khi không có tài khoản ⇒ không lộ tài khoản tồn tại)".

## ✂️ Ponytail

- be/src/modules/mailer/mailer.spec.ts:L147: shrink: ca hostile mới tự dựng `new SmtpMailer` + `then/catch` + reset `rcpts`, trùng việc của `rcptsFor` (giờ chỉ baseline dùng). Có thể cho `rcptsFor` trả kèm lỗi rồi dùng chung, gộp với DEBT-563.

net: -6 lines possible.

Phần còn lại đã gọn:
- `isDeliverableEmail` là 2 regex + 1 hàm, không dùng thư viện.
- Decorator là `ValidateBy` gốc.
- `RegisterDto` lặp 2 trường của `LoginDto`, nhưng đó là lặp có chủ đích để tách luật.
- Các test tự kiểm độ dài fixture là self-check tối thiểu, giữ.
