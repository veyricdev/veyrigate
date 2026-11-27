# Tech Lead Review — 2026-11-27 (run 100 deps4)

## Kết luận: PASS

Áp T1 (#25) toàn bộ. T2 (#26) đóng PR và **gỡ** `@fastify/formbody` khỏi `be` vì be không dùng gói này. T3 (#27) đóng PR, thêm ignore major và bump `@types/node` trong major 22 (22.20.5). T4 (DEBT-714) **hoãn**: Playwright 1.65.1 chưa đủ 14 ngày tại thời điểm review. Quyết định chi tiết D100.1–D100.8 ở cuối `tasks.md`.

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc. Riêng `@fastify/formbody`: be là dependency chết. Body form do `@nestjs/platform-fastify` tự parse (`registerUrlencodedContentParser`, dùng `fast-querystring`). Commit `f62426b` (run auth UI) đã bỏ lệnh đăng ký formbody vì đăng ký trùng làm app không boot, nhưng quên gỡ gói khỏi `package.json`. Gỡ gói thì bớt một dependency runtime và Dependabot sẽ tự đóng #26.

## Bằng chứng (đo 2026-11-27 ~02:10Z)

### Ngày phát hành (`pnpm view <pkg> time`, mốc 14 ngày = 2026-11-13T02:07Z)

| Gói | Bản | Phát hành (UTC) | ≥ 14 ngày |
|---|---|---|---|
| @nestjs/common/core/platform-fastify/testing | 12.5.0 | 2026-11-12 13:13–13:14 | có (bản trẻ nhất #25) |
| @testing-library/user-event | 14.6.10 | 2026-11-12 04:41 | có |
| prettier | 3.10.1 | 2026-11-12 07:06 | có |
| lucide-react | 1.72.0 | 2026-11-11 06:15 | có |
| vite | 8.3.8 | 2026-11-11 02:49 | có |
| nodemailer | 10.5.0 | 2026-11-10 08:58 | có |
| jose | 6.2.17 (6.2.16) | 2026-11-09 18:41 (11-08) | có |
| mongoose | 9.12.1 | 2026-11-09 21:01 | có |
| typescript-eslint | 8.72.2 | 2026-11-09 17:08 | có |
| @vitejs/plugin-react | 6.3.0 | 2026-11-09 06:12 | có |
| @fastify/formbody | 9.0.1 | 2026-10-08 | có (nhưng không dùng, xem T2) |
| @types/node | 26.6.6 / **22.20.5** | 2026-10-28 / **2026-10-01** | có / có (22.20.6–7 ngày 11-25: chưa đủ) |
| @playwright/test / playwright / **playwright-core** | 1.65.1 | 2026-11-13 21:12 / 21:15 / **21:36:08** | **chưa** (đủ từ 2026-11-27T21:36:08Z) |

### Thử trên worktree (develop `392690c` + lockfile #25), đã xoá và `git worktree prune`

- `pnpm install --frozen-lockfile` với lockfile #25 cho kết quả `✓ Lockfile passes supply-chain policies (933 entries)`, exit 0.
- typecheck ×4 exit 0. lint ×3 exit 0. `prettier --check src/**/*.ts test/**/*.ts` (be, prettier 3.10.1) cho `All matched files use Prettier code style!`, nghĩa là 3.10 không đổi format file nào.
- build be, fe-admin, fe-sso-test đều exit 0. Unit be **1361/1361**, fe-admin **1669/1669**, fe-sso-test **269/269** (không đổi).
- Gỡ `@fastify/formbody` rồi `pnpm install`: lockfile chỉ mất importer `@fastify/formbody 8.0.2`, gói `@fastify/formbody@8.0.2` và `fastify-plugin@5.1.0`. `formbody@9.0.1` vẫn còn vì là dependency khai báo của platform-fastify (code adapter không import nó). be typecheck exit 0.
- `@types/node` 22.10.5 → 22.20.5 ở 4 package rồi `pnpm install`: lockfile chỉ đổi chuỗi peer `(@types/node@…)`, thêm `undici-types@6.21.0` (phát hành 2024-11-13). Sau đó frozen pass policies, typecheck ×4 0 lỗi, lint exit 0, be unit 1361/1361, be build exit 0.

### Nest 12.5 — thay đổi hành vi có liên quan (diff `fastify-adapter.js` 12.4.0 → 12.5.0, 531 dòng)

1. **Body form có key `__proto__` bị chặn**: parser urlencoded mặc định trả `BadRequestException('Object contains forbidden prototype property')` theo `onProtoPoisoning` (mặc định `error`). Probe Nest app tối thiểu với `createFastifyAdapter` + `OAuthExceptionFilter` + `parseForm` thật từ `be/dist`:

   | Body | 12.4.0 | 12.5.0 |
   |---|---|---|
   | `a=1&b=2` | 201 | 201 |
   | `a=1&__proto__=x` | 201, key `__proto__` lọt vào Map (bị bỏ qua) | **400** `{"error":"invalid_request","error_description":"Object contains forbidden prototype property"}` |
   | `__proto__[x]=1`, `constructor=1` | 201 (key thường) | 201 (không đổi) |
   | `a=1&a=2` | mảng ⇒ `parseForm` ném `FormParseError` (endpoint thật map 400) | không đổi |
   | body 1.1 MB | 413 `invalid_request` (bodyLimit mặc định 1 MiB) | không đổi |

   Hành vi mới chặt hơn và không có client hợp lệ nào gửi `__proto__`, nên chấp nhận. Hai điểm cần khoá bằng test âm (D100.3): request bị từ chối phải là 4xx, không phải 5xx; và route HTML (login/consent/MFA) không trả stack hay echo input.
2. Middleware path matching (middie) giờ khớp đường dẫn theo cách router decode (ký tự reserved, case folding), thêm method WebDAV cho `all()`, stream object-mode và `onResponseClose`, `Content-Length` bị bỏ khi có `Transfer-Encoding`, body Error kèm status lỗi trả body chuẩn. Không cần sửa code. int FULL, E2E và pentest (`HYG-ACCESSLOG`, header, CSRF, traversal) phủ phần này.

### jose 6.2.15 → 6.2.17 (diff `dist/webapi`)

Chỉ đổi các đường verify/decrypt: validate options sớm hơn (`prepareVerify`/`prepareDecrypt` ra ngoài try, `maxPBES2Count`/`maxDecompressedLength` kiểm trước khi giải mã), `maxTokenAge` âm ném `TypeError`, đổi chuỗi User-Agent JWKS. Không đổi sign, import/export key, `generateKeyPair`, thumbprint. Code không dùng `maxTokenAge` âm (`token-verifier.ts:69` không pin). Theo tiền lệ D98.13 và yêu cầu "jose đổi ⇒ vault/drill", vẫn bắt chạy vault 32 và drill rotate local (chi phí thấp).

### Các gói khác

mongoose 9.12.1 và nodemailer 10.5.0 là patch/minor, được phủ bởi int FULL (Mongo 7 rs0, Mailpit). Lint, vite 8.3.8 và plugin-react 6.3.0 được phủ bởi build, unit và check:bundle.

## Điểm mạnh

- Lockfile Dependabot #25 qua chính sách supply-chain mà không cần exclude. Toàn bộ override/pin giữ nguyên (router 1.170.42, Start 1.168.61, `fastify>light-my-request` 6.6.0, seroval, redocly, zod, minimatch/glob).
- T2 giải quyết bằng cách **xoá** dependency, không phải nâng major một gói không dùng.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có. Các điều kiện gate nằm ở D100.7.

## Đề xuất (không bắt buộc)

- Không thêm debt mới. DEBT-714 vẫn mở, cập nhật ghi chú theo D100.5.
