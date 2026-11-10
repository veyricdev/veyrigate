# Test Report — 2026-11-10 (run 81, sweep-mixed)

## Kết quả: PASS

- Spec mới `be/test/run81-tester.int-spec.ts`: 46/46.
- Int full: 1677/1677 (62 suite).
- Unit be: 806/806.
- fe-admin: 1589/1589, typecheck 0.
- E2E: 38/38.
- X3: 42/42.
- Không có 🔴. Mở 2 💭: DEBT-537, DEBT-538.

## Lệnh đã chạy + output thực tế

| Lệnh | Output |
|---|---|
| `pnpm -C be test:int -- run81-tester` | `Tests: 46 passed, 46 total` |
| `pnpm -C be typecheck` | `tsc --noEmit`, 0 lỗi |
| `npx eslint test/run81-tester.int-spec.ts` | 0 lỗi |
| `pnpm -C be test` | `Test Suites: 43 passed` / `Tests: 806 passed, 806 total` |
| `pnpm -C be test:int` (full) | `Test Suites: 62 passed, 62 total` / `Tests: 1677 passed, 1677 total` (798 s); 1631 cũ + 46 mới |
| `pnpm -C fe-admin test` | `Test Files 67 passed (67)` / `Tests 1589 passed (1589)` |
| `pnpm -C fe-admin typecheck` | exit 0 |
| `pnpm -C e2e e2e` | `38 passed (5.3m)` |
| `pnpm -C e2e e2e:x3` | `42 passed (9.4m)` |

- Kiểm X3: `x3-matrix.json` có 37 lần `__Host-idp_authz`, 0 `eyJ`; stdout X3 cũng 0 `eyJ`.
- DB `vg-int-*`: 4 trước, 4 sau (sau int full, sau E2E/X3).
- Port 4000/5173/3000:
  - Lúc bắt đầu, `[::1]:5173` đang LISTEN bởi pid 22628 (tiến trình của người dùng, không đụng tới).
  - Sau int full, cả 3 port đều trống, nên tôi chạy E2E rồi X3 tuần tự.

## Test FAIL

Không có.

## Mutation

Cách làm: backup bytes → mutate → chạy spec → khôi phục bytes. sha256 khớp lại 12/12 file src. Script ở scratchpad (`mut.py`), không nằm trong repo.

| # | Mutation | Ca đỏ |
|---|---|---|
| M1 | Lua bỏ so `bindingHash` | C1, C3, C7, C8 |
| M2 | Controller đọc thêm tên trần `idp_authz` | C8 |
| M3 | Xoay binding mỗi request | C2, C4, C6 |
| M4 | DEL trước khi so | C1, C3, C7, C8 |
| M5 | Log giá trị binding (Nest Logger → pino) | C7 |
| M6 | Script login không DEL | C5 |
| M7 | `decodeURIComponent(cookie)` (500 khi gặp `%`) | C3, C3b |
| M8 | Chấp nhận cookie = hash đã lưu | C1 |
| M9 | Bỏ filter `expectedScopes` | 7 ca mismatch, exact/LWW, ma trận vai trò, N=12 |
| M10 | 409 mang scopes đang lưu | 7 ca mismatch, exact, N=12 |
| M11 | `expectedScopes` bỏ `@Matches(SCOPE_TOKEN)` | 9 ca whitespace/Unicode/empty |
| M12 | `[]` không khớp field vắng | ca `[]` |
| M13 | PATCH bỏ `@SuperAdminOnly` + `assertSuperAdmin` | ma trận vai trò |
| M14 | Ghi audit khi conflict | 7 ca mismatch, exact, N=12 |
| M15 | 2 nhánh format echo lại `${resource}` | 8/8 ca T2 |
| M16 | Check-then-write (không nguyên tử) | N=12 |
| M17 | `expectedScopes` chỉ còn `@IfPresent` | 18/18 ca 400 |

Ghi chú về M5 và M9:
- **M5, lần 1, không đỏ.** Bản mutant đầu ghi qua `req.log` của Fastify, nhưng logger đó tắt chứ không phải sink pino, nên đó là mutant không có tác dụng. Đổi sang Nest `Logger` thì C7 đỏ.
- **M9, lần 1, không hợp lệ.** Biến `expected` thừa làm ts-jest không biên dịch. Đổi thành `...(expected && {})` thì đỏ như bảng.

## Coverage acceptance criteria

T1 DEBT-413:
- [x] AC1 (cookie attrs, không xoay): C4, C6, C8 + dev ca 1/1s
- [x] AC2: C1 (đổi code qua `/token`, `sub` = nạn nhân)
- [x] AC3 (thiếu/sai cookie ⇒ 400, context còn): C1, C3, C8
- [x] AC5 (nhiều tab): C2, C4
- [x] AC6 (replay/đồng thời): C5 + dev ca 6
- [x] AC4, AC7, AC8, AC9: dev test xanh trong int full (authorize, federation, redis-down)

T2 DEBT-532:
- [x] 8 identifier thù địch, không echo ở body và log pino, 0 document, 0 audit

T3 DEBT-323:
- [x] (1), (4): exact/LWW
- [x] (2): 7 kiểu mismatch, body đúng từng byte, `no-store`, 0 audit, DB giữ nguyên
- [x] (3): `[]` với mảng rỗng và field vắng
- [x] (6): N=12 song song ⇒ đúng 1 lần 200, 11 lần 409, 1 audit
- [x] (7): 18 input sai
- [x] (5): 404 (trong ma trận vai trò)
- [x] FE (gửi `expectedScopes`, thông điệp conflict): fe-admin 1589 + E2E bước 5

T4 DEBT-527:
- [x] E2E 38/38 (gồm `fe-admin-audit`)

## Coverage security invariants / risk matrix

**Identity**
- [x] Kẻ tấn công là member hợp lệ của tenant nạn nhân, có consent đầy đủ (C1).
- [x] Cookie không đổi theo tenant: một trình duyệt dùng chung giá trị cho 2 tenant (C2).

**Credential**
- [x] Absent, rỗng, sai, của trình duyệt khác (C1).
- [x] Hash-as-cookie (C1).
- [x] Đổi hoa, cắt 1 ký tự (C1).
- [x] Malformed: `%`, `%zz`, `%00`, quote, HTML (C3, C3b).
- [x] Quá dài: 4096 và 4043 ký tự (C3, C3b).
- [x] Trùng tên cookie, giá trị lạ đứng trước (C3): bị từ chối.
- [x] Cookie bị tossing trong Secure mode (C8).

**State**
- [x] Replay sau khi thành công (C5).
- [x] Thử sai nhiều lần: không đốt context, không kéo dài PTTL (C1).
- [x] Resume không phiên ⇒ context mới gắn cùng hash (C6).
- [x] 12 PATCH đồng thời (T3).

**Authorization**
- [x] Ma trận: tenant_admin fresh/stale × resource có/không × expected đúng/sai.
  - Luôn nhận đúng một body 403 `forbidden`, không lộ qua 409 hay 404.
  - super_admin stale ⇒ `step_up_required`; thiếu scope ⇒ `insufficient_scope`.

**Input**
- [x] T3: 18 dạng sai, gồm toán tử Mongo `{ $exists: true }` và `[{ $ne: 1 }]` (đều 400).
- [x] T2: 8 identifier thù địch.

**Exposure**
- [x] Giá trị binding và sha256 của nó không xuất hiện trong pino, audit, `Location`, body (C7).
- [x] 409 không lộ scopes đang lưu, `resourceId` hay scopes mới.
- [x] T2 không echo ở body và log.

**Dependency**
- [x] Redis down ở resume ⇒ 503: hàng resume trong `redis-down.int-spec` vẫn xanh trong int full. Tôi không thêm ca riêng.

## Quan sát (không mở debt)

- Request `/authorize` mới dùng lại **bất kỳ** giá trị `idp_authz` nào trình duyệt gửi, ví dụ `a` hay `%00` (giải mã thành NUL). Đã đo bằng probe.
- Kiểm định dạng cũng không chặn được fixation, vì kẻ tấn công có thể đặt sẵn một giá trị đúng định dạng.
- Prod dùng `__Host-`, nên chặn được tossing từ subdomain. Dev không Secure đã được chấp nhận trong fold.
- Kết luận: thiết kế chấp nhận được, nên không mở debt.

## Debt mới

- **DEBT-537 💭 [BE]**: `expectedScopes: []` không khớp `scopes: null`.
  - Một resource lưu `scopes: null` thì `GET` trả `[]`, nhưng PATCH với `expectedScopes: []` lần nào cũng 409, nên fe-admin không lưu được.
  - Chỉ xảy ra khi ghi thô vào Mongo.
- **DEBT-538 💭 [BE/FE]**: `SCOPE_TOKEN = /^\S+$/` nhận ký tự Cf (ZWSP, bidi) trong scopes và `expectedScopes`. Cùng lớp với DEBT-329.
