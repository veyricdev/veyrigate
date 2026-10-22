# Senior Review — 2026-10-21

## Kết luận: PASS

Không có 🔴. Hai 🟡 về security cần xử lý chậm nhất ở A4 (run 42), trước khi secret thật được dùng tới (DEBT-274, DEBT-275). Chuyển **tester**.

## Tổng quan (ấn tượng chung + điểm tốt)

- Dựng tay đúng fold F0. Cấu trúc Start tối thiểu, không có file demo, scripts thật, `routeTree.gen.ts` được commit và nằm trong `ignores` của ESLint.
- Env server đặt ở một chỗ (`src/server/env.ts`) kèm marker `@tanstack/react-start/server-only`. Lỗi validate chỉ in tên biến và message cố định. Test canary phủ cả `err.message` lẫn `console.error`. `server.ts` validate trước request đầu tiên; env sai ⇒ mọi request 500 trơn (fail closed).
- `check:bundle` không thể pass rỗng: ném lỗi khi parse ra 0 tên, khi thiếu `dist/client` hoặc khi `dist/client` rỗng. Canary chỉ in theo chỉ số, không in giá trị. Tôi tự chạy: 3 file client, 7 tên, 0 hit.
- Theme dùng whitelist ở cả đường đọc (server, `parseTheme`) lẫn đường ghi (cookie, giá trị lấy từ union `Theme`). Không có inline script do code mình tạo. Không còn `next-themes`.
- Lockfile sạch. Tôi đã kiểm độc lập: mọi block `packages`/`snapshots`/`importers` có ở `c35174d` (trừ `fe-admin: {}`) đều giống từng byte. Có 159 package mới, không package nào bị gỡ. `seroval` không có ở workspace khác nên override toàn cục vô hại. Tra registry 8 package mới (router-core 1.171.34, start-plugin-core 1.171.49, start-server-core 1.169.39, react-start-rsc 0.1.59, seroval 1.6.8, prettier 3.9.9, h3 2.0.1-rc.20, srvx 0.11.22): tất cả phát hành ≤ 2026-09-30.
- Dependency khớp bảng F1, pin exact. Query/Form/Table chưa cài (đúng YAGNI).
- Kết quả tôi tự chạy: `typecheck` ✅, `lint` ✅, `test` 21/21, `build` ✅, `check:bundle` 0 hit, `pnpm audit --audit-level high` exit 0 (1 low + 1 moderate, ignore cũ không đổi).

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| Env server không lọt bundle client | ✅ | marker `server-only` (dev đã thử mutation: build fail); `check:bundle` 0 hit; chỉ `server.ts` và `src/server/**` import `env.ts` |
| `check:bundle` không thể pass rỗng | ✅ (💭 #1) | throw khi 0 tên, thiếu dir hoặc dir rỗng |
| Lỗi env không lộ giá trị | ✅ | `onValidationError` chỉ in `path: message`; message đều cố định do mình đặt; test canary 31 ký tự |
| `serverEnv()` cache an toàn | ✅ | `??=` chỉ gán khi thành công; lỗi không bị cache. Source được copy, không mutate. Request không ghi vào cache |
| Env sai ⇒ fail closed | ✅ | `envValid=false` ⇒ mọi request kể cả `/_serverFn/*` trả 500, không render |
| https bắt buộc ở production | 🟡 #1 | phụ thuộc biến runtime `NODE_ENV`, không theo build mode |
| Trang lỗi production không lộ message/stack | ✅ ở UI, 🟡 #2 ở payload | `RouteError` ẩn chi tiết khi `!DEV`; nhưng router vẫn dehydrate `match.error.message` vào HTML SSR |
| Theme cookie validate | ✅ | `parseTheme` theo whitelist; giá trị chỉ vào `className`, không vào script/HTML thô |
| XSS sink | ✅ | không có `dangerouslySetInnerHTML`/`innerHTML`/`eval` trong `src/` |
| Workspace khác không đổi | ✅ | so khớp từng block lockfile, diffs = 0 |

Không chạm authn/authz/session/replay (A4).

## 🟡 Nên sửa

1. 🟡 [FE] **Quy tắc https ở production fail open khi thiếu `NODE_ENV`**
   `src/server/env.ts:41` dùng `schema(source.NODE_ENV === "production")`.
   Vì sao: quy tắc chỉ dựa vào biến runtime. Trong `dist/server/server.js`, `IS_DEV = false` đã được ghép cứng lúc build, nhưng dòng `source.NODE_ENV === "production"` vẫn được giữ nguyên. Nếu bản build production chạy mà operator quên đặt `NODE_ENV` (adapter chưa chốt, DEBT-264), `OIDC_ISSUER=http://…` vẫn qua validate. Đến A4, `OIDC_CLIENT_SECRET` và mã/token khi đó sẽ đi qua HTTP rõ.
   Đề xuất: `const production = import.meta.env.PROD || source.NODE_ENV === "production"`. Build mode đủ để bắt buộc https, còn `NODE_ENV` chỉ siết thêm. Giữ test hiện tại và thêm test `vi.stubEnv("PROD", true)` không kèm `NODE_ENV` ⇒ throw. **Làm chậm nhất ở A4** → DEBT-274.

2. 🟡 [FE] **"Không lộ message ở production" mới đúng ở UI, chưa đúng ở payload SSR/RPC**
   Dẫn chứng từ `dist/server/server.js`: `dehydrateMatch` sao `match.error` vào trường `e`, và `ShallowErrorPlugin` serialize `new Error(message)`. Vì vậy lỗi loader ở SSR sẽ nằm trong `<script>` hydration của HTML. Lỗi `createServerFn` cũng trả message về client.
   Vì sao: `RouteError` ẩn message, nhưng attacker chỉ cần xem source hoặc gọi thẳng `/_serverFn/…`. Ở run 41 chưa nguy hiểm vì loader duy nhất là `getUiPrefs`, chỉ đọc cookie. Từ A4/A6 trở đi, lỗi upstream (token endpoint, admin API) có thể mang URL/nội dung nhạy cảm.
   Đề xuất (A4): ở biên server fn/loader, đổi lỗi không chủ đích thành lỗi chung (message cố định, chi tiết chỉ ghi log server, kèm request id), bằng middleware của Start hoặc wrapper. Thêm test canary trên HTML SSR và trên response `/_serverFn` → DEBT-275.

3. 🟡 [FE] Lượt ponytail bên dưới (gộp DEBT-276).

## 💭 Nit

1. `scripts/check-bundle.mjs:12`: tên biến lấy bằng regex `^\s{4}KEY:`. Nếu một key sau này được thêm qua spread (`...redisSchema`) hoặc viết khác thụt lề, nó sẽ bị bỏ qua mà không báo, vì mảng tên vẫn không rỗng. Cân nhắc kiểm thêm "số tên parse được = số key trong `schema()`". Có thể làm bằng một test vitest so `Object.keys` của schema với cùng regex đó.
2. `src/components/ui/sonner.tsx:1`: `"use client"` vô nghĩa với Start (không có RSC). Vô hại.
3. Chunk client `index-*.js` 531 kB (Vite cảnh báo > 500 kB). Chưa đáng lo khi chỉ có 1 route; nên tách route ở A6.
4. `h3@2.0.1-rc.20` là bản prerelease kéo theo transitive của Start. Chấp nhận được (Start pin), chỉ ghi nhận.

## ✂️ Ponytail

- src/components/feedback/route-states.tsx:L13: yagni: prop `showDetails` không ai truyền (test dùng `vi.stubEnv("DEV")`). Đọc thẳng `import.meta.env.DEV` trong thân hàm.
- src/components/ui/sidebar.tsx:L10: shrink: `SidebarInput` (và cả `src/components/ui/input.tsx`) không được dùng; chỉ kéo vào vì là một phần vendored. Xoá `SidebarInput` + `input.tsx`, add lại `input` qua shadcn khi A5 cần.
- src/components/ui/sidebar.tsx: shrink: các export chưa dùng (`SidebarMenuSub*`, `SidebarMenuAction`, `SidebarMenuBadge`, `SidebarMenuSkeleton`, `SidebarRail`, `SidebarGroupAction`, `SidebarFooter`…). Chấp nhận giữ để bám upstream shadcn; chỉ cắt nếu muốn giảm bề mặt review.

net: -40 lines possible (chưa tính phần sidebar giữ để bám upstream).
