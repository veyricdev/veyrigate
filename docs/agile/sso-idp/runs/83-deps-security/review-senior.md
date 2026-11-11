# Senior Review — 2026-11-10 (run 83, deps-security)

## Kết luận: PASS

Không có 🔴. E2E 38 chưa chạy **không** chặn verdict review code (xem mục "E2E 38"), nhưng **chặn đóng run**: tester/orchestrator phải chạy `pnpm -C e2e e2e` (38/38) khi `:5173` trống trước khi đóng run 83.

## Tổng quan

Run vệ sinh dependency gọn và có kỷ luật: mọi phiên bản trong 3 `package.json` là pin chính xác, lõi Nest đồng bộ 12.2.0, không thêm dep trực tiếp, không sửa code sản phẩm. Điểm tốt nhất là ca âm RCPT TO: thay vì "gửi mail xanh", spec đo envelope thật trên server SMTP giả và đã được chạy trên bản cũ (10.0.12: 4/4 đỏ) — đúng kiểu test chứng minh được bản vá. Override có dải tự hết tác dụng khi cha lên; comment ở `pnpm-workspace.yaml` có GHSA, lý do, điều kiện gỡ.

Kiểm lại độc lập (2026-11-10):
- `pnpm audit` ⇒ exit 0, "1 ignored: 1 low" (deepmerge).
- `pnpm why -r deepmerge` ⇒ chỉ `jest-config@30.0.5` (dev, `@sso-idp/be` devDependencies).
- `pnpm -C be test -- mailer` ⇒ 16/16 (timeout 5019 ms; các ca SMTP giả 7–27 ms).
- Envelope thật của 6 chuỗi hostile trên 10.1.7 (`jsonTransport`, scratch): không chuỗi nào reject, không RCPT nào ở `evil.test`.
- `git ls-remote`: `v3^{}` = `v3.39.3^{}` = commit `9418214df1f2c4b8128c770156c409013b07d6b9`.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Envelope thư xác minh/đặt lại (email ownership ⇒ `email_verified`)**: RCPT TO quyết định nơi nhận. Test đo RCPT domain ≠ `evil.test` cho 4 GHSA; g73g ghim envelope chính xác `<victim@good.test>`; 2 quoted local part mà `@IsEmail()` nhận ⇒ đúng 1 RCPT `@good.test`. Bằng chứng phân biệt bản lỗi/bản vá: backend-dev báo 10.0.12 đỏ 4/4 với RCPT `<attacker@evil.test>` cụ thể (khớp mô tả advisory), 10.1.7 xanh; tôi xác nhận hành vi 10.1.7 độc lập. Còn hở: (a) nhánh `rejected` nuốt mọi lỗi (DEBT-555, 🟡), (b) nodemailer vẫn viết lại quoted local part (mất `>`), thư tới mailbox khác chuỗi đã lưu trên **cùng** domain (DEBT-556 ⇒ DEBT-550). Không lệch domain ⇒ không phải 🔴.
- **Server SMTP giả có deterministic không**: cổng `listen(0, '127.0.0.1')` (ephemeral, không đụng mailpit 1025); không quảng bá PIPELINING/STARTTLS/AUTH nên nodemailer đi tuần tự; `rcpts` reset mỗi lần gửi, `await send` xong mới đọc; mỗi ca < 30 ms so với timeout jest 5 s và timeout nodemailer 5/5/10 s; `afterAll` destroy socket trước `server.close`. Không thấy nguồn flake.
- **Failure behavior**: gửi vẫn fire-and-forget có `.catch` (không đổi); 10.1.0 gộp greeting vào `connectionTimeout` ⇒ ngân sách 5 s, chặt hơn, ca timeout 4.5–9 s xanh.
- **SSR admin (seroval)**: 1.6.12 là bản cuối dòng 1.6, vá GHSA-f86p/9wx9; vitest đích 395/395, build + check:bundle 0 hit. Bằng chứng SSR qua trình duyệt thật (E2E 38) còn thiếu ⇒ điều kiện đóng run.
- **Runtime static (glob 14 / minimatch 11 / `@fastify/send` 4.2.1)**: int static-assets/openapi 175/175, int FULL 1968, docker smoke in đúng version.
- **Exposure**: không đổi response/log/audit.

## Đánh giá từng câu hỏi

**Pin chính xác**: có. Diff `package.json` không có `^`/`~`; importer lockfile `specifier` = `version` cho mọi dòng đổi; importer `.` và `e2e` không đổi.

**Override có dải (minimatch/glob) — có ép major lên consumer không chịu được không?** Consumer thực sự bị ép (lockfile HEAD): minimatch 9.0.9 (`@typescript-eslint/typescript-estree` 8.20.0, be) và 10.2.6 (8.71.2, fe) ⇒ 11.0.5; glob 10.5.0 (`@jest/reporters`, `jest-config` 30.0.5) ⇒ 14.0.4. Đã kiểm API thật:
- typescript-estree chỉ gọi `(0, minimatch_1.minimatch)(filePath, pattern)` trong `allowDefaultProject` (`useProgramFromProjectService.js:195`); minimatch 11 CJS export `minimatch` là function ⇒ ổn; lint 3 workspace xanh.
- jest chỉ gọi `_glob().glob.sync(…, { windowsPathsNoEscape: true })` (coverage threshold glob, `projects` glob); glob 14 CJS vẫn có `glob.sync` ⇒ ổn; unit 819 + int 1968 xanh.
- engines: minimatch 11 `20 || >=22`, glob 14 / path-scurry 3 `18 || 20 || >=22` ⇒ khớp Node 22.
- minimatch 3.1.5/5.1.9 và glob 7.2.3 không bị đụng; `pnpm audit` 0 xác nhận dải advisory không chứa chúng.

Phạm vi: khoá theo dải là toàn cục — một consumer tương lai cần `minimatch ^9`/`glob ^10` cũng sẽ bị ép lên major mới mà không có cảnh báo. Khoá theo cha (`'@typescript-eslint/typescript-estree>minimatch'`, `'@jest/reporters>glob'`, `'jest-config>glob'`, …) hẹp hơn nhưng không tự hết hạn và phải liệt kê 4+ đường. Với override chỉ sống tới khi cha nâng (DEBT-552) và gate lint/jest phủ hết consumer hiện tại, khoá theo dải là đánh đổi hợp lý. Chấp nhận.

**deepmerge ignore có giới hạn ở jest không**: đường phụ thuộc thì có (chỉ `jest-config`), nhưng `ignoreGhsas` bản chất là theo GHSA toàn repo — nếu sau này deepmerge vào đường runtime, `pnpm audit` sẽ im. Comment + ngày xem lại 2027-02-10 (DEBT-552) đã ghi rủi ro này; low, không có bản vá ⇒ chấp nhận. Mỗi lần nâng dep runtime nên chạy lại `pnpm why -r deepmerge` (đã nằm trong điều kiện DEBT-552).

**Ngoại lệ 14 ngày, gồm DEBT-554**: các gói trong fold có lý do bảo mật cụ thể. DEBT-554: `path-scurry` 3.0.0 không có lựa chọn (bản 3.x duy nhất glob 14 đòi). `@fastify/send` 4.2.1 (8 ngày, runtime phục vụ file tĩnh) và `set-cookie-parser` 3.2.2 (11 ngày, qua `light-my-request`) có bản cũ hơn thoả dải (4.2.0 / 3.2.1) — override tạm đúng quy tắc hơn, nhưng thêm 2 override để gỡ lại sau vài ngày là churn, cả hai cùng tổ chức fastify, không install script, int/docker xanh. Chấp nhận quyết định. Ghi chú quy trình: fold nói "dừng, báo lại tech-lead", nhưng orchestrator tự đóng DEBT-554 — lần sau nên để tech-lead ký (một dòng trong review-techlead) để giữ phân quyền.

**Peer warnings**: không cái nào là rủi ro thật cho run này.
- `ts-jest` 29.2.5 ↔ jest 30: có từ trước, unit/int xanh; dọn bằng nâng ts-jest (DEBT-558).
- `@nestjs/schematics` 12.0.13 ↔ typescript >=6: 12.0.6 cũ cũng khai `typescript >=6.0.0` (`pnpm view`) ⇒ không phải mới; schematics chỉ dùng cho `nest generate`, không cho `nest build`/runtime; build + docker xanh.
- `vite` 8.3.4 ↔ `@types/node` 22.10.5: chỉ kiểu, có từ trước, typecheck 4 workspace xanh.

**CodeQL pin**: đúng. `v3.39.3` là tag v3 mới nhất và trỏ cùng commit với `v3` hiện tại ⇒ không đổi hành vi, chỉ giúp Dependabot xác định bản. Lưu ý cho DEBT-553: `096a89e` trong log là tag object, commit là `9418214…` (DEBT-557).

**Giả thuyết alert Dependabot**: hợp lý. Theo `.github/dependabot.yml` alert npm không có (lockfile 2 document), nên high chỉ có thể đến từ github-actions; trong các action đang dùng (`checkout`, `setup-node`, `cache`, `upload-artifact` @v4, `codeql-action/{init,analyze}`) chỉ codeql-action có advisory high đã biết (GHSA-vqf5-2xx6-9wfm), và init/analyze là 2 dependency ⇒ khớp "2 high". Điểm yếu: phần "4 moderate = nodemailer" không khớp số (nodemailer 10.0.12 dính 5 GHSA) — vẫn là suy luận; người dùng xác nhận ở tab Security sau push như tasks đã ghi.

**E2E 38**: không chặn verdict review vì (1) không sửa code sản phẩm, (2) các bề mặt E2E phủ đã có bằng chứng gần: X3 42/42 (stack đầy đủ qua TLS proxy, trình duyệt thật), int FULL 1968, vitest SSR/seroval 395, build + check:bundle, docker smoke. Nhưng seroval là serialize SSR thật của fe-admin và E2E 38 là gate bắt buộc của run (tasks T7) ⇒ run **không được đóng** khi chưa có E2E 38/38. Nếu E2E đỏ ở bất kỳ ca nào liên quan SSR/cookie/static ⇒ quay lại frontend-dev/backend-dev, review lại phần liên quan.

## 🟡 Nên sửa

- [ ] `be/src/modules/mailer/mailer.spec.ts:121` (`rejected = true` trong `catch`) + `:150` (`if (r.rejected) return;`) — nuốt mọi lỗi thành "reject hợp lệ". Vì sao: ca âm phải đỏ khi giả định sai; hiện một lỗi kết nối/timeout/lỗi server giả với chuỗi lạ sẽ làm ca GHSA xanh vô điều kiện. Với 10.1.7 không chuỗi nào reject (đã đo) nên nhánh này chỉ là đường che lỗi. Đề xuất: bỏ nhánh, khẳng định `rejected === false` và envelope chính xác cho cả 4 ca; hoặc chỉ chấp nhận reject khi `err.code === 'EENVELOPE'`, lỗi khác ném lại. ⇒ DEBT-555.

## 💭 Nit

- nodemailer 10.1.7 viết lại quoted local part (`"x>attacker@evil.test"@good.test` ⇒ RCPT `<"x attacker@evil.test"@good.test>`): thư đi tới mailbox khác chuỗi đã lưu trên cùng domain. Thêm vào bằng chứng của DEBT-550 ⇒ DEBT-556.
- DEBT-553 cần commit đã peel (`9418214…`), không phải tag object `096a89e`; cân nhắc lên `codeql-action@v4` cùng lúc ⇒ DEBT-557.
- `ts-jest` 29.2.5 peer jest ^29 (có từ trước) ⇒ DEBT-558.

## ✂️ Ponytail

Diff là bump phiên bản + 2 override + 1 ignore + 1 spec; không có abstraction hay code thừa. Server SMTP giả ~35 dòng là tối thiểu cho việc đo RCPT TO (nodemailer `jsonTransport` cho envelope rẻ hơn nhưng không đi qua đường SMTP thật mà `SmtpMailer` dùng ⇒ giữ). Khối characterization `@IsEmail()` là AC3, giữ. `@types/nodemailer` thừa đã có DEBT-551.

Lean already. Ship.
