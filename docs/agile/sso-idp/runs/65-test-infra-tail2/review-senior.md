# Senior Review — 2026-11-03

## Kết luận: REJECT (BE) / PASS (FE)

REJECT chỉ vì một 🔴 ở BE (Task 2 thiếu một điểm sửa bắt buộc của fold, backlog ghi đã làm). T1, T3-BE và T3-FE đạt. → **backend-dev** sửa 🔴 rồi quay lại senior (FE không cần làm lại).

## Tổng quan (ấn tượng chung + điểm tốt)

- Diff nhỏ, đúng lane test-infra; không nới timeout/assert, không `retries`.
- `createRedisClient` là refactor thuần: cùng tên logger `RedisClient`, cùng warn standalone, cùng `buildRedisOptions`, cùng 2 listener `error` (scrub URI) / `connect`, cùng nhánh `redisUrl`/options. `useFactory: createRedisClient` với `inject: [ConfigService]` giống hệt. Unit `redis` 4/4, `tsc` (gồm `test/**`) 0 lỗi.
- `bootFullApp` catch: chỉ chạy nhánh dọn khi `!started.ctx` (nhánh có ctx giữ nguyên); thứ tự đóng Redis + Mongo mới → `dropIntDb` → `rm keyDir` → `throw err` đúng (đóng trước drop để index build không tạo lại DB); mọi bước best effort `.catch(() => undefined)` nên lỗi gốc `err` không bị nuốt/thay. `mongoBefore` chụp ngay trước `compile()` và sau `opts.override`; override `REDIS_CLIENT` đặt trước `opts.override` nên spec vẫn thắng.
- `recordIssued`: `TokenSigner.sign` gọi `this.keys.signJwt(...)` động (`token-signer.ts:44`) nên thuộc tính riêng gán đè bắt được mọi JWT; không `jest.spyOn` nên `restoreAllMocks` không gỡ. Không khôi phục là chấp nhận được: provider là instance riêng của spec (run54/debt388 `new LocalKeyProvider`, b73 lấy từ app của T5 và app đóng ở `finally`). Kiểm không-rỗng có ở cả 3 spec, chặn pass rỗng và cũng chặn trường hợp sau này signer giữ tham chiếu method cũ.
- FE: mọi token của fake IdP đi qua `sign()`/`issue()` (kể cả nhánh HS256, `fake-idp.ts:109`), nên `issued` đủ; `leakForms` lọc phần rỗng là đúng; `bff` + toàn fe-admin 1533/1533 (tự chạy).
- `run54` `afterAll` đổi thứ tự (đọc audit → dọn → assert): ngoài fold nhưng hợp lý — trước đây assert đỏ làm bỏ qua `dropDatabase`/`close` ⇒ treo + sót DB (dev đã gặp khi mutation). Cùng mẫu với debt388 (assert không-rỗng sau dọn).

## 🔴 Blocker

- [ ] `be/test/full-app.ts:103-105` — **Fold Task 2 điểm 2 chưa làm**: `MONGO_URI` vẫn `process.env.TEST_MONGO_URI ?? ...` (diff không chạm dòng này; `grep withDbSuffix be/test/full-app.ts` = 0). Trong khi `backlog.md` dòng DEBT-203 ghi "`full-app.ts` có override ⇒ mỗi app một DB `<override>-<name>-<ts>`" và `ci.yml:74` giờ nói override dùng được cho MỘT file spec.
  Vì sao: với override, mọi `bootFullApp` trong một file dùng chung đúng DB override; `full.close()` drop DB đó ⇒ spec có app lồng nhau (tech-lead chỉ ra `b74-tester`: app ngoài ở `:100` còn mở khi `abortApp`/`tApp` boot rồi `close()`) bị app con xoá DB của app ngoài ⇒ đỏ giả/flaky. Đây chính là phần còn lại DEBT-203 mà quyết định "đóng chấp nhận" dựa vào; đóng debt với mô tả không đúng code là bằng chứng không trung thực (`b74-tester` xanh 66 có thể chỉ do thứ tự may mắn, không chứng minh được "mỗi app một DB").
  Đề xuất: `MONGO_URI: process.env.TEST_MONGO_URI ? withDbSuffix(process.env.TEST_MONGO_URI, \`${opts.name}-${Date.now()}\`) : \`mongodb://localhost:27117/vg-int-${opts.name}-${Date.now()}?directConnection=true\``; chạy lại override `vg-int-tl203b-*` cho `admin-target-risk`, `b74-tester`, `indexes`, `security-headers` + kiểm 0 DB bắt đầu bằng tên override sót lại; tên không `vg-int-*` vẫn bị guard; unit + 1 spec int không override xanh. Giữ nguyên text backlog nếu sau sửa đúng như đã ghi.

## Security invariants / trust boundaries đã kiểm

- **Không drop DB ngoài `vg-int-*`**: `withDbSuffix` chỉ nối `-<suffix>` sau tên DB (regex `(\/[^/?]+)(\?|$)` khớp đoạn path cuối trước `?`, không khớp `//host:port/` vì sau host là `/`), dùng hàm thay thế nên không có bẫy `$` trong chuỗi thay; tiền tố `vg-int-` giữ nguyên ⇒ guard `intPreflight` (run 64) + `dropIntDb` vẫn đúng. URI không có tên DB thì regex sẽ nối vào host — không tới được vì guard đòi tên `vg-int-*`.
- **Đóng nhầm kết nối người khác**: `mongoose.connections` mới so với `mongoBefore` — đúng với `--runInBand` và boot tuần tự (không tìm thấy `Promise.all` boot song song trong `be/test`). Xem 💭.
- **Exposure**: kiểm lộ token mạnh hơn trước (mọi JWT đã ký: rõ, chữ ký, base64, base64url) + giữ regex tên khoá; không-rỗng có ở cả 3 spec BE và happy path FE. Refresh token BE là opaque (không qua `signJwt`) nên không nằm trong `issued` — trước đây `eyJ` cũng không bắt được nên không yếu đi; tên khoá `refresh_token` vẫn kiểm.
- Code sản phẩm: chỉ refactor thuần `createRedisClient`, không đổi hành vi/log/listener.

## 🟡 Nên sửa

- (không có ngoài 🔴)

## 💭 Nit

- `be/test/full-app.ts:238` — lọc `mongoose.connections` theo snapshot sẽ đóng cả kết nối do code khác mở song song trong lúc `compile()` (hiện không có). Một dòng chú thích "giả định boot tuần tự (runInBand)" giúp người sau.
- Sau khi sửa 🔴: tên DB Mongo tối đa 64 byte; `<override>-<name>-<13 chữ số>` với override dài (vd. `vg-int-tl203b-<ts>`, 27 ký tự) cộng `opts.name` dài > ~22 ký tự sẽ bị Mongo từ chối. Hiện vô hại; nếu gặp thì rút `Date.now()` thành base36.
- `debt388` C1: `expectNoIssued` rỗng vì chưa ký gì trước C1 (dev đã ghi) — chấp nhận; regex tên khoá vẫn giữ ca đó.

## ✂️ Ponytail

- `fe-admin/test/support/fake-idp.ts:478` / `be/test/issued-tokens.ts:54`: hai `leakForms` gần giống nhau — khác package (fe-admin vs be), không chung module test ⇒ giữ, không tách.
- `be/test/indexes.int-spec.ts:288`, `admin-target-risk.int-spec.ts:335`: đã thay `.replace` lặp bằng helper — tốt.

Lean already. Ship. (sau khi sửa 🔴)

---

# Senior Review lượt 2 — 2026-11-03

## Kết luận: PASS (BE + FE)

- 🔴 lượt 1 đã sửa: `be/test/full-app.ts:103-105` có `TEST_MONGO_URI` ⇒ `withDbSuffix(TEST_MONGO_URI, \`${opts.name}-${Date.now()}\`)`, nhánh mặc định giữ nguyên; import `withDbSuffix` từ `./int-hooks`. Tiền tố `vg-int-` giữ ⇒ guard run 64 + `dropIntDb` vẫn đúng. Text DEBT-203 trong backlog giờ khớp code.
- Kiểm lại toàn bộ `git diff be/` vì có backup cũ: mọi file khớp diff lượt 1 trừ đúng +8/-? dòng của `full-app.ts` (import + MONGO_URI). T1 trong `full-app.ts` còn đủ (`ConfigService`/`IORedis`/`mongoose` import, override `REDIS_CLIENT` trước `opts.override`, `mongoBefore` trước `compile()`, nhánh dọn `!started.ctx`); `int-hooks.ts` `withDbSuffix` còn; `admin-target-risk`/`indexes` dùng helper; run54/debt388/b73 còn `recordIssued`/`expectNoIssued` + không-rỗng; `be/package.json` 0 `--forceExit`.
- Mutation restore: code sản phẩm chỉ còn `redis.module.ts` (refactor đã duyệt); `token.controller.ts`, `fe-admin/src/**` (`bff.ts`) không có diff ⇒ các mutation T3 đã hoàn nguyên về HEAD. `tsc` (gồm test) 0, `eslint test/full-app.ts` 0.
- Bằng chứng override (dev): `vg-int-tl203c-*` admin-target-risk 8/8, b74-tester 66/66 (3 DB riêng khi chạy, so với 1 DB chung trước sửa), indexes 19, security-headers 114, 0 DB sót; guard vẫn từ chối tên không `vg-int-*`; unit 630. Senior không chạy lại int override.
- 💭 lượt 1 giữ nguyên (không vào backlog): giả định boot tuần tự khi lọc `mongoose.connections`; giới hạn 64 byte tên DB khi override dài.

→ **tester**.
