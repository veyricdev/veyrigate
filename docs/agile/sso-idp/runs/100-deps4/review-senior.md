# Senior Review — 2026-11-27 (run 100 deps4)

## Kết luận: PASS

## Tổng quan

Diff gọn, đúng phạm vi D100.1–D100.6. Đã đối chiếu độc lập:

- `package.json` ×4 so với nhánh #25 (`origin/dependabot/npm_and_yarn/npm-minor-patch-8c9e93740b`, `43e9159`): chỉ khác `-"@fastify/formbody": "8.0.2"` (be) và `@types/node` 22.10.5 → 22.20.5 (be, fe-admin, fe-sso-test, e2e). Không có gì khác.
- `pnpm-lock.yaml` so với lockfile #25, sau khi chuẩn hoá chuỗi peer `@types/node@22.x`: chỉ mất `@fastify/formbody@8.0.2` (importer + package + snapshot), `fastify-plugin@5.1.0`; thêm `@types/node@22.20.5` (+ snapshot → `undici-types@6.21.0`), `undici-types@6.21.0`. Đúng D100.6 bước 3. Override/pin giữ nguyên.
- `dependabot.yml`: ignore `@types/node` `version-update:semver-major` nằm đúng khối npm, cú pháp giống ignore `node` ở khối docker. Minor/patch trong 22.x vẫn vào nhóm `npm-minor-patch` (có cooldown 14 ngày).
- DEBT-714: ghi chú đúng D100.5, không bump Playwright.
- Tự chạy lại `pnpm -C be test:int test/b74-tester.int-spec.ts -t "run 100"`: 2 passed, 66 skipped.

Điểm tốt: test `/login` có **đối chứng** (cùng form, bỏ `__proto__` ⇒ 401 chứ không phải 403), chứng minh CSRF hợp lệ và mã 400 là do parser chứ không do CSRF. Test `/token` assert `invalid_request` (mã hỏng sẽ cho `invalid_grant`), nên nếu Nest đổi lại sang bỏ qua `__proto__` thì test đỏ: hành vi bị khoá thật. Giá trị trông như secret (password, client secret) đều sinh lúc chạy.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Boundary input (prototype pollution qua form)**: `__proto__` bị parser từ chối trước route (400 `invalid_request`), không 5xx, ở cả route OAuth (`/token`) lẫn route HTML (`/login`). Consent/MFA đi cùng parser + global filter nên một route HTML đại diện là đủ. `__proto__[x]`, `constructor` (tech-lead probe) không đổi so với 12.4.
- **Exposure**: body 400 không có token, không echo password, không stack (`at `, `.ts:N`, `.js:N`); `Cache-Control: no-store` có trên cả hai.
- **State/identity**: `/login` bị từ chối không phát `idp_session`. Không thay đổi src nên không có đường identity/authz mới.
- **Supply chain**: không có gói mới ngoài `@types/node@22.20.5` (2026-10-01) và `undici-types@6.21.0` (2024-11), đều ≥ 14 ngày; gỡ một dependency runtime không dùng (`@fastify/formbody`) làm giảm bề mặt.
- jose 6.2.17 chỉ đổi đường verify/decrypt (tech-lead). Bằng chứng runtime phải đến từ gate tester D100.7 (vault 32, drill rotate local, int `token`/`federation`/`admin-keys`). Đây là điều kiện của tester, không phải blocker review.

### Lệch D100.3(a) — chấp nhận

Đặt case `/token` ở `b74-tester` (dùng `bootFullApp`, chuỗi filter như production) thay vì `token.int-spec.ts` là đúng. Harness `token.int-spec` dùng `FastifyAdapter` trần, không có global OAuth filter, nên assert `no-store`/`invalid_request` ở đó sẽ kiểm một chuỗi không tồn tại ở production (dev đã thấy `cache-control` undefined). Ý D100.3 là khoá hành vi trên endpoint thật. Số int FULL vẫn 2524 + 2 = 2526.

### `@types/node@22.10.5` còn trong lockfile — chấp nhận

Còn lại do peer `'*'` của `@jest/pattern@30.5.0`, `@jest/types@29.6.3/30.5.1`, `jest-mock@30.5.2`, `jest-util@30.5.1`. pnpm giữ resolution cũ đã có trong lockfile #25 vì `*` vẫn thoả. Chỉ là type dev, không vào runtime/image; typecheck ×4 xanh nên không có xung đột khai báo global. Có thể gom bằng `pnpm dedupe`, nhưng lệnh này có thể đổi resolution khác ngoài phạm vi D100.6 bước 3. Xem 💭 bên dưới.

### `run71-tester` dòng 157 đỏ một lần — không liên quan diff, là flake có sẵn

Dòng 157: `for (const s of secrets) expect(body).not.toContain(s);`. Corpus có hai "secret" chỉ gồm 4 ký tự hex: `'e378'` và `'63bf'` (hàng Teredo). Body `/admin/audit` chứa ~19 UUID ngẫu nhiên (18 `eventId` + `actorId`), tức khoảng 320 cửa sổ 4 hex ⇒ xác suất trùng ngẫu nhiên khoảng 1% mỗi lần chạy, bất kể tải. Chạy riêng pass là đúng kỳ vọng. Diff run 100 không chạm `src/` hay audit, và mongoose 9.12.1 không làm thay đổi kiểu này (nếu do code thì chạy riêng cũng đỏ). Tester theo dõi trong int FULL: đỏ lại ở dòng 157 thì chạy lại suite đó; đỏ ở dòng khác thì điều tra. Sửa test ghi vào DEBT-715.

## 🟡 Nên sửa

- **DEBT-715** (có sẵn, ngoài phạm vi run): `be/test/run71-tester.int-spec.ts:41` — secret Teredo `'e378'`, `'63bf'` quá ngắn, va UUID ngẫu nhiên trong body ⇒ flake ~1% ở dòng 157. Vì sao: một gate int đỏ ngẫu nhiên làm mất tin tưởng vào gate. Đề xuất: dùng chuỗi có dấu `:` không thể xuất hiện trong UUID (`'4136:e378'`, `'63bf:3fff'`), hoặc assert trên từng `item` thay vì cả `body`.

## 💭 Nit

- `be/test/b74-tester.int-spec.ts:241` — case `/login` nằm trong `describe('headers on HtmlExceptionFilter error pages')` nhưng response là JSON từ global OAuth filter (chính comment cũng nói form không tới HTML filter). Cân nhắc một `describe('run 100: __proto__ form key')` riêng cho 2 case, để tên khớp nội dung.
- `be/test/b74-tester.int-spec.ts:282` — tự dựng `Basic ${Buffer…}` trong khi `basicAuth()` đã export từ `./full-app` (file đang import từ đó).
- `pnpm-lock.yaml` — `@types/node@22.10.5` sót lại do peer `*` của jest. Lần deps sau có thể thử `pnpm dedupe --check`; nếu chỉ đổi peer jest thì dedupe.
- `.github/dependabot.yml:7-8` — comment đầu file liệt kê các ignore "có thể chặn security PR" kèm DEBT. Ignore `@types/node` không cần DEBT (gói types không có advisory runtime), nên không phải sửa. Chỉ ghi lại để không ai thêm DEBT sau này.

## ✂️ Ponytail

- be/test/b74-tester.int-spec.ts:L282: stdlib: dựng tay header Basic bằng `Buffer.from(...).toString('base64')`. Thay bằng `basicAuth(client.clientId, client.secret)` từ `./full-app`.
net: -0 lines possible (chỉ ngắn dòng). Lean already. Ship.
