# Senior Review — 2026-11-03 (run 63, int-setup-sweep)

## Kết luận: PASS

## Tổng quan

Diff gọn và đúng fold tech-lead: 1 helper không kéo `AppModule` (`int-hooks.ts`, chỉ import `mongoose`), 1 config int, 28 cặp hook cùng một mẫu, 3 drop cấp file cho DEBT-454. Không có `expect`/`it`/`describe` nào bị đổi hay xoá (grep diff chỉ còn 1 dòng `redis.quit()` thụt lề). Số đo trong `scratchpad/r63/` khớp log: 3 lượt full 53/53 suite, 1420/1420; 0 `[int] setup failed`, 0 `Exceeded timeout`; DB 610→610, keyDir 19→19. Mutation `mut-old.log`/`mut-new.log` cho thấy rõ M1 (close-start < seed ở mẫu cũ, ≥ seed-done ở mẫu mới) và M2 (mẫu cũ có `TypeError`, mẫu mới chỉ còn dòng warn kèm đúng lý do).

Reviewer tự chạy lại: `typecheck` exit 0, `lint` exit 0, unit 630/630. `test:int authorize --listTests` ra 2 file, không có filter ra 53. `--testTimeout=30000 --showConfig` cho `testTimeout: 30000` (scalar); không truyền cờ thì 20000. `globalSetup`/`globalTeardown` trỏ đúng `test/int-preflight.mjs`/`int-teardown.mjs`; `testRegex` là `["\\.int-spec\\.ts$"]`.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

Diff chỉ chạm hạ tầng test. Ranh giới cần kiểm là **xoá dữ liệu** (dropDatabase).

- **`dropIntDb` có thể drop nhầm DB không?** Guard đọc `conn.name`. Đây là tên DB mongoose resolve từ URI, cũng chính là DB sẽ bị `dropDatabase()`, nên không có khe TOCTOU giữa tên được kiểm và DB bị drop. URI không có path thì `conn.name` là `test`, bị từ chối.
  - Khi `TEST_MONGO_URI` trỏ DB dùng chung không mang tiền tố `vg-int-` (vd. `sso-idp`): hàm **ném lỗi và không drop**, `afterAll` đỏ. Như vậy hàm fail closed. HEAD còn tệ hơn: 3 file này gọi `clientModel.db.dropDatabase()` vô điều kiện, tức là drop luôn DB do người dùng chỉ định. Thay đổi này chỉ làm việc drop chặt hơn.
  - Khi `TEST_MONGO_URI` trỏ một DB có tên `vg-int-*` mà nhiều nơi dùng chung: DB sẽ bị drop. Đây là cùng ngữ nghĩa với mọi spec nhẹ khác hiện nay (DEBT-471), không phải hồi quy.
  - CI không đặt `TEST_MONGO_URI` (`ci.yml:72-75`).
- **`full-app.ts` catch**: hàm chỉ drop khi không có `TEST_MONGO_URI`. Khi đó URI do chính hàm sinh (`vg-int-…`), nên `.catch(() => undefined)` không nuốt trường hợp guard từ chối. `rm(keyDir).catch` cũng không che `err` gốc.
- **Thứ tự hook**: `afterAll` cấp file chạy sau `afterAll` của mọi `describe` con. Jest vẫn chạy nó kể cả khi một `afterAll` con ném lỗi, nên DB được drop sau khi mọi app đã đóng. Đây đúng là gốc của DEBT-454.
- **`settled`**: hàm không nuốt lỗi mà log `[int] setup failed: <msg>`, và không ném. Nó chờ chính promise `boot()` (gồm cả phần seed), nên `close()` chỉ chạy sau khi seed xong. Không có unhandled rejection vì jest đã gắn handler vào promise trả từ `beforeAll`. Thời gian chờ có trần là timeout 70 s của `afterAll`.
- **Không `TypeError` ở `afterAll`**: đã rà 28 cặp hook. Mọi tài nguyên đều có `?.` hoặc guard (`if (app)`, `if (conn)`, `if (redis)`, `if (sessions)`, `if (!conn) return`). `table`/`lines` là `const` đã khởi tạo.

## 🟡 Nên sửa

- [ ] **Chú thích cũ ở `be/test/int-preflight.mjs:19`**
  Dòng này ghi "Attached ONLY via the `--globalSetup` flag in the `test:int` script", nhưng từ run 63 nó được gắn qua `be/jest.int.config.js`.
  Vì sao: người sau sửa script, tìm cờ `--globalSetup` sẽ không thấy, và có thể thêm lại cờ đó lên CLI, tái tạo DEBT-456 dưới dạng khác.
  Đề xuất: sửa thành "Attached ONLY via `globalSetup` in `jest.int.config.js` (`test:int`)". Đây là hệ quả trực tiếp của thay đổi script nên thuộc phạm vi run. → **DEBT-473**
- [ ] **DEBT-472 trùng với DEBT-467**
  Cả hai cùng mô tả `vault-transit-key-provider.spec.ts` vượt timeout 5000 ms khi máy đang tải. DEBT-467 đã ghi đúng file này ở lần 1.
  Vì sao: hai dòng cho cùng một gốc làm số liệu bị chia đôi, và khi sửa một dòng rất dễ quên đóng dòng kia.
  Đề xuất: đóng DEBT-472 bằng cách gộp vào DEBT-467, kèm số đo V11 (48,6 s so với 38,0 s, ngay sau lượt int dưới tải). → **DEBT-474**

## 💭 Nit

- `backlog.md` DEBT-471: dòng này vẫn liệt kê `authorize` làm ví dụ "drop vô điều kiện", trong khi run 63 đã chuyển 3 file (`authorize`, `client-auth-rate-limit`, `demo`) sang `dropIntDb`. Log ghi "một phần", nhưng dòng backlog chưa ghi. Nên thêm "(run 63: 3 file DEBT-454 đã qua `dropIntDb`)" khi đóng run.
- Ở 3 file DEBT-454, `describe` thứ hai giờ chạy trên DB còn dữ liệu của `describe` đầu. Trước đây nó chạy trên DB vừa bị drop, rồi tự tạo lại collection. Cả 3 lượt full đều xanh và thứ tự là cố định, nên không có lỗi. Chỉ cần ghi nhớ: nếu sau này `describe` 2 đếm document toàn collection thì cần lọc theo id của nó.
- `indexes.int-spec.ts:61`: chú thích "can exceed Jest's 5s default" đã có từ trước. Giờ timeout là `INT_SETUP_TIMEOUT_MS` nên câu này thừa. Không cần sửa riêng.
- `b74-tester.int-spec.ts`: hai `describe` lồng nhau khai báo lại `boot`/`setup`, che biến cùng tên ở ngoài. Lint vẫn sạch và mỗi scope tự đóng đúng, chỉ là đọc dễ nhầm.

## Đối chiếu yêu cầu kiểm

- **CI và script khác**: chỉ `ci.yml:131` gọi `pnpm -C be test:int`, và lệnh này không đổi. Không còn chỗ nào gọi dạng cũ (`--testRegex "\.int-spec"`). `test:vault`/`test:sentinel` vẫn ở dạng cũ, đúng như DEBT-470.
- **`jest.int.config.js`** giữ nguyên hành vi cũ:
  - HEAD auto-discover `jest.config.js` rồi CLI ghi đè. Giờ là `...require('./jest.config.js')` cộng các override, nên kết quả tương đương.
  - Các giá trị testRegex, timeout, globalSetup và globalTeardown đã được `--showConfig` xác nhận ở trên.
  - `--experimental-vm-modules` và `--runInBand` vẫn nằm trên CLI.
  - Regex unit `.*\.spec\.ts$` không khớp file `*.int-spec.ts`.
- **DEBT-470/471/472**: DEBT-470 và 471 hợp lý, đúng phạm vi và có hướng sửa rõ. DEBT-472 nên gộp vào DEBT-467 (DEBT-474).
- **Coverage**: số suite (53) và số test (1420) giữ nguyên; không có assertion nào bị đổi.

## ✂️ Ponytail

Lean already. Ship.

Ghi chú: chú thích một dòng `// DEBT-448: afterAll waits…` lặp 28 lần, phần lớn trùng với JSDoc của `settled`, nên có thể cắt khoảng 28 dòng. Tuy vậy đây là yêu cầu tường minh của fold tech-lead và mỗi chỗ chỉ một dòng, nên không ghi thành debt. `int-hooks.ts` có 3 export, đều được dùng và không có abstraction thừa.
