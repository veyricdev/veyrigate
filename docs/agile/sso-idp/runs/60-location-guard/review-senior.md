# Senior Review — 2026-10-28 (run 60, T1 [FE] DEBT-446/447 + T2 [BE] DEBT-444/445)

## Kết luận: PASS

Không có 🔴. T1 + T2 → **tester** (E2E 36 là đối chứng tích hợp cho login/logout/step-up/callback, smoke theo fold). Không cần retry dev.

## Tổng quan (ấn tượng chung + điểm tốt)

- Preflight: codegraph 1.6.2, `status` OK, `sync` "Already up to date" (không lock). Diff chưa commit so với HEAD 876b786.
- Tự chạy lại: `pnpm -C fe-admin exec vitest run` 5 file nhắm (security-headers, server-entry, protocol-relative-risk, bff, bff-risk) 201/201; `pnpm -C be test -- framework-errors.spec.ts federation.client.spec.ts` 39/39; `typecheck` + `lint` fe-admin và be exit 0. (Gọi `jest` trực tiếp không có `--experimental-vm-modules` thì suite framework-errors lỗi parse ESM: lỗi cách gọi của reviewer, không phải của diff.)
- T1 đúng fold: kiểm `Location` thuần, không I/O, đặt sau cả nhánh catch và trước `new Headers(res.headers)`, so `origin` chuẩn hoá (không `startsWith`/regex), fail-closed khi không parse được hoặc thiếu cấu hình, bỏ toàn bộ header gốc (gồm `Set-Cookie`), huỷ body, log cố định chỉ chứa status. Test âm/đối chứng đầy đủ và assert log không rò `evil`/`localhost`/`u:p`/path.
- Lệch fold M4 (thêm `http://localhost:30001/` vì `http://localhost:3000.evil.example/` không parse được nên rơi vào nhánh fail-closed) là cải thiện: có ca âm PARSE ĐƯỢC mà là tiền tố chuỗi của origin, nên M4 (`startsWith`) thực sự RED.
- T2 nhỏ, đúng: nhánh DEBT-445 đứng SAU nhánh provider hiện có, chỉ đổi kết quả khi key set rỗng; kid lạ vẫn 400 (đối chứng + mutation RED).

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

**T1 `allowedLocation` (`fe-admin/src/server/security-headers.ts:41-50`, gọi ở `:75-83`)**
- Origin chính xác: `URL.origin` = scheme + host (lowercase, IDN ⇒ punycode, IPv6 có ngoặc) + port, port mặc định bị bỏ (`http://h:80` ≡ `http://h`). `HTTP://LOCALHOST:3000/n` qua (đối chứng); `https://localhost:3000/`, `http://localhost:3001/`, `http://localhost:30001/` bị chặn. Trailing dot `localhost.` cho origin khác ⇒ bị chặn (fail-closed; không nguồn hợp lệ nào phát dạng đó).
- Userinfo: kiểm ở cả 2 nhánh; `http://localhost:3000@evil.example/` có origin evil ⇒ chặn; `http://u:p@localhost:3000/` chặn bởi userinfo.
- Relative với base `http://base.invalid`: tham chiếu tương đối chỉ đổi được origin khi có authority (`//`, `\\`, `/\`, tab/newline bị bỏ) hoặc có scheme. Có scheme ⇒ `URL.canParse` true ⇒ nhánh tuyệt đối. Base `http:` là special scheme như mọi request thật (http/https) nên quy tắc `\` ≡ `/` khớp với cách trình duyệt resolve. Ca lệch duy nhất tìm được là ngược chiều, an toàn: `http:foo` được trình duyệt resolve thành path tương đối (cùng scheme với base) nhưng guard coi là tuyệt đối `http://foo` ⇒ chặn nhầm; không nguồn nào phát dạng này. Không tìm được chuỗi tương đối nào đổi origin mà lọt.
- Nhiều header `Location`: `Headers.get` nối bằng `, `, và khi ghi ra wire Headers cũng gộp thành 1 giá trị ⇒ guard thấy đúng chuỗi trình duyệt nhận.
- `javascript:`/`data:` ⇒ origin `"null"` ⇒ chặn. `blob:http://localhost:3000/…` có origin `http://localhost:3000` ⇒ qua, nhưng redirect tới `blob:` là network error ở trình duyệt và không nguồn nào phát ⇒ không phải lỗ (xem 💭).
- Chạy cho mọi status, kể cả nhánh catch (500 tự dựng không có `Location`); test status 200 có `Location` lạ ⇒ 404 + body cancel.
- Response bị chặn: `new Response("Not Found", 404, content-type)` ⇒ không `Location`, không `Set-Cookie`, rồi vẫn nhận đủ header A7 + `no-store` (helper `blocked()` trong test).
- Exposure log: `logServerError("location guard", new Error("blocked an off-origin Location (status N)"))`, không URL/Host/path/query (test kiểm 7 chuỗi rò).
- Redirect hợp lệ: `login`/step-up 302 ⇒ origin issuer (discovery ép mọi endpoint cùng origin issuer); `logout` 303 ⇒ `end_session_endpoint` (origin issuer) hoặc `/`; callback ⇒ `sanitizeReturnTo` tương đối; `__root` 307 và router 307 tương đối. Đối chứng unit + entry (302 tới `https://idp.example/authorize`) xanh; E2E 36/36 của backend-dev chạy trên cây đã có diff T1. Tester chạy lại để có bằng chứng thuộc lượt test.
- Router 308 với `Host` HỢP LỆ (= host `APP_URL`) cho `Location` cùng origin ⇒ qua guard. Đúng thiết kế: điều hướng cùng origin không phải open redirect, và path `//…` ở lượt sau lại bị guard `//` trả 404. Lớp này chống `Host` giả mạo (open redirect/cache poisoning), không chống mọi URL dựng từ `Host`.
- Sau proxy TLS (`APP_URL` https, request nội bộ http) URL tuyệt đối dựng từ request sẽ là `http://…` ⇒ bị chặn; không redirect hợp lệ nào dựng như vậy (bff dùng `APP_URL`/discovery) ⇒ không chặn nhầm luồng thật.
- `new URL(x).origin` cho `appUrl`/`issuer` (`:77`) nằm ngoài try: cả hai đã được `env.ts` validate lúc khởi động và `contentSecurityPolicy` vốn đã `new URL(issuer)` không try ⇒ không đổi hành vi.
- DEBT-449 (`serve.mjs` `assets` ngoài guard): đồng ý chỉ là tripwire; srvx `serveStatic` không phát redirect.

**T1 DEBT-447 `routerPathname` (`fe-admin/src/server.ts:25-33`)**: chuỗi không có `%` ⇒ `replaceAll` không đổi, `decodeURI` trả nguyên chuỗi, setter `pathname` nhận đúng giá trị đã serialize (không còn `\`, dot-segment đã chuẩn hoá) ⇒ idempotent. Kết quả chỉ dùng cho `startsWith("//")`. Bỏ `if` an toàn; corpus decode run 59 xanh.

**T2 DEBT-445 (`be/src/modules/federation/federation.client.ts:128-131`)**
- jose 5.10.0 `createRemoteJWKSet` (`dist/node/cjs/jwks/remote.js`): `jwks: { value: () => set._local?.jwks() }` là arrow function, không phụ thuộc `this`, đọc key set đang cache.
- Oracle: 502 vs 400 chỉ phụ thuộc trạng thái JWKS của Google, không phụ thuộc token ⇒ kẻ tấn công không học được gì về token. Fail-closed giữ: cả hai nhánh đều throw, không session/user/link (int `DEBT-445 … => 502, nothing created`).
- Cache: đọc `_local` hiện tại, không phải set đã dùng lúc verify ⇒ race với reload đồng thời chỉ có thể phân loại sai 502↔400 trong cửa sổ reload, không đổi fail-closed. Không kẹt: key set rỗng được reload sau `cooldownDuration` (mặc định 30 s); test `cooldownDuration: 0` chứng minh. `_local` undefined ⇒ `?.keys` undefined ⇒ 400 (hành vi cũ).
- Kid lạ / khoá khác cùng kid vẫn 400 (2 đối chứng; mutation "mọi NO_MATCHING ⇒ 502" RED).

**T2 DEBT-444 (`be/src/common/http/framework-errors.ts`)**: guard runtime `Number.isInteger(sc)` + 400..499 giữ; `reply.headers(HEADERS)` không mutate `HEADERS` (Fastify chép từng key) ⇒ an toàn với object `Readonly` dùng chung.

## 🟡 Nên sửa

🟡 **Ponytail/đọc hiểu: kiểu suy qua `FastifyAdapter`** (DEBT-451)
`be/src/common/http/framework-errors.ts:35-44`: chuỗi `Parameters<NonNullable<Extract<NonNullable<ConstructorParameters<typeof FastifyAdapter>[0]>, { trustProxy?: unknown }>['frameworkErrors']>>[0]` thay cho 3 interface 14 dòng.
Vì sao: DEBT-444 nhắm "dùng kiểu của Fastify cho gọn"; khi `fastify` không import được (đúng, pnpm strict; lệch fold chấp nhận được, không thêm dependency), kết quả dài tương đương, khó đọc hơn và gãy theo hình dạng union option của `@nestjs/platform-fastify`. An toàn kiểu không tăng: `createFastifyAdapter` (`:70`) truyền `frameworkErrors` vào `new FastifyAdapter({ … frameworkErrors })`, compiler đã kiểm tương thích ngay tại đó với bất kỳ kiểu cấu trúc nào.
Đề xuất: cân nhắc giữ `type Hook = …setOnRequestHook…` (1 dòng, dễ đọc) cho request/reply và khai báo error cấu trúc `{ statusCode?: unknown; code?: unknown }` (đúng tinh thần "không tin kiểu ở runtime", bỏ luôn cast `statusCode as number` trong spec). Không chặn PASS; gộp với DEBT-460.

## 💭 Nit

- 💭 `allowedLocation` chấp nhận `blob:<origin hợp lệ>/…` (origin của blob URL là origin bên trong). Không khai thác được (redirect tới `blob:` là network error, không nguồn nào phát). Nếu muốn invariant đọc thẳng: thêm `u.protocol === "http:" || u.protocol === "https:"` ở nhánh tuyệt đối. Không mở debt.
- 💭 Thiếu đối chứng port mặc định tường minh (`https://idp.example:443/authorize` với issuer `https://idp.example`) và IDN/IPv6: hành vi do WHATWG URL đảm bảo, test hiện tại đủ cho M1–M8. Không mở debt.
- 💭 DEBT-445 chỉ phân loại key set RỖNG; key set có khoá nhưng không khoá nào dùng được (sai `kty`/`use`/`alg`) vẫn 400. Đúng phạm vi fold; ghi để biết.
- 💭 Đánh số: backend-dev mở DEBT-460 trong khi DEBT-450 là số mở cuối (451–459 trống). Không đổi số để tránh vỡ tham chiếu; debt mới của senior dùng DEBT-451.
- 💭 DEBT-450 (flaky `eyJ`): đồng ý chẩn đoán: `raw` là ciphertext base64 ngẫu nhiên, xác suất chứa `eyJ` ở một vị trí ~1/64³, nhân độ dài vài trăm ký tự ⇒ thỉnh thoảng đỏ. Hướng sửa trong backlog (so với token thật) đúng.

## ✂️ Ponytail

- be/src/common/http/framework-errors.ts:L35: shrink: chuỗi `Parameters<NonNullable<Extract<…ConstructorParameters<typeof FastifyAdapter>…>['frameworkErrors']>>` cho `FastifyError`. Thay bằng `{ statusCode?: unknown; code?: unknown }`; call site `:70` đã kiểm tương thích.
- be/src/common/http/framework-errors.spec.ts:L60: delete: cast `statusCode as number` + comment (chỉ cần vì kiểu trên). Mất theo khi error dùng kiểu cấu trúc.
- fe-admin/src/server/security-headers.ts:L41-50: lean already (10 dòng, 1 hàm, không option/flag).

net: -6 lines possible.
