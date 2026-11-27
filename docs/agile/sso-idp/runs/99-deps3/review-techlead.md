# Tech Lead Review — 2026-11-21 (run 99: PR Dependabot #23, #22, DEBT-712)

## Kết luận: PASS (có điều kiện: làm đúng D99.1–D99.6 ở cuối `tasks.md`)

- T1 (#23, 14 gói): áp **toàn bộ**, đúng lockfile của Dependabot. Không cần bump thêm, không override mới, không ignore.
- T2 (#22, digest node): áp **toàn bộ**. Digest mới là index chính thức hiện tại của tag, Node vẫn 22.23.4.
- T3 (DEBT-712): **không đổi**. Chưa có bản openapi-typescript nào khai peer TS 6. Chỉ ghi ngày kiểm vào DEBT-712.

Không có debt mới.

## Bằng chứng

Thử trên git worktree tạm trong scratchpad, ở `origin/dependabot/npm_and_yarn/npm-minor-patch-a73d3f2602` (`6f09c2e`, cha `5426cb2`). Worktree đã xoá và đã `git worktree prune`. Working tree và lockfile của repo không đổi. `develop` (`574f42a`) khác `5426cb2` chỉ ở docs, nên diff của 2 PR áp thẳng được.

### Ngày phát hành (`pnpm view <pkg> time`, mốc 14 ngày = 2026-11-07)

| Gói | Bản | Ngày (UTC) |
|---|---|---|
| @nestjs/common, core, platform-fastify, testing | 12.4.0 | 2026-11-06 10:1x |
| @nestjs/config / mongoose / swagger | 12.1.1 / 12.0.1 / 12.1.1 | 2026-11-06 10:2x |
| tailwindcss, @tailwindcss/cli, @tailwindcss/vite | 4.3.5 | 2026-11-06 15:16 |
| @playwright/test (playwright, playwright-core) | 1.65.0 | 2026-11-05 |
| @tanstack/react-query (query-core) | 5.107.1 | 2026-11-06 23:04 (bản trẻ nhất, đủ 14 ngày từ 2026-11-20 23:04) |
| lucide-react | 1.70.0 | 2026-11-06 |
| vite | 8.3.6 | 2026-11-05 |
| Transitive mới: @fastify/cors / es-toolkit / postcss / swagger-ui-dist | 11.4.1 / 1.53.1 / 8.5.32 / 5.34.1 | 2026-11-05 / 10-30 / 10-26 / 10-30 |

`pnpm install --frozen-lockfile` trên lockfile của PR: "Lockfile passes supply-chain policies". Không cần `minimumReleaseAgeExclude`.

Lockfile chỉ đổi các gói trên cùng peer-suffix (nestjs-pino, mapped-types, TanStack Start/router-plugin/start-plugin-core, vitest, unplugin, vitefu, plugin-react). Pin giữ nguyên: router 1.170.42, Start 1.168.61, `fastify>light-my-request` 6.6.0, seroval, `openapi-typescript>@redocly/openapi-core` 1.34.20.

### Thử áp dụng (worktree)

| Bước | Kết quả |
|---|---|
| `pnpm install --frozen-lockfile` | qua chính sách, 848 gói |
| `pnpm typecheck` (be, fe-admin, fe-sso-test, e2e) | 4/4 Done, exit 0 |
| `pnpm -C be build` | exit 0. `styles.css` chỉ đổi dòng banner `v4.3.4` ⇒ `v4.3.5`. Các rule CSS giống hệt (so sau khi tách theo `}`) |
| `pnpm -C be test` | 69 suites, **1361/1361** |
| `pnpm -C fe-admin build`, `pnpm -C fe-sso-test build` | exit 0 |
| `pnpm -C fe-admin test` | 69 files, **1669/1669** |
| `pnpm -C fe-admin gen:api` | `schema.d.ts` không đổi (swagger 12.1.1) |

### Changelog thật

- **Nest 12.4.0** (release notes v12.4.0): không có mục breaking. Phần chạm fastify là #18414: path static bị từ chối trả 403. Thay đổi này chỉ áp cho `app.useStaticAssets`. BE đăng ký `@fastify/static` trực tiếp (`be/src/bootstrap.ts`, `dotfiles: 'ignore'`), nên không bị ảnh hưởng. Test traversal `b74-tester.int-spec.ts` không ràng buộc status cụ thể (`< 500`, chỉ trả body thật), và `OAuthExceptionFilter` đã xử lý 4xx của plugin. Phần còn lại là platform-node/microservices (không dùng), ParseArrayPipe (không dùng), override provider `undefined` trong testing. Unit 1361 xanh.
- **Playwright 1.65.0**: có breaking liên quan E2E:
  - cookie match theo RFC 6265 (host-only, path);
  - `click`/`fill` chờ element hết `inert`;
  - accessible name bỏ text không render;
  - `APIRequestContext` `params` nối vào query sẵn có.

  Đã kiểm: 4 chỗ `params` đều gọi URL Mailpit không có query. `test.skip(cond, desc)` vẫn typecheck. Cấu hình không dùng shard/blob/Bun. Rủi ro còn lại (cookie scoping, inert, role name) chỉ đo được bằng E2E 53 + X3 42 (chromium, firefox, webkit). Browser mới phải cài: `pnpm -C e2e exec playwright install chromium firefox webkit`. CI đã tự cài chromium theo phiên bản gói (`ci.yml:243`).
- **Tailwind 4.3.5**: CSS output trang login/consent của BE giống hệt, chỉ đổi banner. CSP `style-src 'self'` không đổi, không có SRI.
- **vite 8.3.6, react-query 5.107.1, lucide 1.70.0, @nestjs/config/mongoose/swagger patch**: build, typecheck và unit xanh, `gen:api` không đổi.

### T2 — digest node image

- `docker buildx imagetools inspect node:22.23.4-bookworm-slim` trả index `sha256:5ec23b7c622b…d96d`, khớp PR. Annotation `org.opencontainers.image.source` = `github.com/nodejs/docker-node`, revision `80f02a54…`, `22/bookworm-slim`.
- Image linux/amd64 mới tạo 2026-11-05 (16 ngày), image cũ tạo 2026-10-28. `NODE_VERSION=22.23.4` không đổi. Đây là bản build lại định kỳ của Docker Official Images (cập nhật gói Debian bookworm), không đổi Node.
- `.nvmrc`/`engines` (22.23.4) không đổi.

### T3 — DEBT-712

`pnpm view openapi-typescript`: `latest` = 7.13.0 (2026-02-11), peer `typescript ^5.x`. Không có bản 7.14 hay 8.x. ⇒ không bump, giữ override redocly.

## Kiến trúc đề xuất

Không đổi.

## Điểm mạnh

- PR #23 nhóm đúng cấu hình: Nest đồng bộ 12.4.0 cho cả 4 gói lõi. Tailwind 3 gói cùng bản, vite cùng bản ở fe-admin và fe-sso-test.
- Không gói nào phải xin ngoại lệ release-age. Các pin cũ vẫn giữ.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có. Các điều kiện ở D99.1–D99.6.

## Đề xuất (không bắt buộc)

- Có thể dọn thư mục browser Playwright cũ trong `%LOCALAPPDATA%\ms-playwright` (chromium-1223/1248, firefox-1522, webkit-2287) cho nhẹ đĩa local. Việc này không ảnh hưởng repo và không ghi DEBT.
