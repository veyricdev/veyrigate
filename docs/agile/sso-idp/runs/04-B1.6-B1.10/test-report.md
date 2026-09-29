# Test Report — 2026-09-29 (B1.6–B1.10)

## Kết quả: **PASS** (45/45 test xanh · 0 fail · 0 pending)

Chạy lệnh thật, đọc EXIT code. Môi trường: Node v22.22.3 · container riêng `vg-test-mongo@27117`, `vg-test-redis@6479` (27017/6379 bị `aegate-*` chiếm) · `veyrigate-mailpit-1@1025/8025`.

### Thay đổi hạ tầng test (người dùng chọn phương án 1)
NestJS 12 chỉ phát hành ESM → Jest CJS không nạp được `@nestjs/common`. Đã chuyển Jest sang **ESM gốc**:
- `jest.config.js`: `extensionsToTreatAsEsm: ['.ts']`, ts-jest `useESM` + `module: esnext`; bỏ `transformIgnorePatterns` / transform `.js`.
- `package.json`: `test`, `test:int` chạy `node --experimental-vm-modules node_modules/jest/bin/jest.js`.
- Thêm devDep `@jest/globals@30.0.5`; spec dùng `jest.fn` import từ `@jest/globals` (typed generic).
- `sync-indexes.ts`: guard `typeof require !== 'undefined'` (không có `require` khi import dưới ESM; build CJS vẫn chạy CLI).
- `rate-limit.int-spec.ts`: bỏ `redis.quit()` thừa (`RedisService.onApplicationShutdown` đã quit → "Connection is closed").
- `indexes.int-spec.ts`: `beforeAll` timeout 30s (tạo 12 collection + index vượt 5s mặc định → flaky).

## Bảng case → kết quả

| # | Task | Case | Lệnh | Kết quả |
|---|---|---|---|---|
| 1 | chung | typecheck / lint / build | `tsc --noEmit` · `eslint src test` · `pnpm build` | ✅ 0/0/0 |
| 2 | B1.6 | 12 model có đúng index §10 (+TTL `expireAfterSeconds:0`) | `pnpm test:int` (indexes) | ✅ 12/12 |
| 3 | B1.6 | sync idempotent · unique trùng → E11000 | idem | ✅ 2/2 |
| 4 | B1.6 | CLI `db:sync-indexes` trên build CJS | `MONGO_URI=…27117 pnpm db:sync-indexes` | ✅ 12 model synced, EXIT=0 |
| 5 | B1.7 | key bí mật không compile (`@ts-expect-error`) + strip runtime | `pnpm test` (audit) | ✅ |
| 6 | B1.7 | ghi lỗi → throw (INV-25) · alert chỉ cho action alert, listener lỗi không phá `record()` | idem | ✅ 3/3 |
| 7 | B1.8 | đổi IP không vượt limit theo account (email không phân biệt hoa thường) → 429 + `Retry-After` | `pnpm test:int` (rate-limit) | ✅ |
| 8 | B1.8 | chặn theo IP · theo device · key không PII thô + có TTL · mặc định `RATE_LIMIT_MAX` + atomic khi đồng thời | idem | ✅ 4/4 |
| 9 | B1.9 | `/jwks.json` không có `d/p/q/dp/dq/qi` · state file không có private · PEM PKCS8 | `pnpm test` (keys) | ✅ 2/2 |
| 10 | B1.9 | ký RS256 kid/iss/aud/exp/jti + verify · từ chối sai aud/iss, hết hạn, **thiếu exp** (🔴 #1 senior), non-RS256 | idem | ✅ 2/2 |
| 11 | B1.9 | rotate thường: token cũ verify, JWKS giữ key cũ, audit · key cũ rời JWKS sau retention · rotate khẩn: token cũ FAIL ngay | idem | ✅ 3/3 |
| 12 | B1.10 | template chỉ link đã escape + thời hạn · SMTP không greet → lỗi, không treo | `pnpm test` (mailer) | ✅ 3/3 |
| 13 | B1.10 | email tới Mailpit, nội dung chỉ có link | `pnpm test:int` (mailer) | ✅ |

## Output thực tế

```
$ pnpm test
Test Suites: 5 passed, 5 total
Tests:       25 passed, 25 total          EXIT=0

$ pnpm test:int      (chạy 3 lần liên tiếp)
RUN1 INT=0 Tests: 20 passed, 20 total
RUN2 INT=0 Tests: 20 passed, 20 total
RUN3 INT=0 Tests: 20 passed, 20 total

$ npx tsc --noEmit → 0 · npx eslint src test → 0 · pnpm build → 0

$ pnpm db:sync-indexes   (MONGO_URI=mongodb://localhost:27117/vg_cli_check)
User … AuditLog: synced (12 model)   CLI=0
```

## Ghi chú
- ts-jest 29.2.5 cảnh báo chưa test với Jest 30 (đã có từ run 03, không ảnh hưởng kết quả).
- `--experimental-vm-modules` in `ExperimentalWarning` — vô hại.
- Giả định A6 (`jose` 5.x vì be/ CJS + ts-jest) vẫn đúng cho build; test nay chạy ESM.
