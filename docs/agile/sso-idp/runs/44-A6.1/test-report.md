# Test Report — 2026-10-22 (run 44, A6.1 Clients UI + debt)

## Kết quả: PASS

- fe-admin: **586 pass + 1 expected fail / 587** trong 27 file.
  - Trước tester: 517 test, 25 file. Tester thêm **70 test** trong 2 file mới: `test/client-form-risk.test.ts` (56) và `test/clients-ui-risk.test.tsx` (14).
  - Expected fail là `it.fails` ghi lại **DEBT-308** (🟡 tiềm ẩn, chưa có đường UI nào tới được, xem "Test FAIL").
- BE: unit 405/405; int `admin` 8 suites / 192 pass.
- E2E: **28/28 xanh 2 lần liên tiếp** (3.2m và 3.1m; `retries: 0`, `workers: 1` nên không có trường hợp flaky bị che). `ACCESS_TOKEN_TTL=120` không làm spec nào khác đỏ.
- Root: `pnpm lint`, `pnpm -r run typecheck`, `pnpm test` xanh; `pnpm audit --audit-level high` exit 0.
- Không có 🔴. Thêm 1 🟡: DEBT-308.

## Lệnh đã chạy + output thực tế

Mọi lệnh chạy foreground bằng Git Bash. Docker `vg-test-*`, `aegate-*` và mailpit đã chạy sẵn. Cổng :3000, :4000 và :5173 trống trước và sau E2E, không phải dừng process nào.

| # | Lệnh | Output |
|---|---|---|
| 1 | `npx vitest run test/client-form-risk.test.ts` | `Tests 56 passed (56)` |
| 2 | `npx vitest run test/clients-ui-risk.test.tsx` | Lần đầu `1 failed / 13 passed`. Case "switching to another client whose detail is cached" fail: `expected 'https://other.example/cb' to be 'https://app.example/cb'`, đây là DEBT-308. Đổi sang `it.fails` ⇒ `13 passed \| 1 expected fail (14)` |
| 3 | Mutation (backup cp + sha256 ở scratchpad; khôi phục bằng cp; `sha256sum -c` OK cả 3 file: `client-form-schema.ts` `bccbee0b…`, `client-form.tsx` `f0adae23…`, `new.tsx` `d65f6cf7…`) | **M1** alert dùng `dangerouslySetInnerHTML` ⇒ 2 đỏ (BE 400 markup create/update). **M2** `EditDraftSchema`/`NewClientDraftSchema` `.passthrough()` ⇒ 1 đỏ (draft update có field bất biến). **M3** bỏ luật `http:` chỉ cho `localhost` ⇒ 8 đỏ (parity + CORS + dòng lỗi + keyboard). **M4** không reset method của draft ⇒ 1 đỏ (draft public + `client_secret_basic`) |
| 4 | `pnpm -C fe-admin typecheck` / `lint` / `test` / `build` / `check:bundle` | exit 0 cả 5. `Test Files 27 passed (27)`, `Tests 586 passed \| 1 expected fail (587)`. Build chỉ có cảnh báo chunk >500 kB (DEBT-306). `check:bundle scanned 8 client files for 8 server env names + 0 canaries: 0 hit(s)` |
| 5 | `pnpm -C fe-admin gen:api` | exit 0. Sinh lại vào file tạm bằng `openapi-typescript openapi/admin.json` ⇒ `cmp` **IDENTICAL** với `src/server/admin-api/schema.d.ts` (sha `c7dc2575…`). Diff so với HEAD là thay đổi có chủ đích của Task 1 |
| 6 | `pnpm lint` (root) | exit 0 |
| 7 | `pnpm -r run typecheck` | exit 0 |
| 8 | `pnpm test` (root), lần 1 | **exit 1 [lỗi của tester]**: test keyboard mới timeout 5000 ms khi chạy song song (`user.keyboard` gõ từng ký tự). Sửa: `userEvent.setup({ delay: null })`, URL dùng `user.paste`, timeout 20 s. Sau đó case chạy 486 ms; chạy riêng file 3 lần đều xanh |
| 9 | `pnpm test` (root), lần 2 | exit 0: be `Tests: 405 passed`, fe-sso-test `269 passed`, fe-admin `586 passed \| 1 expected fail` |
| 10 | `pnpm -C be test:int -- admin` | exit 0, `Test Suites: 8 passed`, `Tests: 192 passed` |
| 11 | `pnpm audit --audit-level high` | exit 0, `2 vulnerabilities found` (1 low, 1 moderate), `1 ignored: 1 high` (DEBT-226 có từ trước, `pnpm-workspace.yaml` `auditConfig.ignoreGhsas`) |
| 12 | `pnpm -C e2e e2e` (FULL, lần 1) | exit 0, **`28 passed (3.2m)`**; `fe-admin-clients.spec.ts` ok (1.2m) |
| 13 | `pnpm -C e2e e2e` (FULL, lần 2) | exit 0, **`28 passed (3.1m)`**; `fe-admin-clients.spec.ts` ok (1.2m). Không có `failed`/`flaky` |
| 14 | Grep log E2E cả 2 lần: `eyJ`, `code=`, `state=`, `client_secret`, `clientSecret`, `password=`, `DEV_SEED_PASSWORD` | 0 hit cho mọi mẫu. `e2e/test-results` rỗng, không có `playwright-report`. Các dòng `server function failed … Unrecognized key "tenantId"`/`Invalid client id` trong log là input giả mạo có chủ đích của `fe-admin-risk.spec.ts` (run 43), log chỉ chứa key/path |

## Test FAIL

Không có test đỏ ngoài `it.fails` đã ghi nhận.

- 🟡 **DEBT-308 [FE]** (tiềm ẩn, không chặn) — `clients-ui-risk.test.tsx` › "switching to another client whose detail is cached…".
  - **Kỳ vọng**: điều hướng `/clients/app-1` → `/clients/app-2` → Back thì form hiện giá trị của app-1.
  - **Thực tế**: heading là `app-1`, nhưng form (và mốc diff `base`) vẫn là của app-2.
  - **Nguyên nhân**: `$clientId` giữ `EditClient` mounted khi detail của id mới đã có trong cache (`isPending` false). `ClientForm` đóng băng `defaults`/`baseRef`, `key` vẫn là `"blank"`. Nếu lưu ở trạng thái này, PATCH app-1 sẽ mang danh sách (vd. `redirectUris`) của app-2.
  - **Tại sao không chặn**: hiện không có link từ detail sang detail. Chỉ tới được detail từ list hoặc từ `new` (đều remount), nên Back/Forward luôn đi qua list. Chỉ điều hướng bằng code mới tái hiện được. Run 45 (secrets/disable) hoặc bất kỳ link detail→detail nào sẽ biến lỗi này thành 🔴.
  - **Cách sửa gợi ý**: `key={client.clientId + …}` cho `ClientForm`, hoặc `remountDeps` theo `clientId` ở route. Khi sửa xong thì đổi `it.fails` thành `it`.

## Coverage acceptance criteria

- [x] **Task 1 (DEBT-290/294)**: schema response và `frontchannelLogoutUri` `type: String`.
  - Test: `be/src/modules/admin/admin.spec.ts` (trong `be` unit 405) và int `admin-api` (192).
  - E2E `admin-openapi.spec.ts` xanh 2 lần; `gen:api` sinh lại không đổi; `admin-schema-types.test.ts` qua `typecheck`.
- [x] **Task 2**: `bff-a5.test.ts` (DEBT-296 race), `admin-api.test.ts` (DEBT-297 2xx non-JSON/off-schema ⇒ `uncertain`, body không vào log), `step-up*.test.ts(x)` (DEBT-299, StrictMode/Suspense). Tất cả xanh trong 586.
- [x] **Task 3, bảng**: `clients-ui.test.tsx` (trang sau/về đầu/rỗng/lỗi/mở theo id) và `clients-ui-risk` (URI có markup trong list chỉ là text).
- [x] **Task 3, form**:
  - case URL dạng bảng: `uri-cases.ts` cộng parity với validator BE thật (`client-form-risk`);
  - cặp type/method, kể cả draft có cặp sai được reset;
  - field bất biến không vào body ở cả create lẫn edit (kể cả draft bị sửa tay);
  - chỉ gửi field đã đổi;
  - 400/403/409/`uncertain`;
  - step-up save/restore không tự gửi;
  - StrictMode.
- [x] **Task 3, a11y**: label, `aria-invalid`, `aria-describedby`, focus vào field lỗi đầu (`clients-ui`), và đi hết form bằng bàn phím: Tab đúng thứ tự, Space bật/tắt, Enter submit, submit sai thì focus field lỗi đầu và lỗi được nối qua `aria-describedby` (`clients-ui-risk` › a11y).
- [x] **Task 3E (DEBT-281)**: `e2e/tests/fe-admin-clients.spec.ts` xanh 2 lần liên tiếp trong full suite, có kiểm âm `fea:stepup` đã xoá và Web Storage không có token.
- [x] **Fold, mutation RED**: dev đã làm (wildcard, `javascript:`, field bất biến, tự submit). Tester làm thêm M1–M4 ở trên.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Input: scheme độc | `javascript:`, `JaVaScRiPt:`, `java\tscript:`, `javascript://…%0a…`, `data:`, `vbscript:`, `file:`, `blob:`, `ftp:` ⇒ lỗi theo field, không gửi | `client-form-risk` parity, `uri-cases`, `clients-ui` |
| Input: http ngoài localhost | `http://evil.example`, `127.0.0.1`, `[::1]`, `localhost.evil.example`, `localhost.` ⇒ lỗi; `http://LOCALHOST` ⇒ chấp nhận như BE | parity, M3 |
| Input: wildcard / fragment | `*` trong host/path ⇒ lỗi; `%2A` ⇒ chấp nhận (cả BE); `#x` ⇒ lỗi; `#` rỗng ⇒ chấp nhận (cả BE, `url.hash` rỗng) | parity |
| Input: whitespace / CRLF | trim từng dòng, `\r\n` và dòng trống bị bỏ, không ký tự trắng nào vào request; host chứa `%20` ⇒ lỗi; `;` `,` trong host (cả dạng `%3B`) ⇒ lỗi | `client-form-risk` › textarea parsing, parity |
| Input: IDN / homograph | `bücher`, punycode, `а` Cyrillic ⇒ chấp nhận như BE; CORS dạng IDN ⇒ lỗi "exact origin" (origin bị punycode) | parity, CORS cases |
| Input: CORS có path | `/`, `/cb`, `#x`, userinfo, `:443` mặc định, chữ hoa ⇒ lỗi "exact origin" | `client-form-risk` CORS |
| Parity FE == BE | 40 giá trị khó so với `validateRedirectUriFormat` thật: không chặt hơn, không lỏng hơn | `client-form-risk` |
| Exposure: render | URI có `<script>`/`<img onerror>`/`javascript:` ở list và detail, BE 400 có markup (create/update), client id có markup trên URL ⇒ chỉ là text; không có `script`/`img`, không có `a[href^=javascript:]`, `window.__pwned` không được set | `clients-ui-risk` › exposure, M1 |
| Input: draft giả mạo | draft create/update có `clientId`/`tenantId`/`disabled`/`clientSecret`/`clientType`/`tokenEndpointAuthMethod` ⇒ bị loại, body `toStrictEqual` allowlist; draft khác path/sub/action ⇒ bị bỏ qua và bị tiêu thụ | `clients-ui-risk` › input, M2, M4 |
| Authorization (chỉ hiển thị) | public + resource admin ⇒ vẫn gửi đúng như chọn, BE 400 hiện ở cấp form, không field nào `aria-invalid`; tenant_admin cấp admin ⇒ 403 hiện thông điệp cố định | `clients-ui-risk` › authorization |
| State: lost update | bật rồi tắt resource ⇒ "No changes", không gửi; chuyển client khi detail có cache ⇒ **DEBT-308** (`it.fails`). Các biến thể refetch/draft/lưu/`uncertain` đã có test của dev và probe senior lượt 3 | `clients-ui-risk` › state, `clients-ui` |
| Request chain | step-up ⇒ IdP `prompt=login&max_age=0` ⇒ quay lại đúng trang ⇒ draft khôi phục, chưa gửi ⇒ lưu | E2E `fe-admin-clients` ×2 |
| Exposure: log/HTML/storage | log E2E không có `eyJ`/`code=`/`state=`/secret; Web Storage không có token; `check:bundle` 0 hit | #4, #12–14 |
| Dependency | TTL 120 s: toàn bộ 28 spec xanh 2 lần (login/logout/federation/lab/admin-client không phụ thuộc AT sống 15 phút) | #12–13 |

## Ghi chú (không mở debt)

- 💭 BE và FE (parity) đều chấp nhận URI có ký tự điều khiển `\t`/`\r`/`\n` **ở giữa** (WHATWG URL bỏ chúng khi parse, còn chuỗi gốc thì được lưu nguyên). Qua UI thì không tạo được vì textarea tách dòng và trim. Gọi admin API trực tiếp thì lưu được, nhưng chỉ dùng để so khớp chính xác và chỉ admin ghi được. Nên chặn `[\x00-\x1f\x7f]` ở BE khi có dịp (gộp vào B hardening).
- 💭 `fe-admin-clients.spec.ts:72` dùng `waitForTimeout(~65 s)` để chờ BFF refresh (điều kiện theo đồng hồ của AT, không có sự kiện nào quan sát được). Chấp nhận được; spec chạy 1.2m ổn định qua 2 lần.
