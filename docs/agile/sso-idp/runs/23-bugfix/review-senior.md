# Senior Review — 2026-10-14 (Lượt 2)
## Kết luận: PASS   (🔴 lượt 1 đã đóng; còn 🟡 → DEBT-095/096/097) → **tester**

## Tổng quan (ấn tượng chung + điểm tốt)
- 🔴 lượt 1 sửa đúng chỗ, tối thiểu: `serializeRequest` trả `id: req.id`, `serializeResponse` giữ nguyên allow-list.
  Có test ở 2 tầng (unit serializer + wiring `pino-http` thật); wiring test giờ **parse JSON** dòng `request completed`
  và assert theo cấu trúc (`req.id`, `statusCode===302`, `location` đã cắt query, `Object.keys(res.headers)===['location']`).
  Đây là cách khóa allow-list đúng: lỡ thêm header nào vào serializer là RED.
- 🟡2 preflight đọc `TEST_MONGO_URI`/`TEST_REDIS_URL` (`new URL`, URI hỏng ⇒ fallback); probe có `unref` + guard `settled`.
- 🟡1 comment `e2e/config/env.ts` mô tả đúng hành vi `loadEnvFile`. 💭 poll thay `setTimeout(50)` đã làm; docstring `serializeResponse` rút gọn; import `pino-http` tĩnh.

**Senior tự kiểm chứng (không sửa code; khôi phục byte-identical, sha256 `749cb9e1…406d` trước = sau):**
- Mutation bỏ `id` khỏi `serializeRequest` ⇒ **RED 2/8** (unit `req-42` + wiring `REQ-CORRELATE-1` nhận `undefined`); khôi phục ⇒ 8/8 GREEN.
- `pnpm -C be test` 198/198 (18 suite); `pnpm -C be test:int` 482/482 (23 suite) **exit 0**; typecheck be + e2e = 0; eslint `src/common/logger` + `test/int-preflight.mjs` = 0.
- `--forceExit` **không che lỗi**: jest `--forceExit` với test đang RED ⇒ exit **1**; `TEST_MONGO_URI=mongodb://localhost:9/x pnpm test:int` ⇒ globalSetup ném `vg-test-mongo (localhost:9)` + `docker start …`, exit **1**.
- Probe Fastify 5.12.5 + `pino-http` (cùng `genReqId` của dự án, gửi `x-request-id: CLIENT-1`): Fastify `request.id` = `req-1`,
  `request.raw.id` (pino) = `CLIENT-1` ⇒ xem 🟡1.

## 🔴 Blocker
- [x] **[BE] Access log mất request-id** (lượt 1) — đã sửa `logger.module.ts:44-51`, test 2 tầng, mutation RED. Đóng.

## Security invariants / trust boundaries đã kiểm
| Invariant | Kết quả |
|---|---|
| `code`/`state`/`set-cookie` không vào access log | ✅ giữ nguyên lượt 1; wiring test khóa `res.headers` đúng `['location']` |
| Request-id có mặt ở mọi dòng HTTP log | ✅ `req.id` (id pino-http), test 2 tầng |
| Log injection qua `x-request-id` | ✅ pino JSON-escape chuỗi ⇒ không giả được dòng log; Node từ chối CR/LF trong header vào ⇒ echo lại header không gây response-splitting |
| Giả mạo / độ dài `x-request-id` | 🟡 `genReqId` (`logger.module.ts:83-91`) **không validate**: nhận nguyên giá trị client (tới giới hạn header ~16 KB), echo ra response, ghi vào mọi dòng log; `''` lọt qua `??` ⇒ id rỗng; client có thể đặt id trùng request khác để làm nhiễu điều tra. Audit **không** dùng giá trị này (xem 🟡1) nên không giả được bản ghi audit ⇒ không 🔴 |
| `--forceExit` không biến fail thành pass | ✅ thực nghiệm: test fail ⇒ 1, preflight fail ⇒ 1 |
| Preflight không ảnh hưởng unit / không đụng dữ liệu | ✅ chỉ TCP-connect; chỉ flag trong `test:int` |

## 🟡 Nên sửa
1. **[BE] "Correlatable with audit" sai — có 2 request id khác nhau** — `logger.module.ts:11-12,49` vs
   `authorize.controller.ts:70,109`, `token.controller.ts:184,228,278` (`requestId: req.id`).
   Vì sao: `req.id` trong controller là **Fastify** `request.id` (counter mặc định `req-1`, `req-2`… — reset mỗi lần khởi
   động, trùng giữa các instance), còn access log ghi `req.raw.id` do `genReqId` của pino-http sinh. Probe: `req-1` ≠ `CLIENT-1`.
   Không phải hồi quy của run này (trước đó log cũng chỉ có id pino qua header), nhưng docstring mới hứa một bảo đảm không
   có, và id trong audit không duy nhất.
   Đề xuất: một nguồn id — cấu hình `FastifyAdapter({ genReqId, requestIdHeader: false })` dùng chung hàm sinh id, rồi
   pino `genReqId: (req) => req.id` (hoặc controller đọc `req.raw.id`); thêm test int: `audit.requestId` === header
   `x-request-id` của response. Trước khi sửa, có thể đổi docstring thành "pino request id on every HTTP log line".
2. **[BE] Validate `x-request-id` đầu vào** — `logger.module.ts:87-88`. Đề xuất: chỉ nhận `/^[A-Za-z0-9._:-]{1,64}$/`,
   ngược lại `randomUUID()` (xử lý luôn `''`). Làm cùng 🟡1 vì cùng hàm.
3. **[BE] `--forceExit` là băng dính tạm** — `be/package.json` `test:int`. Chấp nhận được khi DEBT-054 mở (exit code vẫn
   trung thực), nhưng nó giấu luôn **mọi leak handle mới** từ nay. Đề xuất: gỡ `--forceExit` là điều kiện đóng DEBT-054;
   khi xử lý chạy `--detectOpenHandles` một lần để định vị.

## 💭 Nit
- `logger.module.spec.ts:10,29-35` lặp `id: undefined` ở các case không liên quan tới id — `toMatchObject({ method, url })` đỡ nhiễu.
- `int-preflight.mjs:30` `Number(url.port) || defaultPort`: URI override không ghi port (vd. `mongodb://host/db`) ⇒ probe 27117 thay vì 27017 mặc định của driver. Hiếm gặp.

## ✂️ Ponytail
- e2e/config/env.ts:L22,L72: shrink: `resolve(dirname(fileURLToPath(import.meta.url)), "..")` vẫn lặp 2 lần. Một `const E2E_DIR`.
- e2e/config/env.ts:L10-16: shrink: block comment credential 7 dòng trùng README + message throw. Còn 2 dòng.
- be/test/int-preflight.mjs:L5-16,L20-24: shrink: 2 docstring (17 dòng) cho script ~40 dòng. Giữ 3 dòng (vì sao fail-fast; chỉ gắn qua `test:int`).
net: -18 lines possible.

## Chuyển tiếp
- PASS → **tester**: chạy lại unit/int/E2E; grep log E2E không có `code=`/`state=`/`SECRET`/`set-cookie` (fold case 4); xác nhận dòng `request completed` có `req.id`.
- 🟡1–3 + Ponytail → backlog DEBT-095/096/097. File ngoài phạm vi (`.vscode/mcp.json`, `.mcp.json`, `.github/agents/*`) không review; đừng commit chung run này.
