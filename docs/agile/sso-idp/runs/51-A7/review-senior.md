# Senior Review — 2026-10-24

## Kết luận: PASS

Không có 🔴. Còn 1 🟡 (DEBT-366) ghi vào backlog. Chuyển **tester**.

Phạm vi review: diff chưa commit so với `b9e6cb8`, gồm fe-admin, e2e, fe-sso-test và root `package.json`. Bỏ qua `.github/agents`, `.vscode`, `.mcp.json`, `.claude/`.

Đã chạy lại (foreground):
- `pnpm -C fe-admin typecheck`: OK.
- `pnpm -C fe-admin lint`: OK.
- `pnpm -C fe-admin build`: OK.
- `pnpm -C fe-admin test`: 57 file / 1328 test xanh.
- Đã kiểm tra trực tiếp bundle `dist/client`.
- Không chạy E2E.

## Tổng quan (ấn tượng chung + điểm tốt)

Thay đổi gọn, bám đúng fold.

**Wrapper `withSecurityHeaders`**
- Nằm ngoài cùng, bọc cả 500 khi env lỗi lẫn 503.
- Copy `Headers` chứ không mutate (an toàn với `Response.redirect`), không đọc body, giữ mọi `Set-Cookie`.
- `no-store` chỉ đặt khi chưa có `cache-control`; HSTS chỉ khi https.
- `Referrer-Policy: same-origin`; `form-action` gồm `'self'` và origin của issuer.
- Chuỗi CSP khớp đúng fold, `script-src` không có `unsafe-inline`/`unsafe-eval`.

**Nonce**
- Mỗi response một giá trị `randomBytes(16)` (128 bit), giữ trong ALS riêng.
- Router được tạo theo request (`routerPromise` cục bộ trong `createStartHandler`) bên trong `requestNonce.run`, nên nonce nằm trên `router.options.ssr` từ trước khi stream bắt đầu. Request đồng thời không dùng chung được nonce.
- Nonce không xuất hiện trong log hay lỗi.

**Bundle client**
- Không có `async_hooks`/`AsyncLocalStorage`/`randomBytes` trong client bundle: nhánh `.server()` của `createIsomorphicFn` đã bị loại.
- Client đọc nonce từ `meta[property="csp-nonce"]`.

**Test**
- Test unit bám sát từng mục (a)–(i).
- `csp-nonce-ssr` kiểm stream thật có Suspense/defer.
- Ma trận cookie http/https chạy qua flow BFF thật.
- Test CSRF wiring đi qua `startInstance.getOptions()` thật, không gọi thư viện trực tiếp.
- Test log canary chặn mọi mức console.
- E2E bắt vi phạm bằng cả listener lẫn console, kiểm raw HTML: mọi `<script>` đều có nonce khớp header.

**T1**
- Sửa đúng gốc (`--workspace-concurrency=1`).
- Timeout 20 s chỉ cho `describe` của check-bundle.
- `vi.waitFor` chỉ ở 2 assert async. Không retry, không nâng timeout toàn cục.

**DEBT-359**
- `auditListQuery` (`queryOptions`) dùng chung đúng chỗ.
- `CountCard` dùng `nextCursor === null`.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

**Nonce ≥128 bit, mới cho mỗi response.** ✅
- Lấy từ `randomBytes(16)`, sinh trong `withSecurityHeaders` cho từng lần gọi.
- Không ở cấp module; mutation 6 RED.
- E2E: 4 lần tải ra 4 nonce khác nhau.

**Không rò nonce giữa các request đồng thời.** ✅
- `AsyncLocalStorage.run` bao trọn `handle`.
- `getRouter()` chạy lười bên trong đó, kể cả nhánh `handleRedirectResponse`.
- Stream sau khi `run` trả về vẫn dùng nonce đã gắn vào router, không đọc lại ALS.

**Mọi script SSR/stream mang nonce.** ✅
- Unit (b) kiểm `$_TSR`, chunk defer, `$RC` của Suspense và meta.
- E2E kiểm raw HTML `/` và `/clients`.

**Không cache nonce.** ✅
- `no-store` khi chưa có `cache-control`.
- Grep `src/`: mọi chỗ tự đặt `cache-control` đều là `no-store` (`instance.ts`, `bff.ts`, `errors.ts`, `unavailable.ts`). Start không tự đặt `cache-control` cho HTML.

**Không rơi `Set-Cookie`.** ✅
- `new Headers(res.headers)` giữ multi-value. Unit (c) và mutation 3 RED.

**Áp cho cả 500 env lỗi và 503.** ✅
- Unit (h) và code `server.ts`.
- Ngoại lệ: nếu `handle` throw (Start không bắt) thì response 500 do runtime sinh ra sẽ thiếu header (xem 💭).

**HSTS chỉ khi https.** ✅ Unit (f) và mutation 4.

**`form-action`.** ✅
- Gồm `'self'` và `new URL(OIDC_ISSUER).origin`.
- Khi không có issuer thì chỉ `'self'`.
- Logout qua form trong E2E sạch vi phạm.

**Clickjacking.** ✅ `frame-ancestors 'none'` + `X-Frame-Options: DENY`.

**CSRF server fn.** ✅
- Fail-closed cho GET/POST × {cross-site, same-site, none, Origin lạ, Origin null, không header}.
- Unit wiring có mutation; E2E thêm `sec-fetch-site: none` ⇒ 403.
- Request `handlerType: "router"` không bị lọc. Đúng, vì logout tự kiểm `sameOrigin`.

**Cookie.**
- `fea_sid`/`fea_tx`: ✅ `HttpOnly`, `SameSite=Lax`, `Path=/`, không có `Domain`; https thì thêm `Secure` + `__Host-`. Ma trận gồm login, callback, logout và viewer chết.
- `theme`/`sidebar_state`: ✅ `SameSite=Lax`; `Secure` khi https. Không `HttpOnly` (chấp nhận có chủ đích; server whitelist giá trị).

**Exposure / INV-20.** ✅
- `no-console: error` cho `src/**`.
- Canary qua callback, refresh 400/500; admin API dùng test có sẵn.
- `errors.ts` chỉ log `name: message`.

**Bundle.** ✅
- Chỉ `server-only` lọt vào nhánh server.
- `check:bundle` 0 hit (theo log dev). Tôi không chạy lại với canary vì không đọc secret.

## 🟡 Nên sửa

🟡 **CSP: zod jitless không chạy đủ sớm trong bản build production → DEBT-366**

`fe-admin/src/router.tsx:1` và `src/lib/zod-jitless.ts:7`.

Chỉ ở Vite dev thì `import "@/lib/zod-jitless"` mới chạy trước mọi schema. Trong `vite build` thì khác:
- Zod và `features/admin-api/step-up.ts` bị gộp vào chunk chung `dist/client/assets/step-up-*.js`.
- `index-*.js` import tĩnh chunk này, nên nó chạy **trước** `qe({jitless:!0})`.
- Ở cấp module của chunk đó có `_c=os({v:ms(1),action:Co(),…})`, tức `StoredIntent = z.object(...)`.

Vì sao gây vi phạm: zod tính `fastEnabled = jit && allowsEval.value` **khi dựng** `ZodObject` (`zod/v4/core/schemas.js:1166-1168`), không phải khi parse.

Đã chứng minh bằng script node:
- Bọc `globalThis.Function` bằng Proxy.
- Dựng `z.object` trước `z.config` ⇒ đếm được 1 lần probe `new Function`.

Hệ quả:
- Production báo 1 vi phạm `script-src` (eval) mỗi lần tải trang. AC "0 vi phạm" của Task 4 chỉ đúng ở dev.
- Nhận định của DEBT-364 "đã sửa cả production" không đúng.
- **Không hở bảo mật**: CSP vẫn chặn eval và zod tự rơi về parse thông dịch. Vì vậy không phải 🔴.
- E2E chỉ chạy dev, còn `csp-nonce-ssr (c)` chỉ assert `z.config().jitless`, nên không test nào bắt được.

Đề xuất: cân nhắc gom về `src/lib/zod.ts`:

```ts
import { z } from "zod";
z.config({ jitless: true });
export { z };
```

- Mọi module app import `z` từ file này.
- Thêm `no-restricted-imports` cho `"zod"` ngoài file đó.
- Thứ tự đánh giá ESM khi đó bảo đảm config chạy trước mọi schema, bất kể cách chia chunk.
- Bỏ import "đặt đầu tiên" trong `router.tsx`, vốn dễ vỡ khi ai đó sắp xếp lại import.

## 💭 Nit

💭 `src/lib/zod-jitless.ts:3-6`: comment ghi "before any parse". Ràng buộc thật là "trước khi **dựng** bất kỳ `z.object`". Nên sửa luôn khi làm DEBT-366.

💭 `src/server/security-headers.ts:46`: nếu `handle` throw, wrapper reject. Runtime (srvx/Vite) sẽ trả 500 tự sinh, không có CSP/`no-store`.
- Thân lỗi mặc định không chứa script nên rủi ro thấp, và hành vi này đã có từ trước.
- Có thể cân nhắc `try { … } catch { return new Response("Internal Server Error", { status: 500 }) }` bên trong `run` để invariant "mọi response qua entry đều có header" là tuyệt đối.

💭 `test/security-headers.test.ts` (b): chưa có case 2 request **đan xen** (hai `withSecurityHeaders` chạy song song, có `await` ở giữa, mỗi bên đọc `currentCspNonce()`). ALS đã bảo đảm điều này nên chỉ cần thêm nếu muốn ghi rõ invariant đồng thời trong test.

💭 `src/routes/index.tsx:91-96`: `countText(query.data)` bị gọi 2 lần ở 2 nhánh. Có thể giữ `const text = countText(query.data)` như trước.

## Quyết định về 2 chỗ lệch fold

### DEBT-364: `z.config({ jitless: true })` toàn cục

**Hướng đúng, vị trí chưa đủ.**

Chấp nhận để toàn cục, áp cả server, vì:
- Server không có CSP nên jitless ở server vô hại về hành vi.
- Payload admin nhỏ và luồng bị I/O chi phối, nên chi phí parse thông dịch không đáng kể.
- Tách riêng cho client sẽ cần custom client entry hoặc nhánh isomorphic, tức thêm code mà không được gì.
- `env.ts` đã parse trước khi `router.tsx` được import ở server. Điều này không ảnh hưởng gì vì không có CSP.

Có một đường dựng schema trước khi config chạy: chunk chung `step-up-*.js` trong bản build production ⇒ DEBT-366. Sửa bằng re-export `lib/zod.ts`. Không cần chuyển sang client entry.

### DEBT-365: `eslint-disable-next-line` từng dòng ở `env.ts` / `idp.ts`

**Chấp nhận, không chuyển vào `errors.ts`.** Đã kiểm INV-20:
- `env.ts:60-61` chỉ in tên biến và `i.message`. Mọi validator đều dùng thông điệp tự đặt cố định (`required`, `must be a valid URL`, `must be at least 32 characters`, refine `must be an origin…`), nên không echo giá trị env hay secret.
- `idp.ts:94-95` là text cố định, không có token/IdP body.
- Comment disable có lý do chính là cơ chế ngoại lệ đã được review và được ESLint chặn khi thêm mới. Thêm `logServerWarning` chỉ để bỏ 2 comment là abstraction thừa.

Đóng DEBT-365 khi đóng run.

## ✂️ Ponytail

Lean already. Ship.

- `security-headers.ts`: một hàm, không có option thừa.
- `writePrefCookie`: 2 dòng, dùng cho 2 chỗ.
- `auditListQuery`: loại bỏ trùng lặp.
- `fake-idp` chỉ thêm 1 tham số mặc định.
- Test không trùng phần mà `admin-api-risk`/`bff-risk` đã phủ.
- Riêng DEBT-366 sẽ **xóa** `lib/zod-jitless.ts` và import đặc biệt trong `router.tsx`, thay bằng 1 module re-export. Số dòng gần như không đổi nhưng bền hơn.

---

# Senior Review — Vòng 2 (2026-10-24), phạm vi: retry 1 cổng audit
## Kết luận: PASS

## Tổng quan
frontend-dev áp dụng đúng fold tech-lead, đủ tối thiểu: 3 `package.json` chỉ đổi dòng `zod`, `pnpm-workspace.yaml` thêm đúng 2 khối (override + ignore) kèm lý do, và lockfile chỉ đổi zod. Reviewer đã tự xác minh lại, không dựa vào log:
- `git diff pnpm-lock.yaml`: mọi dòng `+`/`-` đều liên quan zod. `grep -c zod@4.6.5` = 0. Key package mới duy nhất là `zod@4.6.6`. Không có `happy-dom` trong diff, lockfile vẫn là `happy-dom@21.0.1`.
- Integrity trong lockfile khớp registry: `npm view zod@4.6.6 dist.integrity` = `sha512-4UmzQUF5…UhA==`, giống hệt giá trị trong fold. 4.6.6 không có dependency nên không kéo transitive mới.
- `pnpm -r why zod` chỉ ra 4.6.6. `be`, `fe-admin`, `fe-sso-test` đều resolve `zod/package.json` thành 4.6.6.
- `pnpm audit --audit-level high` exit 0 (6 low, 7 moderate, "1 ignored: 1 high"). `pnpm -r run typecheck` exit 0 (4 project).

## Các dòng lockfile ngoài danh sách fold: chấp nhận được
1. **Peer range bị viết lại** (`@t3-oss/env-core` `^3.24.0 || ^4.0.0`, `zod-validation-error` `^3.25.0 || ^4.0.0` ⇒ `zod: 4.6.6`). Đây là hành vi chuẩn của pnpm: override toàn cục `zod` áp cho cả peerDependencies, rồi pnpm ghi range sau override vào metadata của lockfile. Range gốc trong tarball không đổi. Cả 2 range gốc đều chứa 4.6.6 nên không có xung đột peer và không có cảnh báo.
   Hệ quả cần biết (đã ghi trong DEBT-369, không cần debt mới):
   - (a) Khi override còn đó, mọi nơi trong workspace đều bị ghim 4.6.6, **kể cả dependency trực tiếp**. Nếu sau này ai đó sửa `package.json` thành `zod: 4.6.7` mà quên gỡ override, pnpm vẫn cài 4.6.6, không báo gì. Lockfile sẽ cho thấy specifier 4.6.7 nhưng version 4.6.6, đó là dấu hiệu duy nhất.
   - (b) Không package nào cài được zod 3 nữa. Hiện chẳng ai cần.
   - (c) Khi gỡ override, các peer range sẽ trở về giá trị gốc trong lockfile. Đây là diff dự kiến, không phải trôi phiên bản.
   Comment override ("Drop on the next zod bump") cùng DEBT-369 đã phủ cả 3 điểm. Đề xuất khi làm DEBT-369: gỡ override **cùng commit** với lần bump zod kế tiếp và kiểm `specifier == version` cho zod ở 3 importer.
2. **Hậu tố key `(zod@4.6.6)`** của `@t3-oss/env-core@0.13.11(...)` và `zod-validation-error@4.0.2(...)`: đây là ID snapshot peer-resolved. Hậu tố đổi theo zod là bắt buộc. Package và version gốc không đổi (0.13.11, 4.0.2), integrity giữ nguyên.

## Security invariants / trust boundaries đã kiểm
- **Supply chain**: không có package mới. Integrity khớp registry. Ngoại lệ quy tắc 14 ngày có ghi nhận: 13 ngày, bản vá bảo mật, 0 dep. Đủ 14 ngày lúc 2026-10-25T16:18Z, nên rủi ro tồn dư không đáng kể.
- **Fail-closed của cổng CI**: tự kiểm bằng cách chạy audit trên bản sao lockfile/workspace trong scratchpad, gỡ lần lượt từng entry ignore (repo không bị sửa):
  - Gỡ braces (GHSA-vfj7-8cjw-p6xm): vẫn exit 0, "1 ignored".
  - Gỡ happy-dom (GHSA-834v-8h66-3h79): exit 1, lộ happy-dom high.
  - Gỡ cả hai: exit 1, chỉ còn happy-dom.
  - ⇒ "1 ignored" chính là happy-dom. **Entry braces là entry chết**: GitHub Advisory API báo GHSA-vfj7-8cjw-p6xm có `withdrawn_at: 2026-10-23T12:53:02Z`, nên registry không còn trả advisory này cho `braces@3.0.3`. Lý do số đếm là 1 chứ không phải 2 như log đoán ("có thể do registry") đã được xác nhận.
- **Exposure**: không có thay đổi code runtime. Lỗ hổng zod (GHSA-mrhx-c7xc-m3w5, DoS bộ nhớ ở BFF `/_serverFn`) đã đóng ở mọi bản copy. Phòng thủ nhiều lớp (giới hạn body) vẫn để ở DEBT-370.

## 🔴 Blocker
Không có.

## 🟡 Nên sửa
- [ ] `pnpm-workspace.yaml:22-25`: entry ignore `GHSA-vfj7-8cjw-p6xm` (braces) đã chết vì advisory bị withdraw ngày 2026-10-23.
  - Vì sao: entry ignore chết là cấu hình nói sai sự thật. Nó làm người đọc tưởng đang chấp nhận một rủi ro high. Nếu ID này bị khôi phục, nó sẽ bị nuốt im lặng mà không ai rà lại. Nó cũng làm DEBT-226 tồn tại mãi.
  - Đề xuất: gỡ 4 dòng (comment + entry) và đóng DEBT-226 ở lần chạm config kế tiếp, cùng commit với DEBT-369 vào 2026-11-04.
  - **Không gỡ trong run này**: nằm ngoài phạm vi fold, và việc giữ lại không làm cổng yếu đi với advisory nào đang hoạt động.
  - ⇒ **DEBT-371**.

## 💭 Nit
- Log retry 1 đoán "số đếm có thể do registry". Nguyên nhân thật (withdraw) đã được xác định ở trên. Không cần sửa log.
- `node_modules/.pnpm` còn thư mục mồ côi `zod@4.6.5` và `zod-validation-error@4.0.2_zod@4.6.5`, không được link (đã kiểm resolve), nên vô hại. Sẽ tự dọn khi chạy `pnpm install`/`pnpm store prune` lần sau.

## ✂️ Ponytail
- pnpm-workspace.yaml:L22: delete: entry ignore braces đã chết (advisory withdrawn). Gỡ 4 dòng (DEBT-371).
net: -4 lines possible.

⇒ PASS. Chuyển **tester** chạy lại cổng audit + smoke CSP prod.

---

# Senior Review — Vòng 3 — 2026-10-24 (frontend-dev retry 2: race đăng xuất + assertion E2E của tester + `zod-collections.test.ts`)
## Kết luận: PASS

## Tổng quan
Sửa đúng gốc và đủ hẹp. Đúng một điểm chặn là `signInAgain()`, và mọi đường điều hướng tự động tới `/auth/login` đều đi qua nó hoặc qua `step-up`: `QueryCache`/`MutationCache` `onError`, `client-secrets.tsx:199`, `user-account.tsx:95`, `startStepUp`, `reauthenticate`. Đã grep `location.assign|replace|href`, không còn đường nào khác. Form logout vẫn là POST thuần: `onSubmit` không `preventDefault`, test khẳng định `defaultPrevented === false`, CSRF (`Sec-Fetch-Site` same-origin ở `bff.ts:409`) không đổi. `useQueryClient()` trong `SignOutButton` an toàn vì cả 2 nơi render (`app-layout.tsx:36`, `route-states.tsx:64`) đều nằm trong `Wrap` của router (`router.tsx:21`). Test race tất định, có đối chứng, và 6 mutation đều RED (theo log).

Đã chạy lại (foreground): fe-admin `vitest run` **60 file / 1346 passed**; 3 file trọng tâm 36/36; `tsc --noEmit` exit 0; eslint trên 4 file đã đổi sạch.

## 🔴 Blocker
Không có.

## Security invariants / trust boundaries đã kiểm
- **Chuỗi request logout**: click ⇒ cờ bật + `cancelQueries()` ⇒ POST `/auth/logout` ⇒ 303 `end_session`. Response `unauthenticated` đến muộn (query đã huỷ, mutation không huỷ được, gọi trực tiếp) không còn `location.assign` ⇒ POST không bị huỷ. Đây đúng là invariant mà tester tái hiện (4/7).
- **Fail closed khi cờ kẹt**: cờ chỉ tắt *redirect phía client*. Server vẫn là nơi cưỡng chế (BFF trả `unauthenticated`), và guard gốc `__root.tsx:25-33` (`beforeLoad` ⇒ `redirect reloadDocument`) **không** bị gate. Nên khi cờ kẹt, mọi điều hướng client vẫn đưa admin về đăng nhập. Không có đường bypass auth, không lộ dữ liệu mới: dữ liệu đã có trên trang thì vốn đã có trước đó. Chi tiết ở 🟡 bên dưới.
- **Các đường logout trả về**: `bff.ts` 405 / 403 / 303 / trang lỗi đều là document ⇒ trang unload ⇒ cờ module biến mất. Không có nhánh 204/download nào giữ trang lại.
- **Step-up**: khi đang đăng xuất, `startStepUp` không lưu draft vào `sessionStorage` (không để lại dữ liệu form sau khi logout). `clearIntent` vẫn chạy.
- **Tab khác (DEBT-373)**: đồng ý mức 🟢. Cửa sổ race chỉ từ lúc BFF huỷ session tới khi IdP `end_session` xong, và tab kia phải refetch đúng lúc đó (không polling, focus đang ở tab đăng xuất). Hậu quả là "đăng xuất chưa trọn" chứ không leo quyền. Nếu tab kia quay lại sau khi IdP đã logout thì nó thấy form đăng nhập, đúng như mong đợi.
- **Assertion E2E** `/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\./`: JWT có header JSON compact `{"…` thì luôn bắt đầu bằng `eyJ`. IdP (jose) và BE luôn serialize compact. Header có khoảng trắng (`{ "` ⇒ `eyAi`, `{\n` ⇒ `ewog`) sẽ lọt, nhưng không có nguồn nào trong hệ phát ra dạng đó. Cursor audit (`{t,e}` base64url, sau nó là `"`) không khớp. JWE `dir` (segment key rỗng) khớp. Regex vẫn đúng mục đích "không token nào tới trình duyệt".
- **`zod-collections.test.ts`**: phủ max 20 ở 5 trường + grantTypes, strict create, 200k phần tử ⇒ đúng 1 issue (đối chứng RED trên 4.6.5 đã có trong test-report). Đạt.

## 🟡 Nên sửa
- [ ] `fe-admin/src/features/admin-api/query-client.ts:16-26` — **cờ `signingOut` có thể kẹt vĩnh viễn trong tab**.
  - Khi nào xảy ra: POST logout không làm trang unload, ví dụ người dùng bấm Stop/Esc trong lúc điều hướng, extension chặn request, hoặc CSP `form-action` chặn 303 tới issuer khi cấu hình issuer lệch.
  - Hậu quả khi kẹt:
    - Hết session thật thì query/mutation chỉ hiện lỗi, không còn tự đưa về đăng nhập.
    - Nút **"Confirm identity"** trong `confirm-action.tsx:53` (`reauthenticate`, hành động do *người dùng bấm*, không phải tự động) **chết im lặng**: bấm không có phản hồi gì.
  - Vì sao không phải 🔴: server vẫn cưỡng chế, và guard gốc không bị gate nên mọi điều hướng route vẫn về login. Đây là lỗi UX/khả dụng, không phải fail-open.
  - Đề xuất (rẻ nhất), chọn một trong hai:
    - (a) Cho cờ tự hết hạn, ví dụ `signingOutUntil = Date.now() + 10_000` và `isSigningOut = () => Date.now() < signingOutUntil`. Cách này cũng bỏ được listener `pageshow`.
    - (b) Không gate `reauthenticate` khi nó được gọi từ click trực tiếp: chỉ gate `startStepUp` và các đường tự động.
  - Thêm 1 test: cờ hết hạn ⇒ `assign` chạy lại.
  - ⇒ **DEBT-374**.

## 💭 Nit
- `fe-admin/test/sign-out-race.test.tsx:105-111`: test "bfcache restore" phụ thuộc listener `pageshow` do test trước đăng ký (cờ module rò giữa các test). Chạy riêng (`-t "back/forward"`, đã thử) thì test pass một cách tầm thường, vì cờ vốn đã `false`, nên không chứng minh được việc reset. Có thể tự gọi `signOut()` trong chính test đó trước khi dispatch `pageshow`. Nếu áp dụng DEBT-374(a) thì test này đổi theo.
- `step-up.test.tsx` phải dispatch `pageshow` để dọn cờ, tức là test phải biết chi tiết nội bộ. Một hàm `resetSignOutForTest` hoặc DEBT-374(a) sẽ gọn hơn. Không bắt buộc.
- `e2e/tests/fe-admin.spec.ts:82` và 2 kiểm tra Web Storage/DOM vẫn dùng `includes("eyJ")` thuần, không cùng regex. Hiện chưa có cursor nào lọt vào DOM/SSR (không prefetch SSR, DEBT-291) nên chưa chập chờn. Nên dùng chung `jwt` cho nhất quán (liên quan DEBT-372).

## ✂️ Ponytail
- fe-admin/src/features/admin-api/query-client.ts:L18-24: shrink: listener `pageshow` `{once}` + cờ boolean. Thay bằng hạn dùng theo thời gian (`signingOutUntil`), giải luôn DEBT-374 (−5 dòng).
net: -5 lines possible.

⇒ **PASS**. Chuyển **tester** lượt 3 (E2E full + `fe-admin.spec.ts` lặp).
