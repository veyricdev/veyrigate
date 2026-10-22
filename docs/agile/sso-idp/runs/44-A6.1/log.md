# Log — run 44 — A6.1 Clients UI (+ DEBT-281/290/294/296/297/299)

## orchestrator — 2026-10-22
- Tiếp lane ADMIN sau run 43 (`3999ef3`). Tự sinh `tasks.md` từ plan §6 A6.1 + debt đích A6.1 và OpenAPI BE. Cổng → tech-lead.

## tech-lead — 2026-10-22
- **PASS** (fold bắt buộc ở mục "Fold tech-lead" trong `tasks.md`). Chi tiết: `review-techlead.md`.
- Đối chiếu code thật:
  - list clients chỉ có `limit/after` (không sort/filter);
  - lỗi 400 không có field có cấu trúc;
  - mọi ghi cần `RequireRecentAuth(5)`;
  - BE luôn từ chối wildcard.
- Q-44.1: decorator tay + class view, không dùng swagger plugin. Q-44.2: `@tanstack/react-form` 1.33.5; không cài react-table. Q-44.3: Task 4 (secrets/disable/E2E secret) dời sang run 45 (A6.1b); E2E step-up (DEBT-281) thành Task 3E ở run 44.
- Mở DEBT-300…303.
- Tiếp: backend-dev (Task 1) ‖ frontend-dev (Task 2) → frontend-dev (Task 3 → 3E).

## backend-dev — Task 1 (DEBT-290/294) — 2026-10-22
- `be/src/modules/admin/admin.views.ts` (mới): class view chỉ cho OpenAPI, `implements` interface mapper (AdminClient/Credential/Resource), cộng page/list/IssuedSecret. Date ⇒ `string` + `date-time`, nullable có `type`. Gắn `@ApiOkResponse`/`@ApiCreatedResponse`/`@ApiNoContentResponse` cho clients list/get/create/update, secrets list/issue/revoke, resources list. DEBT-294: `UpdateClientDto.frontchannelLogoutUri` thêm `type: String`. Không bật plugin, mapper và hành vi runtime giữ nguyên.
- Test: `admin.spec.ts` dựng document thật (`adminOnly(SwaggerModule.createDocument)`, guard được override), so key mapper với `properties`, kiểm `$ref` của từng operation, kiểu nullable/date, DEBT-294. RED trước khi sửa (4 fail: thiếu schema, `frontchannelLogoutUri` sai kiểu). Int `admin-api` thêm assert trên doc được serve.
- Mutation: bỏ decorator `disabled` trong `admin.views.ts` ⇒ RED (thiếu `"disabled"`), khôi phục bằng cp, sha256 khớp `23d96f6a…`.
- Verify: `typecheck` 0 lỗi; `lint` sạch; `pnpm -C be test` 32 suites / 405 pass; `test:int -- admin` 8 suites / 192 pass; `test:int -- admin-api metrics` 2 suites / 93 pass (sau khi thêm assert int).
- Snapshot cho frontend-dev (Task 3, KHÔNG chạy ở đây vì chạm fe-admin): chạy BE ở NODE_ENV=development/test (`pnpm -C be start:dev` hoặc BE test tạm ở :4000), rồi `pnpm -C fe-admin fetch:api && pnpm -C fe-admin gen:api` (đổi cổng qua `ADMIN_OPENAPI_URL`); sau đó bỏ `Omit` trong `ClientPatch`, chạy `admin-openapi.spec.ts`. Tên schema mới: `AdminClientViewDto`, `ClientPageViewDto`, `AdminCredentialViewDto`, `CredentialListViewDto`, `IssuedSecretViewDto`, `AdminResourceViewDto`, `ResourcePageViewDto`.
- Mở DEBT-304 💭 (các endpoint admin còn lại chưa có schema response). DEBT-290/294 chỉ đóng khi FE xong snapshot + bỏ `Omit` (Task 3).
- Tiếp: frontend-dev Task 3 (snapshot); senior-reviewer cho Task 1.

## frontend-dev — Task 2 — 2026-10-22
- DEBT-296 `bff.ts` `refresh`: forced lặp chờ mọi refresh in-flight còn trả AT bị từ chối, rồi mới tự `doRefresh`. DEBT-297 `client.ts` `read` 2xx: non-JSON **hoặc** sai schema ⇒ `unavailable` + `uncertain` cho mutation (GET sai schema vẫn 500); log chỉ method + route. DEBT-299 `saveIntent` gọi `clearIntent()` trước; `it.fails` ⇒ `it`.
- StrictMode: thêm `useStepUpDraft` (`step-up.ts`: `takeIntent` một lần trong `useEffect`, cờ `useRef`) cho form Task 3; harness test dùng hook, render dưới `<StrictMode>`. Ghi nhận: React 19.3 giữ kết quả initializer lần 1 nên initializer KHÔNG đỏ dưới StrictMode thuần; rủi ro thật là render mount bị huỷ (Suspense) ⇒ thêm test đó.
- Test mới: `bff-a5` race (offset microtask k=0..11), `admin-api` PATCH 2xx non-JSON/off-schema + canary body không vào log, `step-up` Suspense/StrictMode.
- Mutation RED (cp + sha256 khôi phục khớp): code refresh cũ ⇒ RED k=1; non-JSON `false` ⇒ 2 RED; off-schema Error thường ⇒ 2 RED; log body ⇒ 1 RED; bỏ `clearIntent` ⇒ 1 RED; initializer `useState` ⇒ 1 RED; bỏ cờ ref ⇒ 2 RED.
- Verify (vg-test-redis): `typecheck` 0; `lint` 0; `test` 22 files / 424 pass (race + step-up chạy lại 3 lần xanh); `build` OK; `check:bundle` 0 hit. Không đụng `be/`, không cập nhật snapshot.
- Đóng DEBT-296/297/299. Tiếp: frontend-dev Task 3 (sau Task 1), senior-reviewer.

## frontend-dev — Task 3 + 3E (DEBT-281/290/294) — 2026-10-22
- Snapshot: BE tạm (`node dist/main.js`, env `beEnv()` = NODE_ENV=test, DB `sso-idp-e2e`) ⇒ `fetch:api` (21 paths) + `gen:api`, BE tạm đã dừng; `ClientPatch` = type sinh ra (bỏ `Omit`); `test/admin-schema-types.test.ts` so zod allowlist == schema sinh ra ở mức type (mutation thêm field ⇒ `typecheck` đỏ). Cài `@tanstack/react-form` 1.33.5 exact (gián tiếp mới: `form-core` 1.33.5 2026-08-11, `devtools-event-client` 0.4.4 2026-06-19, `pacer-lite` 0.1.1 2025-12-06; `store`/`react-store` 0.11.2 đã có), không react-table.
- Server fn `createClient` (POST, `CreateClientInput.strict()`) + `listResources` (limit 100, `adminCapable` tính từ `OIDC_ISSUER` trong server fn); `Method` thêm `POST`; zod response client dùng enum cho type/method/grants. Route `/clients` (bảng ngữ nghĩa, `?after=` + "First page", ô "Open" theo client ID, URI chỉ là text), `/clients/new`, `/clients/$clientId` (type/method/status là text read-only); sidebar thêm Clients.
- Form (`features/clients/`): TanStack Form `revalidateLogic` + zod mirror luật BE (wildcard/absolute/fragment/host `;,` khoảng trắng/scheme ≠ http(s)/`http:` ngoài `localhost`/trùng/>20/>2048; CORS exact origin), mỗi URI một dòng (dòng trống bỏ qua), lỗi "Line N: …" gắn `aria-invalid` + `aria-describedby`, focus field lỗi đầu; cảnh báo `http://localhost` không chặn; nhãn admin-capable; lỗi BE 400/403/409 là `role="alert"` dạng text; `uncertain` create/update có thông điệp riêng, không gửi lại; nút submit khoá khi đang gửi. PATCH chỉ field đổi so với dữ liệu server mới nhất, không bao giờ `disabled`/field bất biến.
- Step-up: create lưu draft allowlist (cả type/method); update chỉ lưu **field đã đổi** rồi áp lên dữ liệu server mới khi quay lại (tránh ghi đè thay đổi của admin khác) ⇒ không tự gửi, banner "submit again".
- E2E (Task 3E): chọn `ACCESS_TOKEN_TTL=120` cho cả stack E2E (`e2e/config/env.ts`); `fe-admin-clients.spec.ts` (~1.2 phút) tạo ⇒ chờ BFF refresh ⇒ sửa ⇒ `/authorize?prompt=login&max_age=0` ⇒ draft khôi phục, BE chưa đổi, `fea:stepup` hết, không token trong storage ⇒ lưu ⇒ BE có URI mới; dọn bằng PATCH `disabled`.
- Mutation RED (cp + sha256 khôi phục khớp): bỏ check wildcard ⇒ 7 đỏ; bỏ check scheme (`javascript:`) ⇒ 13 đỏ; field bất biến lọt vào PATCH ⇒ 5 đỏ; tự submit khi khôi phục draft ⇒ 2 đỏ.
- Verify: fe-admin `typecheck`/`lint` 0, `test` 25 files / 512 pass, `build` OK, `check:bundle` 0 hit, `gen:api` không diff; root `lint` + `pnpm -r run typecheck` sạch; `pnpm test` (be 405, fe-sso-test 269, fe-admin 512); `pnpm audit --audit-level high` exit 0; `pnpm -C e2e e2e` full **28/28 xanh 2 lần liên tiếp** (3.2 phút mỗi lần). Không sửa `be/`.
- Đóng DEBT-281/290/294; mở DEBT-305 (submit trước hydrate), DEBT-306 (resource chỉ trang đầu, chunk client 648 kB). Tiếp: senior-reviewer.

## senior-reviewer — lượt 1 — 2026-10-22
- **REJECT** — 1 🔴 [FE]: form sửa client diff với `query.data` mới nhất (`toPatch(fields, client)`, draft `changedValues(values, valuesFrom(client))`) thay vì mốc lúc nạp form; refetch-on-focus sau khi form touched ⇒ PATCH gửi lại giá trị cũ của field admin không sửa ⇒ ghi đè thay đổi của admin khác (vd. thêm lại redirect URI vừa bị xoá). Chi tiết + cách sửa: `review-senior.md`.
- BE Task 1 chỉ tài liệu (không đổi runtime); refresh loop DEBT-296 kết thúc được; validator mirror BE đúng; URI/lỗi BE render text; draft allowlist, không tự gửi; a11y đạt; deps mới chấp nhận. Không mở debt mới (REJECT).
- Verify: fe-admin typecheck/lint sạch, test 512 pass; be `admin.spec` 41 pass.
- Tiếp: frontend-dev retry 1 (🔴) → senior-reviewer lượt 2.

## frontend-dev — retry 1 (🔴 lost update) — 2026-10-22
- `ClientForm` nhận `base` (giá trị server lúc mount, không tính draft; khôi phục draft = remount theo `key` ⇒ mốc = dữ liệu server lúc đó), giữ trong ref, chuyển sang bản đã lưu sau `reset`; `onSubmit(fields, values, base)`.
- `$clientId.tsx`: `changed = changedValues(values, base)` dùng chung cho PATCH và draft step-up; `toPatch(fields, changed)` chỉ lấy giá trị đã parse của key đã đổi (gộp 2 đường diff, xoá `LIST_KEYS`). Không còn diff với `query.data` refetch.
- Test: viết lại unit "diff vs base"; 2 test UI mới (refetch-on-focus thật qua `focusManager`): v1 ⇒ sửa scopes ⇒ v2 bớt redirect URI ⇒ PATCH chỉ `{scopes}`; đường step-up: draft chỉ `{scopes}`, khôi phục trên v3 vẫn chỉ gửi `{scopes}`. Mutation (cp + sha256 khớp): mốc = latest ⇒ 2 đỏ; mốc gồm draft ⇒ 2 đỏ.
- Verify: fe-admin `typecheck`/`lint` 0, `test` 25 files / **514 pass**, `build` OK, `check:bundle` 0 hit; `pnpm -C e2e e2e` **28/28 xanh** (3.3 phút, `fe-admin-clients` ok 1.2m). Không sửa `be/`, không cài package.
- Mở DEBT-307 (không cảnh báo khi server đổi trong lúc sửa). Tiếp: senior-reviewer lượt 2.

## senior-reviewer — lượt 2 — 2026-10-22
- **REJECT** — 🔴 lượt 1 chưa đóng hẳn [FE]. `baseRef` chỉ chụp lúc mount/sau lưu, nhưng form-core vẫn theo refetch khi form **chưa touched** (`FormApi.update`: `!isTouched`). Kết quả: refetch trước khi sửa ⇒ form hiện V2 trong khi base vẫn V1 ⇒ sửa ⇒ refetch V3 ⇒ PATCH gửi lại `redirectUris` V2, thêm lại URI B vừa thu hồi. Đã tái hiện bằng test thăm dò tạm (đã xoá). Cùng cơ chế xảy ra sau khi khôi phục draft và sau lưu (khi refetch khác `saved`). Cách sửa (đóng băng `defaultValues` hoặc cho base theo khi chưa touched) và 3 test bắt buộc: xem `review-senior.md` mục Lượt 2.
- Biến thể đạt: lưu rồi sửa tiếp (base dời), `uncertain` (base không dời, chỉ gửi field của mình), draft trùng field (DEBT-302), create form không ảnh hưởng.
- Verify: fe-admin typecheck/lint sạch, test 25 files / 514 pass. Không mở debt mới.
- Tiếp: frontend-dev retry 2 (🔴) → senior-reviewer lượt 3.

## frontend-dev — retry 2 (🔴 lượt 2: form chưa touched theo refetch) — 2026-10-22
- Cách (a): `ClientForm` đóng băng `defaultValues` vào state `defaults` (khởi tạo từ `initial` lúc mount; khôi phục draft = remount theo `key`), chỉ đổi sang `saved` sau lưu thành công (`setDefaults(saved)` cùng batch với `reset(saved)` ⇒ `update` mỗi render là no-op, form không bị kéo về bản cũ). `base` (phần server, không draft) chụp cùng lúc mount và cùng dời sang `saved` ⇒ giá trị đang hiện và mốc diff luôn đi cùng nhau; dữ liệu mới chỉ hiện sau lưu/tải lại (DEBT-307, đã ghi rõ thêm). Comment `client-form.tsx`/`$clientId.tsx` khớp cơ chế.
- 3 test UI mới (refocus thật qua `focusManager`): 5 bước của senior ⇒ PATCH chỉ `{scopes}`; khôi phục draft ⇒ refetch ⇒ sửa ⇒ refetch ⇒ chỉ `{scopes, allowedCorsOrigins}`; lưu ⇒ refetch khác `saved` ⇒ sửa ⇒ refetch ⇒ chỉ `{allowedCorsOrigins}`.
- Mutation (cp + sha256 khôi phục khớp): `defaultValues: initial` (bỏ đóng băng) ⇒ 3 đỏ; không `setDefaults(saved)` sau lưu ⇒ 1 đỏ (biến thể sau lưu).
- Verify: fe-admin `typecheck`/`lint` 0, `test` 25 files / **517 pass**, `build` OK, `check:bundle` 0 hit; `pnpm -C e2e e2e` **28/28 xanh** (3.2 phút, `fe-admin-clients` ok 1.2m). Không sửa `be/`, không cài package, không commit.
- Không mở 🟡 mới. Tiếp: senior-reviewer lượt 3.

## senior-reviewer — lượt 3 — 2026-10-22
- **PASS** — 🔴 lượt 1 và lượt 2 đã đóng (tick trong `review-senior.md`). `defaults` (state) và `baseRef` đóng băng cùng lúc mount, chỉ dời cùng nhau khi lưu thành công (`setDefaults(saved)` + `reset(saved)`) hoặc khi remount để khôi phục draft. Giá trị đang hiện và mốc diff luôn khớp nhau.
- Test thăm dò tạm `zz-probe-r3.test.tsx` (5 biến thể, đã xoá), tất cả xanh:
  - `uncertain`, refetch, sửa;
  - draft, lưu, refetch mới hơn, sửa;
  - lưu, refetch, không sửa ⇒ "No changes";
  - sửa rồi revert;
  - step-up lặp từ form khôi phục.
- Mutation bỏ đóng băng ⇒ 3 probe đỏ; file khôi phục khớp sha256.
- Verify: fe-admin typecheck/lint sạch, test 25 files / 517 pass. Không chạy E2E. Không mở debt mới (DEBT-307 giữ).
- Tiếp: **tester**.

## tester — 2026-10-22
- **PASS**. Chi tiết và output: `test-report.md`.
- fe-admin **586 pass + 1 expected fail / 587** (27 file). Tester thêm 70 test:
  - `test/client-form-risk.test.ts` (56): parity 40 URI khó với `validateRedirectUriFormat` thật của BE (scheme độc, http ngoài localhost, wildcard/fragment, IDN/homograph, CR/LF/TAB, userinfo); CORS edge (`:443`, IDN, chữ hoa, path); parse textarea CRLF.
  - `test/clients-ui-risk.test.tsx` (14): markup trong URI/lỗi BE/client id chỉ là text; draft step-up giả mạo không lọt field bất biến/`disabled`/secret (create + update, `toStrictEqual`); public + admin ⇒ BE 400 ở cấp form; lost-update (bật/tắt resource); a11y chỉ bàn phím.
- Mutation (cp + sha256 khôi phục khớp): M1 alert `dangerouslySetInnerHTML` ⇒ 2 đỏ; M2 draft schema `.passthrough()` ⇒ 1 đỏ; M3 bỏ luật http-localhost ⇒ 8 đỏ; M4 không reset method của draft ⇒ 1 đỏ.
- Verify:
  - fe-admin `typecheck`/`lint`/`test`/`build`/`check:bundle` exit 0; `gen:api` sinh lại giống hệt từng byte;
  - root `lint`, `-r typecheck` exit 0; `pnpm test` exit 0 (be 405, fe-sso-test 269, fe-admin 586+1xf). Lần 1 đỏ do test keyboard của tester timeout khi chạy song song, đã sửa;
  - `be test:int -- admin` 192 pass; `audit --audit-level high` exit 0;
  - E2E full **28/28 ×2** (3.2m, 3.1m, `retries: 0`); log không có `eyJ`/`code=`/`state=`/secret.
- Mở **DEBT-308** 🟡 [FE]: form sửa client không remount khi đổi `clientId` mà detail có cache ⇒ form và mốc diff của client trước. Tiềm ẩn: chưa có link detail→detail. Phải sửa trước run 45.
- Không sửa code sản phẩm, không cài package, không commit. Không còn process nào tester khởi động.
- Tiếp: orchestrator đóng run 44.

## orchestrator — 2026-10-22 (đóng run)
- Mọi cổng PASS (senior sau 2 retry). Commit `a581963`.
