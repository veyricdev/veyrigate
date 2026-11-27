# Tech Lead Review — 2026-11-27

## Kết luận: PASS (có điều kiện: làm đúng D101.1–D101.12 ở cuối `tasks.md`)

Phạm vi T1–T3 đúng vấn đề, không đổi kiến trúc. Spike trên git worktree tạm trong scratchpad (đã xoá, `git worktree prune`; working tree chung không bị chạm) cho thấy migrate khả thi trong 1 run: 8 file `src` + 12 file test + 1 file test viết lại.

## Bằng chứng

### Phiên bản (npm `time`, mốc 14 ngày = 2026-11-13)
| Gói | Hiện tại | Đích | Phát hành |
|---|---|---|---|
| `@tanstack/react-start` | 1.168.61 | **1.169.5** | 2026-11-08 (1.169.6/1.169.7 = 2026-11-19, chưa đủ tuổi) |
| `@tanstack/react-router` | 1.170.42 | **1.170.46** (Start 1.169.5 ghim exact) | 2026-10-22 |
| `router-core` / `start-client-core` / `start-server-core` / `start-storage-context` / `react-start-server` | 1.171.35 / 1.170.35 / 1.169.40 / 1.167.37 / 1.167.47 | 1.171.39 / 1.170.39 / 1.169.45 / 1.167.41 / 1.167.52 | 2026-10-22 |
| `react-start-client` / `react-start-rsc` / `start-plugin-core` / `router-utils` / `router-plugin` / `router-generator` | 1.168.40 / 0.1.60 / 1.171.50 / 1.162.3 / 1.168.43 / 1.167.41 | 1.168.45 / 0.1.66 / 1.171.56 / 1.163.0 / 1.169.0 / 1.168.0 | 2026-11-08 |
| `history` / `start-fn-stubs` / `react-store` | không đổi | 1.162.5 / 1.162.0 / 0.11.2 | ≤ 2026-10-10 |
| Bắc cầu mới | — | `srvx@1.0.8` (10-27), `unplugin@3.7.0` (10-28), `fetchdts@0.2.0` (08-31), `diff@9.0.0` (04-13); **bỏ** `h3@2.0.1-rc.20`, `rou3@0.8.1` | — |

Mọi gói Start 1.169.5 ghim exact giữa các `@tanstack/*` ⇒ một bộ khớp duy nhất. Chỉ sửa 2 dòng `fe-admin/package.json` rồi `pnpm install` (minimumReleaseAge 20160 đang bật) ⇒ lockfile chỉ đổi các dòng trên; importer be/fe-sso-test/e2e không đổi. `pnpm install --frozen-lockfile` OK; `pnpm audit --audit-level high` ⇒ "No known vulnerabilities found".

### Advisory (GitHub advisory API)
- `@tanstack/start-server-core` GHSA-qx66-fv34-fjm8 (critical, < 1.169.39): đích 1.169.45 ngoài khoảng (hiện tại 1.169.40 cũng ngoài khoảng). GHSA-g7cv-rxg3-hmpx chỉ các bản `=` cụ thể tháng 5, không dính.
- `seroval`: 10 GHSA, bản vá cao nhất là 1.6.11 ⇒ 1.6.12 và 1.8.x đều sạch. `seroval-plugins`: không có. `srvx` GHSA-p36q-q72m-gchr (< 0.11.13): direct 0.11.22 và 1.0.8 đều sạch.

### Breaking 1.168.61 → 1.169.5 (release notes GitHub + đọc dist `start-server-core@1.169.45`)
1. **`.inputValidator()` bị xoá** (`start-client-core@1.170.36`, #8694) ⇒ `.validator()` cùng chữ ký. 25 chỗ trong `src/features/admin-api/{audit,clients,resources,secrets,signing-keys,users}.ts` (+ comment `inputs.ts:4`). Chưa đổi thì 115 lỗi TS (kiểu suy ra `{}`/`unknown` lan sang `routes/**`, `features/clients|users/**` và 2 test dashboard) — đổi xong typecheck **0 lỗi**, không cần sửa route nào.
2. **`getResponseHeaders()` trả `ReadonlyResponseHeaders` (bản sao, không có `append/set/delete`)** (`start-server-core@1.169.41`, #7588). Nay **typecheck bắt được** (3 lỗi `instance.ts:24,42,43`, 1 lỗi `viewer.ts:13`), không còn "mất âm thầm" ở compile — nhưng unit test mock `getResponseHeaders` nên vẫn phải khoá ở runtime thật. Chỗ sửa:
   - `fe-admin/src/features/auth/viewer.ts:2,13` ⇒ `appendResponseHeader("set-cookie", setCookie)`.
   - `fe-admin/src/server/admin-api/instance.ts:2,24` ⇒ `appendResponseHeader("set-cookie", value)`; `:40-44` `setNoStore` ⇒ `setResponseHeader("cache-control","no-store")` + `setResponseHeader("pragma","no-cache")`.
3. **Ngữ nghĩa Set-Cookie mới**: `appendResponseHeader('set-cookie', …)` gộp theo danh tính cookie (name + domain + path), cookie cùng danh tính ⇒ bản sau thắng; cookie khác tên giữ nguyên (spike thật: `fea_sid` ×2 + `other` ⇒ ra `other` + `fea_sid` cuối). Với fe-admin chỉ phát `fea_sid` xoá (cùng giá trị) ⇒ chấp nhận; DEBT-287 ("không làm rơi cookie khác") vẫn đúng.
4. **Helper chỉ áp khi response đi qua pipeline Start** (`createStartHandler` → `finalizeResponse`). Spike: `createServerEntry({fetch(){appendResponseHeader(...); return new Response()}})` ⇒ header helper **không** có trên response. fe-admin chỉ gọi helper trong server fn/SSR (qua `handler.fetch`) nên đúng; cấm dùng helper ở nhánh sớm của `src/server.ts` (healthz/assets/`//`/body-limit).
5. **h3 bị gỡ khỏi runtime**: `runInStartRequest` không còn sửa `request.url` (h3 `decodePathname` cũ), chỉ trả 400 khi `%` + `decodeURI` ném; router vẫn có nhánh 308 `getNormalizedURL(...).handledProtocolRelativeURL` (`createStartHandler.js:327-329`). Guard `//` của `src/server.ts:20-33,58` vẫn đúng (nay là bao rộng hơn) nhưng **comment h3 thành sai** và `test/protocol-relative-risk.test.ts` hỏng cả suite (`Cannot find module 'h3-v2/package.json'`, dòng 32) + tripwire phiên bản (dòng 146-155: router-core 1.171.35, h3 2.0.1-rc.20).
6. Khác (không cần sửa code, đã đối chiếu): `createCsrfMiddleware` chỉ refactor sync/async, logic giữ (`start.ts:6`); handler mặc định vẫn cảnh báo khi thiếu CSRF; `setResponseStatus` trong `serverFnErrorBoundary` (status 500/503) vẫn được giữ cho lỗi server fn; `useSession` bị gỡ (fe-admin không dùng); server route nhận pathname đã decode của router (`/auth/*` chỉ đọc query); `getCookie` vẫn có (`ui-prefs.ts`); 1.169.5 chỉ đổi Rsbuild `server.compress` (không dùng Rsbuild).

### Spike (worktree, đã xoá)
- Sau (1)+(2): `pnpm typecheck` 0 lỗi; `pnpm lint` sạch; `pnpm build` OK, `routeTree.gen.ts` không đổi; `check:bundle` 0 hit.
- Unit fe-admin sau khi đổi `inputValidator:` ⇒ `validator:` trong 9 mock: **1652 pass / 9 fail / 8 skip (1669)**. 9 fail đúng là các test khoá (mock `getResponseHeaders` cũ): `admin-fn` 1, `health-fn` 2, `secrets-fn` 5, `viewer-fn` 1, + suite `protocol-relative-risk`. Chứng tỏ các test khoá bắt được.
- Build prod chạy `node serve.mjs` (NODE_ENV=production, Redis/IdP không tới được): `/healthz` 200, `/auth/login` 503, `//a` (Host giả) 404 không `Location`, `/x` 307 → `/auth/login?returnTo=%2Fx`, POST `/_serverFn/x` `Sec-Fetch-Site: cross-site` 403; mọi response có CSP nonce, `x-frame-options: DENY`, `cache-control: no-store`. GET `/` kèm `__Host-fea_sid` giả ⇒ 503 no-store, body không stack.
- Bỏ override seroval: `pnpm install` giữ 1.6.12 trong lock; `pnpm update -r seroval seroval-plugins` ⇒ 1.8.1 / 1.8.0, audit sạch, unit như trên, build OK.

## Kiến trúc đề xuất
Không đổi. BFF giữ mô hình hiện tại; chỉ đổi cách ghi header sang helper của Start.

## Điểm mạnh
- Plan đã nêu đúng 2 breaking nguy hiểm và yêu cầu test khoá; Start 1.169 còn biến lỗi ghi header thành lỗi compile.
- Phòng thủ nhiều lớp: `withSecurityHeaders` tự thêm `no-store` khi thiếu ⇒ mất `setNoStore` không lộ cache-control, nhưng vẫn mất `pragma` (dùng làm tín hiệu test).

## Vấn đề (đã chốt cách xử lý — dev phải làm đúng, làm khác ⇒ senior REJECT)
- [ ] Viết lại `fe-admin/test/protocol-relative-risk.test.ts` theo pipeline 1.169 (D101.4), không xoá/skip.
- [ ] Khoá Set-Cookie/no-store bằng runtime Start thật (E2E), không chỉ mock (D101.6).
- [ ] Không dùng `minimumReleaseAgeExclude`; không lên 1.169.6/1.169.7 (D101.1).
- [ ] DEBT-715: giữ nguyên các chuỗi bí mật bare (`e378`, `63bf`), chỉ khử ID ngẫu nhiên (D101.10).

## Đề xuất (không bắt buộc)
- Override `'@tanstack/router-generator>prettier': 3.9.9` có thể bỏ (repo đã ở prettier 3.10.1, 2026-11-12) — kiểm `routeTree.gen.ts` không đổi; đưa vào backlog (DEBT-718).
- `fe-admin` direct `srvx@0.11.22` (host `serve.mjs`) khác `srvx@1.0.8` của Start (chỉ dev/build). Không bắt buộc đồng bộ (DEBT-717).
