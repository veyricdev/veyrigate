# Tech Lead Review — 2026-11-18 (run 96, T1: 5 PR Dependabot)

## Kết luận: PASS (có điều kiện: thực hiện đúng D96.5–D96.12 ở cuối `tasks.md`)

Áp dụng một phần #17 (36/38 gói) và #12 + #10 (ESLint 10) trên `develop` bằng pnpm. Hoãn #11 (TypeScript 7) và cặp `@tanstack/react-start` + `@tanstack/react-router` của #17 (DEBT mới). Đóng #2 (đã có từ run 66/83).

## Bằng chứng (thử trên git worktree tạm trong scratchpad, đã xoá + `git worktree prune`)

- Ngày phát hành mọi bản đích (npm `time`): mới nhất là `lucide-react@1.67.0` 2026-11-03; mốc 14 ngày hôm nay là 2026-11-04 ⇒ cả 38 gói của #17, `eslint@10.14.0` (2026-10-30), `@eslint/js@10.0.1` (2026-02-06), `typescript@7.0.2` (2026-07-08) đều đạt D72.
- Các dependency bắc cầu: chỉ dò được khi bật `minimumReleaseAge: 20160` trong `pnpm-workspace.yaml`. Đang để `0` ⇒ `pnpm install` lấy bản bắc cầu mới nhất kể cả khi < 14 ngày. Khi bật, lockfile hiện tại đã có 9 mục < 14 ngày, đều là ngoại lệ bảo mật đã ghi ở run 83: `@nestjs/cli@12.0.12`, `@nestjs/schematics@12.0.13`, `@angular-devkit/{core,schematics,schematics-cli}@22.2.6`, `@fastify/static@10.1.10`, `@isaacs/nonrecursive-glob-match@1.1.0`, `glob@14.0.4`, `minimatch@11.0.5`. `--frozen-lockfile` cũng kiểm chính sách này (đã thử: bỏ một mục exclude ⇒ `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) ⇒ CI và cả hai Dockerfile (cùng COPY `pnpm-workspace.yaml`) sẽ thực thi D72.
- #17 nguyên khối, kết quả trên worktree:
  - `pnpm audit --audit-level high` exit 0 (chỉ còn picomatch đã ignore).
  - be typecheck xanh. be lint: 4 lỗi `prettier/prettier`, chỉ là format do prettier 3.9 (`backup-scripts.spec.ts`, `admin-recover.ts`, `mfa.service.ts`, `federation.int-spec.ts`).
  - be unit: 33 test trong 6 suite đỏ. `@nestjs/platform-fastify` 12.3.2 làm `fastify` đổi sang `light-my-request@6.8.0` (cookie@2, chỉ có ESM). Jest trên Node 22 không `require()` được ESM, nên mọi `app.inject()` hỏng. Override `'fastify>light-my-request': 6.6.0` ⇒ **1296/1296 xanh**. Runtime production không dùng `inject`; Node 22.23 tự `require(esm)` được.
  - be build OK (`dist/main.js`). fe-sso-test 269/269, typecheck xanh. e2e typecheck xanh.
  - **fe-admin hỏng khi có `@tanstack/react-start@1.169.4`/`react-router@1.170.46`**: 7 lỗi typecheck, 8 test hỏng cộng thêm nhiều suite không load được (`createServerFn(...).inputValidator is not a function`: API đổi tên thành `.validator`). Nguy hiểm nhất: `getResponseHeaders()` giờ trả **bản sao** (`toResponseHeadersSnapshot`/`new Headers(...)`), nên các dòng `getResponseHeaders().append("set-cookie", …)` (`src/features/auth/viewer.ts:13`, `src/server/admin-api/instance.ts:24`) và `.set("cache-control","no-store")` (`instance.ts:42-43`) sẽ **mất âm thầm**: cookie phiên làm mới không tới trình duyệt, còn bí mật client trả về thiếu `no-store`. Đây là một đợt migrate FE thật sự, không phải bump ⇒ hoãn.
  - #17 bỏ riêng 2 gói TanStack (giữ 1.168.60 / 1.170.41): fe-admin typecheck xanh, **1658/1658**, build OK.
- ESLint 10 (#12 + #10, trên nền #17): cài được. typescript-eslint 8.72.1, react-hooks 7.1.1, react-refresh 0.5.7, prettier plugin/config đều có peer `^10`. Rule mới trong `recommended` sinh 8 lỗi thật: `preserve-caught-error` ×5 ở be (`bootstrap.ts:138,460`, `mongo/mongo.service.ts:48`, `seed.ts:265`, `keys/vault-transit-key-provider.ts:424`) và ×1 ở fe-sso-test (`src/oidc/http.ts:22`); `no-useless-assignment` ở `fe-admin/src/server/session/store.ts:160` và `fe-sso-test/src/oidc/probe.ts:160`. Audit vẫn exit 0.
- TypeScript 7.0.2 (#11): `require('typescript')` chỉ export `version`/`versionMajorMinor`, không có compiler API (`exports["."] = ./lib/version.cjs`). Hậu quả: ts-jest báo 15/15 suite lỗi `Importer.typescript`; be lint hỏng; `tsc` báo `TS5102 Option 'baseUrl' has been removed` (be/tsconfig.json). Peer cũng không cho phép: typescript-eslint `<6.1.0`, ts-jest `<7`, openapi-typescript `^5.x`; Nest CLI/ts-node/ts-loader dùng compiler API.
- #2 (security, 2026-10-24): nodemailer 10.0.12→10.1.4 và happy-dom 21.0.1→21.0.4. Repo đã có nodemailer 10.1.7 (run 83 `b76b78f`, các GHSA của addressparser) và happy-dom 21.0.4 (run 66 `eb75eed`, GHSA-834v-8h66-3h79) ⇒ PR này đã bị thay thế.

## Kiến trúc đề xuất

Không đổi kiến trúc. Thêm một điều chỉnh cấu hình supply chain: bật `minimumReleaseAge: 20160` để D72 áp dụng máy móc cho cả bắc cầu (đúng AC "supply-chain policy của pnpm OK"). Ngoại lệ bảo mật phải được ghi rõ trong `minimumReleaseAgeExclude` theo **phiên bản chính xác**.

## Điểm mạnh

- Dependabot cooldown 14 ngày đã khớp D72: mọi bản đích đều đủ tuổi.
- CI `pnpm audit` fail-closed và Dockerfile `--frozen-lockfile` cho phép thực thi chính sách tuổi phát hành mà không cần thêm công cụ.

## Vấn đề (đã chốt cách xử lý; backend-dev phải làm đúng, nếu làm khác senior REJECT)

- [ ] Không bump `@tanstack/react-start`/`@tanstack/react-router` trong run này (D96.6, DEBT-694).
- [ ] Không thêm `{ cause: err }` máy móc khi sửa `preserve-caught-error`. Ở `mongo.service.ts:48` (message Mongo có thể chứa URI kèm credential, code đã chủ ý scrub), `seed.ts:265` (lỗi duplicate key 11000 chứa giá trị key/PII) và `vault-transit-key-provider.ts:424` (ErrnoException chứa đường dẫn token sink, JSDoc ghi "never carry the path"), cause bị bỏ **có chủ ý**. Gắn cause ở đây ⇒ nó lọt vào log pino/CLI (CWE-209/532). Dùng `// eslint-disable-next-line preserve-caught-error -- <lý do>` (D96.8).
- [ ] Không thêm vào `minimumReleaseAgeExclude` bản nào do Lot A/C kéo vào. Nếu pnpm báo bản mới < 14 ngày ⇒ hạ phiên bản, không exclude (D96.5).
- [ ] Override `light-my-request` phải ghi phạm vi `fastify>` (không global) và kèm comment lý do (D96.7).

## Đề xuất (không bắt buộc)

- Chuyển sang TypeScript 6.0 (bước đệm trước TS 7: bỏ `baseUrl`, `moduleResolution` tường minh) — gộp vào DEBT-695.
- Khi bỏ được `fastify>light-my-request` (Node ≥ 24.9 hoặc Jest hỗ trợ require(esm) trên Node 22) thì dọn luôn shim `content-disposition` (DEBT-696).
