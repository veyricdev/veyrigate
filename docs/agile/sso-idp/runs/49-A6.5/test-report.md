# Test Report — 2026-10-23 (run 49 A6.5 Keys + DEBT-346/347/348 + Task 0 BE)

## Kết quả: PASS [FE][BE] — fe-admin 1206/1206, BE unit 416/416, BE int 1221/1221, E2E 33/33

Diff chưa commit so với `c8216f3`. Tester thêm 3 nhóm test, không sửa code sản phẩm:
- `fe-admin/test/keys-ui-risk.test.tsx` (mới): 30 test.
- `fe-admin/test/signing-keys-fn-risk.test.ts` (mới): 20 test.
- `be/test/admin-keys.int-spec.ts`: thêm describe "run 49 QA", 6 test.

## Lệnh đã chạy + output thực tế
Mọi lệnh chạy foreground. Log nằm trong scratchpad của phiên.

1. `be/keys` trước khi chạy: `b3c0c678…2119` (`3d0d39e5-….pem`), `02830f97…4721` (`keys.json`), mtime cả hai `1790655568`. Sau toàn bộ, kể cả E2E: sha256 và mtime giống hệt, vẫn 2 file.
2. `pnpm -C be test:int -- admin-keys` (lock `vg:int-lock` do preflight quản): `Tests: 31 passed, 31 total` (25 cũ + 6 mới).
3. Test mới của FE:
   - `pnpm vitest run test/keys-ui-risk.test.tsx test/signing-keys-fn-risk.test.ts` ⇒ `Tests 50 passed (50)`.
   - Lần viết đầu đỏ 6 + 5 test. Nguyên nhân là kỳ vọng sai của tester, đã sửa test, không có lỗi sản phẩm. Chi tiết ở case 8–11.
4. Các lệnh fe-admin (sau khi sửa 1 lỗi TS/lint trong test của tester):

   | Lệnh | Exit | Kết quả |
   |---|---|---|
   | `typecheck` | 0 | |
   | `lint` | 0 | |
   | `test` | 0 | `Test Files 47 passed (47)`, `Tests 1206 passed (1206)`; bằng 1156 của dev + 50 |
   | `build` | 0 | `✓ built` |
   | `check:bundle` | 0 | `scanned 22 client files … 0 hit(s)` |
   | `gen:api` | 0 | sha256 `schema.d.ts` trước/sau khớp, không có diff mới |

5. Các lệnh ở root:

   | Lệnh | Exit | Kết quả |
   |---|---|---|
   | `pnpm lint` | 0 | Lần đầu exit 1: prettier báo 5 lỗi ở test BE mới. Đã chạy `pnpm -C be exec prettier --write test/admin-keys.int-spec.ts`, chạy lại exit 0 |
   | `pnpm -r run typecheck` | 0 | |
   | `pnpm audit --audit-level high` | 0 | `2 low`, `1 ignored: 1 high` (bỏ qua có sẵn từ trước) |

6. `pnpm test` ở root chạy 3 lần. Mỗi lần đỏ một test **khác nhau** và đều thuộc phần không bị diff chạm tới:

   | Lần | Exit | Kết quả |
   |---|---|---|
   | 1 | 1 | `fe-sso-test` `router-lab.test.tsx` "purpose:lab ⇒ …" (`/callback` ≠ `/lab`). Cùng lần này, test keystroke của tester bị timeout 5s; đã sửa bằng `delay: null` và timeout 15s |
   | 2 | 1 | `fe-admin` `check-bundle.test.ts` "fails when a nested client asset…" timeout (5,58s) |
   | 3 | 0 | fe-sso-test 269/269, fe-admin 1206/1206, be 32 suites / 416 |

   - Chạy riêng: `pnpm -C fe-sso-test test` 269/269, `pnpm -C fe-admin test` 1206/1206.
   - Đây là flake do tải khi các package chạy song song, ghi vào DEBT-355.
7. Hai lần chạy đầy đủ:
   - `pnpm -C be test:int`: `Test Suites: 45 passed, 45 total`, `Tests: 1221 passed, 1221 total` (dev báo 1215, cộng 6 test mới), `Time: 348.294 s`.
   - `pnpm -C e2e e2e`: trước khi chạy đã kiểm cổng :4000/:5173/:3000 trống và `E2E_REUSE` rỗng, không dừng process nào. Kết quả `33 passed (3.7m)`, exit 0, trong đó có `ok 9 › tests\fe-admin-keys.spec.ts:22:1 › fe-admin signing keys: normal rotation, JWKS, fresh sign-in on the new key, emergency dialog cancelled (4.5s)`. Sau khi chạy không còn listener nào trên ba cổng.
8. Role gate: 4 test đỏ ở lần đầu vì tester kỳ vọng sai. Role `SUPER_ADMIN`/`[]` bị cổng của app chặn trước, nên trang không hiện câu "Only a super_admin…". Đã đổi sang assert "không bảng/nút, 0 call", và thêm biến thể `tenant_admin + …` để đi qua cổng app và kiểm đúng cổng của trang.
9. `"EMERGENCY\n"`: `<input type=text>` theo chuẩn HTML tự bỏ ký tự xuống dòng, nên giá trị thành `EMERGENCY` và nút bật. Hành vi này đúng (giống trình duyệt thật). Đã bỏ khỏi danh sách "disabled".
10. "list not loaded yet": dialog không đóng. Đây là characterisation cho DEBT-354 (xem mục Phát hiện), đã đổi thành test hành vi thật.
11. `signing-keys-fn-risk`:
    - Lỗi đọc sai schema ⇒ `throw Error("admin api GET /admin/keys: response schema mismatch")`. Đây là thiết kế có sẵn: thông điệp chỉ chứa route, không phải `{ok:false}`. Test chấp nhận cả hai dạng và kiểm không lộ material.
    - 400 `error_description` được relay, cắt 200 ký tự. Đây là hợp đồng có sẵn của mọi lệnh ghi admin; chuyển thành characterisation.
12. Mutation. Trước khi sửa đều backup sha256, sau đó khôi phục và `sha256sum -c` đều OK (byte-identical).

    | Mutant | Kết quả |
    |---|---|
    | M1 `confirm-action.tsx`: so sánh chuẩn hoá `typed.normalize("NFKC").trim().toUpperCase()` | 6 RED |
    | M1b: Enter trong ô gõ gọi `confirm()` | 1 RED |
    | M2 `routes/keys/index.tsx`: kiểm role lỏng `trim().toLowerCase().startsWith("super_admin")` | 3 RED (sau khi thêm biến thể `tenant_admin + …`; lần đầu sống ⇒ test được tăng cường) |
    | M3 `schemas.ts`: `SigningKeySchema.passthrough()` | 1 RED (cache/DOM) |
    | M4 BE `local-key-provider.ts`: emergency giữ key retiring `next = [...retiring, fresh]` | 4 RED, gồm test mới "normal x2 then emergency" |

13. Grep secret trên mọi log đã lưu (int, fe, root, e2e, mutation), mẫu `eyJ…\.`, `BEGIN … PRIVATE`, `"d":"`, `client_secret=`, `MATERIAL-d`: 0 hit.

## Test FAIL (nếu có)
Không có test sản phẩm nào FAIL. Flake khi chạy root song song nằm ở phần ngoài diff (DEBT-355).

## Coverage acceptance criteria
- [x] **Có cảnh báo rõ trước khi khẩn cấp.**
  - `keys-ui.test.tsx`: "the warning states the real consequences only": 5 ý của Q-49.1, câu về phiên console, link audit.
  - `keys-ui-risk.test.tsx` › "no false statement in either dialog": regex âm cho cả hai dialog, gồm "users signed out", "refresh tokens revoked", "sessions revoked/terminated", "15", "minutes", "can be undone/rolled back".
  - E2E `fe-admin-keys.spec.ts`: mở dialog, thấy cảnh báo, gõ xong rồi Cancel.
- [x] **Kết quả phản ánh trong danh sách key.**
  - `keys-ui.test.tsx`: thường và khẩn cấp đều đọc lại list (`list` gọi 2 lần), notice có newKid.
  - E2E: K2 Active, K1 Retiring, JWKS của BE chứa K1 và K2.
  - BE int "normal x2 then emergency": list chỉ còn `{newKid, active, retireAt:null}`.
- [x] Task 0 [BE] OpenAPI: `admin.spec.ts` (dev, 29 test), schema gen không diff.
- [x] Task 1 DEBT-346/347/348: `audit-ui*.test.tsx` xanh trong 1206.

## Coverage security invariants / risk matrix

| Chiều | Trường hợp | Test |
|---|---|---|
| Exposure — BE view | Provider trả `n/e/d/pem/path` ⇒ chỉ còn key allowlist | `admin.spec.ts` (dev); int `KEY_MATERIAL` trên response và audit, gồm test mới |
| Exposure — BFF | BE trả field lạ ⇒ bị strip | `signing-keys-fn.test.ts` (dev) |
| Exposure — BFF, ca lỗi | 500 có material; 200 sai schema có material; 200 body PEM; list `nextCursor` khác null; `kid` là object chứa material; `kid` 129 ký tự; status lạ ⇒ bị từ chối, không có `MATERIAL/BEGIN` trong kết quả, error message hay console; log không chứa kid/mode | `signing-keys-fn-risk.test.ts` › exposure |
| Exposure — DOM, query cache, notice | (a) server fn hỏng, trả thừa field ⇒ DOM không có; (b) schema thật giữa BE có material và UI ⇒ JSON của query cache + mutation cache không có `MATERIAL/BEGIN/AQAB/"d":/"n":`; (c) rotate result thừa `privateKey` ⇒ notice chỉ có kid | `keys-ui-risk.test.tsx` › key material |
| Exposure — URL, storage | Step-up từ dialog khẩn cấp ⇒ `location.assign` đúng `/auth/login?stepup=1&returnTo=%2Fkeys`, không có emergency/mode/kid; `sessionStorage` không có chữ đã gõ hoặc mode | `keys-ui-risk` › step-up keeps no trace |
| Input — cổng `EMERGENCY` | Cyrillic Е, Greek Μ, full-width, ZWSP, ZWJ, NBSP, tab, `emergency`, ` EMERGENCY`, lặp đôi, İ ⇒ disabled, click và Enter đều không gửi | `keys-ui-risk` › look-alikes (11 case) |
| Input — dán, Enter | user-event dán ` EMERGENCY` ⇒ disabled; dán `EMERGENCY` ⇒ enabled; Enter không gửi | `keys-ui-risk` |
| Input — gõ từng phím | Disabled tới ký tự cuối; double-click ⇒ đúng 1 lần `{mode:'emergency'}` | `keys-ui-risk` |
| Input — dialog thường | Không có bước gõ; gửi đúng `{mode:'normal'}` | `keys-ui-risk` |
| Input — body rotate strict (BFF) | `__proto__` smuggling, `constructor`, Cyrillic, khoảng trắng cuối, NUL, mảng, số, `{emergency:true}`, 10k ký tự ⇒ throw, 0 BE call; body gửi BE đúng `{"mode":"normal"}` | `signing-keys-fn-risk` (thêm vào test dev: wrong case/extra/missing) |
| Input — body rotate strict (BE) | `EMERGENCY`, ` emergency`, `['emergency']`, `{emergency:true}`, `null` ⇒ 400, JWKS không đổi | int "run 49 QA" (thêm vào test cũ: missing/unknown/extra/`?emergency=1`) |
| State — pending | Ô gõ, Cancel, xác nhận đều disabled; Escape không đóng; click thêm không gửi; khi resolve dialog đóng, tổng 1 call | `keys-ui-risk` |
| State — uncertain/throw | Không gửi lại, thông điệp có `kidBefore`, list được đọc lại | `keys-ui.test.tsx` (dev) |
| State — uncertain khi chưa có list | Thông điệp chung, không có mệnh đề kid, 1 call | `keys-ui-risk` (DEBT-354) |
| State — nit `kidBefore` | Characterisation: cache K1, thực tế K2 do admin khác xoay, lần của mình không áp dụng ⇒ thông điệp vẫn nhắc K1 | `keys-ui-risk` (DEBT-353) |
| Identity / Authorization — FE | tenant_admin, `tenant_admin+admin`, `SUPER_ADMIN`, `[]`, `tenant_admin+SUPER_ADMIN`, `tenant_admin+ super_admin`, `tenant_admin+super_admin_x` ⇒ không bảng/nút, 0 call list/rotate | `keys-ui-risk` |
| Identity / Authorization — điều hướng | tenant_admin vào `/keys` trực tiếp, hoặc đi từ `/` sang `/keys` trong app ⇒ 0 call | `keys-ui-risk` |
| Identity / Authorization — BE | tenant_admin 403, step-up cũ 403, token khác tenant/không có token/rác/hết hạn 401 | int (cũ) |
| Transition — thường | Key cũ thành `retiring` có `retireAt`, retiring khác giữ nguyên, có đúng 1 active | int "normal x2 then emergency" + int cũ |
| Transition — khẩn cấp | Gỡ **cả key active lẫn mọi key retiring**: JWKS = {newKid}, chỉ còn PEM của newKid, list 1 key | int "normal x2 then emergency" (mutation M4 RED) + int cũ |
| Audit | `SIGNING_KEY_ROTATED` `success` `targetType:'signing_key'`; `metadata {mode:'normal', oldKid}` cho từng lần thường; `{mode:'emergency', oldKid:k2}`, với oldKid là key **active** trước đó, không phải key retiring; không có material | int "normal x2 then emergency" |
| Dependency | BE timeout, network, 500, 200 sai schema, 200 không phải JSON ⇒ `uncertain`, gửi 1 lần | `signing-keys-fn.test.ts` (dev) |
| Request chain — `cooldownDuration: 0` | `verifyIdToken` chỉ có 2 caller: `bff.ts:185` (callback, `tokens.id_token` từ `/token`) và `bff.ts:302` (refresh, `t.id_token` từ `/token`). Không đường nào verify token do trình duyệt gửi ⇒ người ngoài không chọn được `kid` | Grep/đọc code; E2E context B đăng nhập ngay sau khi xoay key: PASS (mutation của dev ⇒ `JWKSNoMatchingKey`) |
| Dev key dir | `be/keys` không đổi sha256/mtime | Mục 1 |

## Phát hiện (không chặn)
- **Nit `kidBefore` (DEBT-353, 💭)**: đã xác nhận bằng characterisation. Thông điệp có thể dẫn tới kết luận sai khi cache cũ, nhưng **phát hiện được**: sau xoay khẩn cấp danh sách chỉ còn 1 key, và trang có link audit `SIGNING_KEY_ROTATED` ghi `mode`. Vì vậy không nâng lên 🔴.
- **DEBT-354 (💭)**: khi danh sách chưa có data và lần đọc đầu đang chạy, dialog rotate giữ "Working…" tới khi lần đọc đó xong (`onSettled` chờ `invalidateQueries`; react-query không huỷ lần đọc chưa có data). Thời gian chờ bị chặn bởi timeout của BFF. Khuôn này dùng chung cho mọi mutation.
- **DEBT-355 (💭)**: root `pnpm test` flake khi chạy song song, ngoài diff.
- Ghi chú: `<input>` tự bỏ `\n` khi dán `EMERGENCY\n`, nên vẫn khớp. Hành vi này chấp nhận được.
