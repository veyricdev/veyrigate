# Senior Review (BE) — 2026-11-02

Phạm vi: `git diff -- be/` (run 61 T1 DEBT-448, T4 DEBT-206, T5 DEBT-096). Bỏ qua `.vscode/mcp.json`, `.mcp.json`.
Đã chạy (read-only): `pnpm -C be typecheck` 0, `pnpm -C be lint` 0, `pnpm -C be test` 39 suite / 630 test xanh. KHÔNG chạy `test:int`/E2E. Đối chiếu số đo trong scratchpad `timing-*.tsv` (hook `beforeAll` theo file).

## Kết luận: PASS

## Tổng quan

Sửa đúng nguyên nhân gốc mà fold chỉ ra (app mồ côi khi `beforeAll` hết giờ, `bootFullApp` không tự dọn khi ném). Không đổi assertion nào, không retry, không nâng `--testTimeout` toàn cục, không giảm số vòng race; mọi timeout nâng riêng đều có số đo kèm chú thích. Thứ tự dọn trong `bootFullApp` (đóng app → drop DB bằng kết nối mới → xoá keyDir → ném lại lỗi gốc) là đúng thứ tự an toàn. Lock-lost fail-closed gọn và không chạm đường chạy bình thường. Có mutation + drill cho cả T1 và T4.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

Diff không chạm trust boundary của sản phẩm (chỉ hạ tầng test). Đã kiểm:
- **Assertion bảo mật**: 28 spec chỉ đổi hook/timeout, không đổi `expect` nào (`git diff` không có dòng `expect` bị sửa/xoá).
- **Exposure**: warn/lỗi mới ở `int-preflight.mjs`/`int-teardown.mjs` chỉ in `LOCK_KEY`, không in token lock (`hostname:pid:uuid`). Chú thích số đo không chứa giá trị nhạy cảm. Env test (`CSRF_SECRET` giả…) có từ trước, không đổi.
- **Fail-closed (T4)**: heartbeat trả 0 ⇒ `lost`; release trả 0 ⇒ warn; một trong hai ⇒ `globalTeardown` ném ⇒ exit 1. Lỗi Redis ở teardown vẫn chỉ warn (`released` = `undefined` ⇒ không ném), đúng fold. Vẫn chỉ chạm `vg:int-lock`, so sánh giá trị.
- **Lock-lost không rò sang đường bình thường**: `lost` chỉ bật khi `EXTEND_LUA` trả đúng `0` (key không còn token của mình); đường bình thường trả 1; lỗi kết nối đi nhánh reject (chỉ warn). `released === 0` chỉ khi key bị thay/hết hạn. Không có false positive trên lượt sạch (khớp bằng chứng "không drill exit 0").
- **Không nuốt lỗi gốc**: `bootFullApp` ném lại đúng `err` gốc; drop DB lỗi bị `.catch` (best effort). `afterAll` chờ `setup?.catch(() => undefined)` không che lỗi: lỗi setup đã được Jest gắn vào `beforeAll` (mọi test trong describe đỏ với lỗi đó). Ngoại lệ nhỏ: khi `beforeAll` đã báo *timeout* rồi boot mới reject, lý do thật bị nuốt (xem 🟡 3).
- **Race với index build**: đóng app trước khi drop là đúng — sau `ctx.close()` không còn lệnh client mới; `dropDatabase` phía server huỷ index build đang chạy. Đường thành công (`close()`) vẫn drop trước rồi đóng, an toàn vì `syncAllIndexes` đã được await.
- **Gỡ `--forceExit`**: an toàn có điều kiện, đã đạt điều kiện fold (3 lượt full tự thoát 0–1 s sau tổng kết, `--detectOpenHandles` 0 handle). `test:vault`/`test:sentinel` giữ `--forceExit` như fold. Rủi ro còn lại: handle mở mới ở spec tương lai sẽ làm treo thay vì bị che — đó chính là mục đích của DEBT-096.

## Trả lời 2 quyết định backend-dev hỏi

1. **Hạ 90 s (log-capture 120 s) xuống 70 s: CHẤP NHẬN.** Số đo dưới tải 28 luồng: hook full-app lớn nhất 22,8 s (`b74-tester` #5, `log-capture` 22,2–22,8 s); các lượt full dưới tải sau sửa, hook full-app lớn nhất 25,8 s (`run56-tester`) ⇒ biên ≥ 2,7×. 90/120 s cũ là số tuỳ ý; fold yêu cầu MỘT hằng số từ số đo. Biên sát đã có DEBT-455 theo dõi.
2. **Áp mẫu cho 15 hook tự dựng thay vì 4: HỢP LÝ về chức năng** — fold mục 3 cho phép "khi bảng đo cho thấy hook đó cần", và số đo cho thấy cần: `seed-e2e-admin` 31,8 s với timeout mặc định 20 s, `indexes` 26–30 s / 30 s, `seed-dev` 20–23 s / 30 s, `authentication` 19 s / 30 s. Không phải over-engineering về hành vi. Nhưng cách triển khai có 2 khuyết điểm nhỏ (🟡 1 và 🟡 4).

## 🟡 Nên sửa

1. 🟡 **Hiệu năng: import cả AppModule chỉ để lấy một hằng số** (DEBT-461)
   `indexes.int-spec.ts:3`, `consent.int-spec.ts:6`, `clients.int-spec.ts:21`, `seed-risk.int-spec.ts:9`, `seed.int-spec.ts:57`, `seed-e2e-admin.int-spec.ts:12`, … (14 file mới import `./full-app`).
   Vì sao: `full-app.ts` import `AppModule`, `configureApp`, fastify adapter, pino… ⇒ suite nhẹ (chỉ mongoose) giờ phải transform + nạp toàn bộ đồ thị module app (ESM, ts-jest, registry riêng mỗi file). Chính backend-dev ghi "chi phí transform nằm ở import" — thay đổi này cộng thêm đúng loại chi phí đó vào lượt đang chậm vì tải.
   Đề xuất: chuyển hằng số sang `be/test/int-timeouts.ts` (không import gì), `full-app.ts` re-export; các suite tự dựng import từ file nhẹ. Cân nhắc đổi tên chung hơn (vd. `INT_SETUP_TIMEOUT_MS`) vì nay dùng cho cả hook không boot full-app.

2. 🟡 **`closeFullApp` chỉ chờ boot, không chờ phần seed còn lại của `beforeAll`** (DEBT-462)
   `full-app.ts:74` + mọi `beforeAll` full-app (vd. `log-capture.int-spec.ts:79–250`, `security-headers.int-spec.ts:66–97`).
   Vì sao: nếu hook hết giờ khi đang seed (boot đã xong), `afterAll` đóng ngay ⇒ `close()` drop DB trong khi thân `beforeAll` vẫn chạy nền và có thể ghi tiếp ⇒ DB `vg-int-*` mồ côi (cùng họ DEBT-454). Đúng nguyên văn fold nên không chặn, nhưng là lỗ hổng còn lại của chính DEBT-448; 15 suite tự dựng thì đã chờ cả hook.
   Đề xuất: dùng một mẫu cho cả 28 hook — `beforeAll(() => (setup = boot()), T)` với `boot` gán `full` sớm; `afterAll`: `await setup?.catch(() => undefined); await full?.close()` (lúc này `closeFullApp` có thể bỏ). Hoặc `closeFullApp(setup.then(() => full))` kèm xử lý reject.

3. 🟡 **Lý do thật của boot muộn bị nuốt khi `beforeAll` đã timeout** (DEBT-463, gộp với 4)
   `full-app.ts:75` (`pending?.catch(() => undefined)`) và 15 chỗ `await setup?.catch(() => undefined)`.
   Vì sao: Jest chỉ báo "Exceeded timeout of 70000 ms"; nếu sau đó boot reject (Mongo không chọn được server, index lỗi), lỗi thật bị bỏ đi ⇒ khó chẩn đoán đúng lúc máy chậm. Chú thích "reported by beforeAll" chỉ đúng khi reject xảy ra trước timeout.
   Đề xuất: `.catch((e) => console.warn('[int] setup failed after its hook:', e?.message))` — một dòng, không đổi kết quả test.

4. 🟡 **Hai kiểu viết cho cùng một mẫu, guard không nhất quán** (DEBT-463)
   `seed.int-spec.ts:92`, `seed-risk.int-spec.ts:45`, `indexes.int-spec.ts:62` dùng IIFE inline + `if (!connection) return`; 12 file còn lại dùng `const boot = async …` và KHÔNG guard ⇒ khi setup hỏng sớm, `afterAll` ném thêm `TypeError: Cannot read properties of undefined` (nhiễu, có từ trước). Chú thích 2–3 dòng lặp lại 15 lần.
   Đề xuất: chọn một kiểu (`const boot` dễ đọc hơn), thêm optional chaining/guard ở `afterAll`, rút chú thích về một dòng trỏ tới JSDoc của hằng số.

## 💭 Nit

- `full-app.ts:91` — `await rm(keyDir, …)` trong `catch` không có `.catch`: nếu `rm` ném (EBUSY trên Windows), nó che `err` gốc. Thêm `.catch(() => undefined)` cho đồng nhất với hai bước trên.
- `full-app.ts` — nếu `builder.compile()` ném SAU khi provider Mongoose/Redis đã mở kết nối, `started.ctx` chưa có nên không đóng được ⇒ handle mở (nay không còn `--forceExit` che). Hiếm, Nest không đưa ra moduleRef dở dang; chỉ ghi nhận.
- `int-teardown.mjs:20` — một heartbeat đang bay lúc `quit()` sẽ in warn "lock heartbeat failed" giả; và kết quả 0 của nó đến sau khi teardown đã đọc `lock.lost` sẽ bị bỏ lỡ. Cửa sổ rất nhỏ, `released === 0` vẫn bắt được trường hợp chính.
- `seed-risk.int-spec.ts:287` — 660 s cho một test là rất lớn; đã có DEBT-455 (giảm chi phí drop mỗi vòng). OK theo fold (số đo × 2).

## ✂️ Ponytail

- be/test/indexes.int-spec.ts:L3 (và 13 file khác): shrink: import hằng số từ `full-app.ts` kéo cả AppModule. Tách `test/int-timeouts.ts` một dòng.
- be/test/seed.int-spec.ts:L90-L104, seed-risk.int-spec.ts:L43-L55, indexes.int-spec.ts:L60-L72: shrink: IIFE inline trong `beforeAll` khác kiểu 12 file kia. Dùng chung `const boot = async () => {…}; beforeAll(() => (setup = boot()), T)`.
- be/test/*.int-spec.ts (15 chỗ): shrink: chú thích 2 dòng "DEBT-448: the setup promise is kept…" lặp lại. Một dòng `// DEBT-448: see FULL_APP_BOOT_TIMEOUT_MS`.
- be/test/full-app.ts:L74-L77: yagni (có điều kiện): nếu áp 🟡 2 (một mẫu cho mọi hook) thì `closeFullApp` thừa. `await setup?.catch(...); await full?.close()`.
net: -35 lines possible.
