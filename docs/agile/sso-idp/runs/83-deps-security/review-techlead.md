# Tech Lead Review — 2026-11-10 (run 83, dependency có advisory, BE + FE)

## Kết luận: PASS

Fold chi tiết (phiên bản đích, AC, verify): `tasks.md` mục "Fold tech-lead (2026-11-10)".

| Task | Gói | Cách xử lý | Lane |
|---|---|---|---|
| T1 | nodemailer 10.0.12 → 10.1.7 | nâng trực tiếp (minor, cùng major 10) | [BE] backend-dev |
| T2 | fastify 5.12.5 → 5.12.7, fast-uri 3.1.9/4.2.3 | nâng cha `@nestjs/*` 12.1.1 → 12.2.0; fast-uri resolve lại trong dải cha | [BE] backend-dev |
| T3 | glob/minimatch nhánh runtime + cli | nâng cha `@fastify/static` 10.1.10, `@nestjs/cli` 12.0.12 (+ schematics 12.0.13) | [BE] backend-dev |
| T4 | `@eslint/plugin-kit`, minimatch/glob dev, deepmerge | nâng cha eslint 9.39.5; override có dải cho minimatch/glob (cha chưa có bản vá); ignore deepmerge (không có bản vá) | [BE] backend-dev |
| T5 | `github/codeql-action` (giả thuyết 2 alert high) | pin `@v3.39.3` | [ops] backend-dev |
| T6 | seroval/seroval-plugins 1.6.8 → 1.6.12; eslint FE | sửa override sẵn có; nâng eslint fe-admin + fe-sso-test | [FE] frontend-dev |
| T7 | gate chung | `pnpm audit` 0, test đầy đủ, diff lockfile | người làm cuối |

## Kiến trúc đề xuất

Không đổi kiến trúc, không đổi code sản phẩm (trừ test mới ở T1). Đây là run vệ sinh dependency; nguyên tắc chọn từng gói:

1. Ưu tiên **nâng cha** tới bản cha cũ nhất đã mang bản vá (ít thay đổi nhất), pin chính xác.
2. **Override** chỉ khi bản cha mới nhất vẫn chưa dùng bản vá; dùng khoá có dải (`'pkg@>=a <b'`) để chỉ ép đúng các bản nằm trong dải advisory, và override tự hết tác dụng khi cha đã lên.
3. Gói **không có bản vá** và chỉ ở đường dev ⇒ `auditConfig.ignoreGhsas` có lý do + ngày xem lại (đúng quy ước run 38).
4. Quy tắc 14 ngày: bản sửa bảo mật được ngoại lệ (`plan.md` §12 Q62.1), nhưng khi có bản ≥ 14 ngày mang bản vá thì chọn bản đó.

## Quyết định từng gói (dữ liệu registry 2026-11-10)

### nodemailer (runtime, 5 moderate) ⇒ nâng trực tiếp 10.1.7

- Không phải major bump: bản vá nằm ở 10.0.13 (2 GHSA) và 10.1.4 (3 GHSA addressparser). 10.1.7 (2026-10-18, 23 ngày) là bản cuối dòng 10.1, sau chuỗi 10.1.3–10.1.7 cùng ngày (chỉ addressparser/mime-funcs). 10.2–10.5 là feature, 10.4.1/10.5.0 mới phát hành hôm nay ⇒ không lấy.
- Changelog 10.0.13–10.1.7 (CHANGELOG.md upstream): không breaking, không bỏ option, Node ≥ 20 không đổi. Hai thay đổi hành vi liên quan đến `be`: (a) 10.1.0 tính thời gian chờ greeting vào `connectionTimeout` ⇒ với `connectionTimeout: 5000, greetingTimeout: 5000` ngân sách connect + greeting còn 5 s (chặt hơn, fail nhanh hơn, không cần sửa; ca timeout `mailer.spec.ts` 4.5–9 s vẫn đúng); (b) 10.1.0 không đọc env lúc import ⇒ `be` chỉ dùng `url`, không ảnh hưởng.
- `be` chỉ dùng `createTransport({ url, timeouts })` + `sendMail({ from, to, subject, text, html })` (`be/src/modules/mailer/smtp.mailer.ts`), gửi fire-and-forget có `.catch` (`authentication.service.ts:296`) ⇒ API không đổi.
- **Vì sao đây là ưu tiên cao nhất dù chỉ "moderate"**: `to` là email người dùng tự nhập lúc đăng ký/quên mật khẩu (`@IsEmail()` của class-validator; validator.js cho phép quoted local part). Lỗi addressparser (GHSA-85x2: `>` trong quoted local part ⇒ gửi tới domain mà header không nêu) có thể làm thư xác minh của một địa chỉ đi tới hộp thư của kẻ tấn công ⇒ kẻ tấn công "xác minh" một email không phải của mình ⇒ IdP phát `email_verified: true` sai cho RP. Vì vậy T1 bắt buộc ca âm đo RCPT TO thật trên server SMTP giả (chạy cả trên bản cũ để chứng minh test bắt được), và characterization `@IsEmail()` làm đầu vào cho DEBT-550 (siết ngữ pháp email ở biên, phòng thủ chiều sâu, ngoài phạm vi run này).
- Kiểm chứng gửi thật: E2E 38 không có ca gửi mail; `be/test/mailer.int-spec.ts` (SMTP thật tới mailpit + đọc lại API) là kiểm chứng duy nhất ⇒ đưa vào verify T1.
- `@types/nodemailer` 8.0.2 thừa (nodemailer 10 tự mang `types`) ⇒ DEBT-551, không làm trong run này.

### fastify (runtime, low) ⇒ nâng cha `@nestjs/*` 12.2.0

- `fastify` không là dep trực tiếp; `@nestjs/platform-fastify` pin chính xác (12.1.1 ⇒ 5.12.5). Bản platform-fastify cũ nhất có fastify ≥ 5.12.6 là **12.2.0** (2026-10-19, fastify 5.12.7, 22 ngày); 12.3.x ra 3 bản trong 1 ngày (dấu hiệu regression), 12.3.3+ < 14 ngày ⇒ chọn 12.2.0. `@nestjs/common/core/testing` nâng cùng số (dự án luôn giữ bộ lõi Nest đồng bộ). Không thêm override `fastify` (vi phạm nguyên tắc 2).
- Mức phơi nhiễm GHSA-389g (bỏ qua kiểm `propertyNames` header phân biệt hoa thường): thấp, `be` không khai báo schema header kiểu đó; vẫn nâng vì là runtime.

### fast-uri (runtime, 4 GHSA × 2 nhánh) ⇒ resolve lại trong dải cha

- Cha dùng `^3.0.1` (ajv 8) và `^4.0.0` (`@fastify/ajv-compiler`, `fast-json-stringify`) ⇒ 3.1.9/4.2.3 (2026-10-19, 22 ngày) đã nằm trong dải. Chỉ cần lockfile resolve lại; override là thừa. Phơi nhiễm thấp (Nest dùng class-validator, ajv của fastify chỉ cho schema nội bộ), vẫn sửa vì là runtime.

### glob + minimatch (runtime qua `@fastify/static`, dev qua cli/jest/typescript-eslint)

- Runtime: `@fastify/static` 10.1.9+ chuyển sang `glob ^14` (⇒ 14.0.4 ⇒ `minimatch ^11.0.5`). Không có bản ≥ 14 ngày nào của `@fastify/static` mang glob 14 ⇒ ngoại lệ bảo mật cho 10.1.10. Peer của platform-fastify 12.2.0 (`^10.1.2`) và swagger (`^10`) khớp.
- `@nestjs/cli` (dev) pin chính xác `minimatch`; 12.0.12 là bản đầu tiên pin 11.0.5 ⇒ nâng cha (đòi `@nestjs/schematics ^12.0.13` ⇒ nâng cùng để không có 2 bản).
- `typescript-eslint` (8.72.2 mới nhất vẫn `minimatch ^10.2.2`) và `jest` (30.5.2 mới nhất vẫn `glob ^13.0.6`): **chưa có bản cha nào có bản vá** ⇒ override có dải `'minimatch@>=7.0.0 <11.0.1': 11.0.5`, `'glob@>=9.0.0 <14.0.2': 14.0.4`. Chọn đúng bản mà nhánh runtime đã dùng ⇒ một bản duy nhất trong cây. Không nâng `jest`/`typescript-eslint` be trong run này (không cần cho bản vá, tăng churn trên 2800 test).
- Rủi ro override: ép major (minimatch 9/10 → 11, glob 10 → 14) vào tooling dev. API `minimatch()`/`glob()`/`globSync()` giữ dạng named export từ v9; gate lint (typescript-estree) và jest (phát hiện test bằng glob) chạy toàn bộ ⇒ hỏng sẽ lộ ngay. Có fallback rõ ràng (gỡ override, không ignore để không che nhánh runtime).
- Phơi nhiễm thật của nhánh dev: pattern glob là của chính repo, không phải đầu vào người ngoài ⇒ DoS minimatch / AbortSignal của glob không khai thác được; override chủ yếu để `pnpm audit` sạch và cảnh báo mới không bị chìm.
- Chuỗi cung ứng: minimatch 11 thêm `@isaacs/nonrecursive-glob-match` (mới từ 2026-10-27, cùng maintainer isaacs, 0 dep, không install script) vào **đường runtime**. Chấp nhận: đến từ chính maintainer, là phần của bản vá DoS.

### `@eslint/plugin-kit` (dev, low) ⇒ nâng cha eslint 9.39.5

- eslint 9.18.0 dùng `^0.2.5`; bản vá là ≥ 0.3.4 (dòng 0.2 không có bản vá). eslint 9.39.5 (2026-07-10) dùng `^0.4.1`, cùng major 9 (minor của eslint không đổi `recommended`). Nâng `@eslint/js` cùng số. Áp cho be, fe-admin, fe-sso-test (3 workspace pin 9.18.0).

### deepmerge (dev, low, không có bản vá) ⇒ chấp nhận rủi ro, `ignoreGhsas`

- 4.3.1 là bản cuối (2023), advisory không có `patched_versions`. Chỉ qua `jest-config` (gộp config jest của chính repo); prototype poisoning cần đầu vào do kẻ tấn công kiểm soát ⇒ không có đường khai thác. Không có cha thay thế (jest 30.5.2 vẫn `deepmerge ^4.3.1`).
- Ignore theo GHSA là toàn cục ⇒ AC T4 bắt kiểm `pnpm why -r deepmerge` chỉ có đường `jest-config` trước khi ignore; ngày xem lại 2027-02-10 (DEBT-552). CI dùng `--audit-level high` nên low này vốn không chặn; ignore để `pnpm audit` mặc định về 0 và mọi advisory mới hiện ra rõ.

### seroval (runtime FE, 2 moderate) ⇒ sửa override sẵn có 1.6.8 → 1.6.12

- `pnpm-workspace.yaml` đang override `seroval`/`seroval-plugins: 1.6.8` (run 41, lý do tuổi bản) ⇒ chính override giữ bản lỗi; nâng `@tanstack/*` không giúp gì (`router-core` mới nhất vẫn `^1.6.7`). 1.6.12 (2026-10-21, 20 ngày) là bản cuối dòng 1.6, vá cả GHSA-f86p (< 1.6.11) và GHSA-9wx9 (< 1.6.10), không nhảy minor (1.7/1.8 mới, nhiều bản liên tiếp). Giữ override (bỏ sẽ kéo 1.8.0 một ngày tuổi).
- Phơi nhiễm: seroval serialize dữ liệu loader/server fn vào HTML SSR. Hai lỗi cần typed array có `constructor` riêng hoặc RegExp trong dữ liệu; dữ liệu admin là JSON từ BE (không RegExp/typed array) ⇒ khó khai thác, nhưng là đường runtime nhạy cảm (script injection trong trang admin) ⇒ sửa. Verify nhắm đúng: router, server-entry, csp-nonce-ssr, ssr-unavailable, error-boundary, các `*-fn` test, build + check:bundle, E2E 38.

### 2 cảnh báo high của Dependabot (không có trong `pnpm audit`)

- `pnpm audit` hiện **0 high**. Theo `.github/dependabot.yml` (DEBT-500), lockfile pnpm 12 (2 document YAML) làm dependency graph npm không thấy gói ⇒ alert npm chỉ có thể đến từ dependency trực tiếp đọc trong `package.json` (nodemailer 10.0.12 là dep trực tiếp duy nhất có advisory, toàn moderate). Docker không có alert. Còn lại là hệ sinh thái **github-actions**.
- Workflow dùng tag trôi: `actions/checkout@v4`, `setup-node@v4`, `cache@v4`, `upload-artifact@v4`, `github/codeql-action/init@v3`, `github/codeql-action/analyze@v3`. Trong GitHub Advisory Database, advisory high khớp là **GHSA-vqf5-2xx6-9wfm / CVE-2025-24362** (`github/codeql-action` 3.26.11–3.28.2, sửa 3.28.3: debug artifact lộ env/`GITHUB_TOKEN`, chỉ khi quét Kotlin + bật debug artifact + run lỗi). `init` và `analyze` là 2 dependency riêng ⇒ khớp đúng "2 high". Repo chỉ quét JS/TS và tag `v3` hiện trỏ v3.39.x ⇒ rủi ro thật bằng 0; đây gần như chắc là alert do không xác định được bản từ tag trôi.
- Hành động: T5 pin `@v3.39.3` (tag cụ thể mới nhất của v3). 4 moderate có thể là 4 trong 5 GHSA nodemailer (từ `be/package.json`) ⇒ đóng bởi T1. **Đây là suy luận, chưa xác minh** (máy không có `gh`): người dùng cần mở tab Security → Dependabot sau push để xác nhận đúng gói/GHSA và xem alert đã đóng chưa.

## Điểm mạnh

- Tasks analyst liệt kê đủ gói và đường phụ thuộc; ràng buộc rõ (không thêm dep, chỉ registry npm, lockfile commit cùng, gate đầy đủ).
- Hạ tầng sẵn có làm việc này rẻ: pin chính xác + `auditConfig` có quy ước lý do/ngày, CI `pnpm audit --audit-level high` fail-closed, test timeout SMTP và int SMTP thật đã có.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các điểm analyst để mở đã được tech-lead chốt trong fold:

- [x] Phiên bản đích từng gói và cách xử lý (nâng/nâng cha/override/ignore).
- [x] nodemailer không phải major; đã đọc changelog, ghi 2 thay đổi hành vi timeout.
- [x] Thứ tự lane (một lockfile ⇒ BE trước, FE sau), danh sách ngoại lệ 14 ngày, kiểm diff lockfile.
- [x] Ca âm đo được cho lỗ addressparser (thay vì "test gửi mail xanh"), fallback cho override.

Cổng security design: run chạm trust boundary gián tiếp (thư xác minh/đặt lại mật khẩu, SSR admin). Tài sản: quyền sở hữu email (`email_verified`), trang admin. Actor: người đăng ký ẩn danh nhập email tuỳ ý. Abuse case chính: email hostile làm thư đi lệch domain ⇒ AC2 T1 (âm, đo RCPT TO, chạy trên cả bản cũ). Failure semantics không đổi (gửi mail fire-and-forget có catch, timeout giữ). Exposure: không đổi response/log. Đủ cho phạm vi run dependency.

## Đề xuất (không bắt buộc)

- DEBT-550 (🟡): siết ngữ pháp email ở biên (dot-atom, không quote/comment/`<>`/`;`/`,`) cho register/forgot/đổi email/admin tạo user/federation — không phụ thuộc vào việc addressparser đúng.
- DEBT-551 (💭): gỡ `@types/nodemailer` (nodemailer 10 tự mang types).
- DEBT-552 (💭): gỡ override minimatch/glob khi `typescript-eslint`/`jest` dùng bản vá; xem lại ignore deepmerge 2027-02-10.
- DEBT-553 (💭): pin mọi GitHub Action theo commit SHA (kèm comment tag), Dependabot github-actions vẫn cập nhật được.
- Cân nhắc sau: nâng `typescript-eslint` be 8.20.0 → cùng bản fe (8.71.2) để đồng bộ repo (không cần cho bản vá).
