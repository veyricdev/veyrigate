# Log — run 58

- orchestrator: mở run sweep 🟡 BE DEBT-158/389/160/151/214/238 (việc có hẹn ngày 379/369/371 chưa tới hạn).

## [2026-10-28] tech-lead
- Preflight codegraph 1.6.2 sync OK. Xác minh 6 debt tại HEAD `b71405a`: cả 6 còn đúng.
- Phạm vi 3 task: T1 DEBT-389 test hội tụ emergency + sửa bẫy runbook §1 bước 3, đóng DEBT-158 (chấp nhận, không cooldown) và DEBT-160 (chốt spec §10, không code); T2 DEBT-151 DELETE consent idempotent 204 + luôn sweep + audit `alreadyRevoked`; T3 DEBT-238 `clientErrorStatus` chỉ nhận `code` rỗng/`FST_`.
- DEBT-214 cần người dùng (Q58.1, đề xuất A giữ nguyên) ⇒ ngoài phạm vi.
- Mở DEBT-428 (FE copy/retry revoke consent), DEBT-429 (Vault versions tăng mãi qua normal rotate).
- Kết quả: **PASS** (fold cuối tasks.md ưu tiên). Bàn giao: ⇒ backend-dev.

## [2026-10-28] backend-dev
- Security T2: tài sản consent + family RT user×client×resource; actor admin.write+step-up; transition revokedAt null→t (không ghi đè, `$ifNull` + before-image), family sweep mỗi lần; abuse IDOR/cross-tenant ⇒ 404 byte-identical cả consent đã revoke, replay/race ⇒ hội tụ; fail-closed (sweep/audit lỗi ⇒ 5xx, retry ⇒ 204); exposure 204 rỗng, metadata chỉ clientId/resource/count/alreadyRevoked.
- T1 DEBT-389: unit hội tụ emergency xanh trên HEAD (không sửa code SP, `git diff be/src ':!*.spec.ts'` rỗng tại T1); mutation config=before.latest ⇒ RED, bỏ `config` ⇒ RED; runbook-ops §1 bước 3 + mục Vault, spec §10 (DEBT-160). DEBT-158 đóng chấp nhận.
- T2 DEBT-151: `revokeById` ⇒ `{consent, alreadyRevoked}`; controller luôn sweep, failure audit `family_sweep_failed` best-effort. Đổi có chủ đích test cũ "already revoked ⇒ 404" ⇒ 204 + audit thứ 2. (a)–(e) mới; (e) xanh cả trên HEAD (guard). Mutation: M1 `revokedAt:null` ⇒ (a)(b)(c)(d) RED; M2 bỏ sweep khi alreadyRevoked ⇒ (b); M3 bỏ `clientId $in` ⇒ (e); M4 ghi đè ⇒ (a). Guard (f): `cross-tenant user, step-up and scope on family/consent routes`. OpenAPI snapshot sửa 1 description (BE :4000 không chạy) + `gen:api`.
- T3 DEBT-238: predicate `code` rỗng/`FST_*`. Nguồn thật (b74-tester retry 1): 400/413/415 mang `FST_*`, static 403 không `code` ⇒ không nguồn nào bị chặn. Mutation bỏ kiểm code ⇒ 3 unit RED; chỉ-FST_ ⇒ 10 int static RED. sha256 khôi phục OK cho mọi mutation.
- Verify: be unit 600/600, typecheck/lint/build 0; int 3 shard 591+440+340 = 1371/1371 (52 suite, lock trống); root lint/typecheck 0; root test be 600 + fe-admin 1416 + fe-sso-test 269; audit high 0 (1 ignored); E2E 36 passed (4.1m). Grep secret output: 0.
- Đóng DEBT-151/158/160/238/389; mở DEBT-430 (snapshot OpenAPI không có test chống lệch). Bàn giao ⇒ senior-reviewer.

## [2026-10-28] senior-reviewer
- Preflight codegraph 1.6.2 sync OK. Đọc diff (be/src, test, docs, openapi) qua git + CodeGraph.
- Chạy lại: unit oauth-exception/html-exception/vault-transit/consent 100/100; `tsc --noEmit` 0; eslint file đổi 0; int admin-users/consent 11 suite 289/289 (lock qua preflight).
- T1 đạt (runbook §1 "đúng 1 item" khớp `live()`/floor; spec §10 khớp `KeyRotationService`). T2 đạt (IDOR/404 byte-identical, `$ifNull` + before-image, race, fail-closed, metadata). OpenAPI snapshot khớp decorator từng byte.
- 🔴 T3: Fastify 5.12.5 `content-type-parser.js` `rawBody.onEnd` gắn `statusCode=400` cho lỗi stream body; client huỷ upload giữa chừng ⇒ `{code:'ECONNRESET', statusCode:400, message:'aborted'}` (tái hiện bằng probe Fastify thật ở scratchpad). Predicate mới ⇒ nhánh 500 + `logger.error` mỗi kết nối (client ẩn danh bơm ERROR log, regression B7.4; `onResponse` không chạy nên không có metric). Vi phạm điều kiện dừng T3 của fold.
- 💭: comment cast trong `revokeById`; retry DELETE sau re-consent revoke consent mới (có từ trước).
- Ponytail: Lean already. Không debt mới (🟡 đã có DEBT-428/430).
- Kết quả: **REJECT** ⇒ backend-dev (chỉ T3; chốt với tech-lead việc nhận thêm `ECONNRESET`+400+`aborted`, unit + int abort thật + mutation).

## [2026-10-28] tech-lead (fold bổ sung T3 sau senior REJECT)
- Rà Fastify 5.12.5 + plugin đăng ký (formbody/cookie/cors/helmet/middie/view/static/send). Chỉ có MỘT chỗ gắn 4xx lên lỗi không `FST_`: `content-type-parser.js` `rawBody.onEnd`, gán 400. Các nguồn còn lại (validation, onBadUrl, maxParamLength) đã mang `FST_` hoặc là response thô. Với `payload = request.raw` (repo không có preParsing), lỗi duy nhất có thể gặp là Node `ConnResetException('aborted')`. Lỗi này bao luôn trường hợp timeout và lỗi parse HTTP giữa body.
- Quyết định: chấp nhận đề xuất senior, match chặt `code==='ECONNRESET' && statusCode===400 && message==='aborted'`. Bác allowlist theo nguồn và kiểm `request.raw.aborted`, vì hai cách này nuốt ERROR log của lỗi server thật và phải đổi helper dùng chung.
- Fold "Fold tech-lead bổ sung T3 — ƯU TIÊN" cuối tasks.md gồm: predicate, 6 unit, int abort socket thật trên `POST /token` (RST + FIN, có chờ spy, 0 dòng level 50), 4 mutation, doc + matrix. Không mở debt mới.
- Kết quả: **PASS (fold)**. Bàn giao: ⇒ backend-dev retry 1 (chỉ T3).

## [2026-10-28] backend-dev retry 1 (T3) — ⏸ DỪNG, cần tech-lead
- Làm theo fold: `fastifyBodyAbort = code==='ECONNRESET' && status===400 && message==='aborted'` + doc comment; unit OAuth (+7 case) / HTML (+2) xanh. Mutation (sha256 khôi phục OK): M1 bỏ nhánh ⇒ 2 unit 400 RED; M2 bỏ message ⇒ socket hang up/read ECONNRESET RED; M3 4xx bất kỳ ⇒ 2 case 404 RED; M4 bỏ code ⇒ ECONNREFUSED RED.
- Int abort thật (net.connect, nửa body POST /token, RST + FIN): bắt được đúng `{code:'ECONNRESET',statusCode:400,message:'aborted'}` cả 2 biến thể. Fastify/Node chỉ log `"request aborted"` level 30; level 50 DUY NHẤT là `OAuthExceptionFilter` ("non-Error thrown (object)") ⇒ điều kiện dừng "Fastify tự log 50" KHÔNG xảy ra.
- BLOCKER: dưới Jest `--experimental-vm-modules` lỗi Node core khác realm ⇒ `instanceof Error` false (`util.types.isNativeError` true) ⇒ `clientErrorStatus` = undefined ⇒ int RED với predicate của fold (giữ `instanceof Error`). Prod (không VM) không bị. Thử nghiệm (đã revert byte-identical): guard `instanceof Error || types.isNativeError(e)` ⇒ int 2/2 xanh, 0 dòng level 50, unit 27/27.
- Ghi chú hạ tầng test: Nest bind `filter.catch.bind(filter)` lúc init ⇒ phải bọc prototype TRƯỚC boot (app riêng); nestjs-pino root logger là static ⇒ đếm level 50 trên cả 2 stream.
- Int test để ngoài repo (đỏ khi chưa quyết): patch tại scratchpad `b74-retry1.patch`. Verify trạng thái repo hiện tại: be unit 609, typecheck/lint/build 0, int 591+440+340=1371, root lint/typecheck 0, root test 609+1416+269; grep secret 0.
- Cần tech-lead chọn: (A) đổi guard thành `instanceof Error || types.isNativeError` (realm-robust, áp cho cả HtmlExceptionFilter) rồi áp int test; (B) giữ `instanceof`, int abort chạy bằng child process Node ngoài VM Jest; (C) chấp nhận chỉ unit + probe. Đề xuất A. DEBT-238 để mở.

## [2026-10-28] tech-lead (fold bổ sung T3 lần 2: guard realm)
- Chọn **A**: guard `instanceof Error || types.isNativeError(e)` trong `clientErrorStatus`. `HtmlExceptionFilter` hưởng theo qua helper. Bác B vì cần harness child process mới, nặng hơn bản sửa. Bác C vì mất tripwire socket thật.
- Kiểm trên Node v22.22.3:
  - `isNativeError` cần slot `[[ErrorData]]`. Trả false với `Object.create(Error.prototype)`, Proxy(Error), object thường và object cross-realm không native. Trả true với Error cross-realm và subclass. Attacker không tạo được giá trị này.
  - A là superset nghiêm ngặt của guard cũ. Ở prod, A tương đương guard cũ.
  - Lỗi `@fastify/error` 4.2.0 không native (`isNativeError` false, `instanceof` true) ⇒ CẤM dùng `isNativeError` một mình.
  - Không có `Error.isError` trên Node 22.
- Nhánh `HttpException`, `isDependencyUnavailable` và `errorForLog` không đổi. Dưới VM, `errorForLog` vẫn in "non-Error thrown" cho lỗi bị từ chối: chỉ ảnh hưởng lúc test, không mở debt.
- Fold "lần 2" cuối tasks.md:
  - Unit U-A1…U-A4 cross-realm qua `node:vm`. `Object.create(Error.prototype)` có hình dạng abort phải là object **cross-realm** ⇒ 500. Bản cùng realm vẫn qua `instanceof` như hôm nay.
  - Áp patch int.
  - M1 phải RED int. Thêm mutation M5–M7.
- Kết quả: **PASS (fold)** ⇒ backend-dev tiếp tục retry 1 T3.

## [2026-10-28] backend-dev retry 1 tiếp (T3, phương án A)
- Guard `!(exception instanceof Error) && !types.isNativeError(exception)` (`node:util`) + 1 câu doc; predicate còn lại giữ nguyên; `html-exception.filter.ts` không đổi (chỉ spec, `git diff --stat` xác nhận).
- Unit: U-A1 (vm cross-realm native ⇒ 400, 0 log), U-A2/U-A3 (cross-realm không native / object thường ⇒ 500 + log), U-A4 (`@fastify/error` shape 413 ⇒ 413, 0 log), HTML U-A1 ⇒ 400 page. Int patch `b74-retry1.patch` áp vào `b74-tester.int-spec.ts`: RST + FIN xanh, shape `{ECONNRESET,400,'aborted'}`, 0 dòng level 50.
- Mutation (sha256 khôi phục OK): M1 bỏ `fastifyBodyAbort` ⇒ int RED cả 2 (`… half sent then RST …`, `… half sent then FIN …`) + 4 unit; M2 ⇒ socket hang up/read ECONNRESET; M3 ⇒ 2 case 404; M4 ⇒ ECONNREFUSED; M5 chỉ `instanceof` ⇒ int RED cả 2 + U-A1 (OAuth + HTML); M6 chỉ `isNativeError` ⇒ U-A4; M7 `typeof object` ⇒ U-A2/U-A3 (+ 2 case object thường cũ).
- Verify: be unit 614, typecheck/lint/build 0; int 593+440+340 = 1373 (lock trống mỗi shard); root lint/typecheck 0; root test 614 + 1416 + 269; grep secret 0. Bàn giao ⇒ senior vòng 2 (DEBT-238 đóng khi PASS).

## [2026-10-28] senior-reviewer vòng 2 (retry 1 T3, DEBT-238) — PASS
- Guard `instanceof Error || types.isNativeError` + `fastifyBodyAbort` (ECONNRESET && 400 && 'aborted') đúng fold lần 1/lần 2. Không nới thêm. `html-exception.filter.ts` không đổi (chỉ spec). Doc comment và dòng DEBT-238 trong security-matrix đúng sự thật.
- Unit U-A1..U-A4 + look-alike đúng mục đích. Int RST/FIN: wrapper cài lên prototype trước boot, chờ spy có điều kiện, đếm level 50 trên cả 2 stream (không lọc theo logger). Wrapper thường thay `jest.spyOn` vì `restoreAllMocks`: chấp nhận. M1–M7 theo log dev khớp fold; không chạy lại mutation để không sửa code.
- Chạy lại: unit oauth/html 32/32; typecheck 0; eslint 0; `test:int -- b74-tester` 55/55, shape thật `{ECONNRESET,400,'aborted'}` ở cả rst và fin.
- 0 🔴, 0 🟡, 2 💭 (chờ cố định 50 ms sau spy; `console.warn` bằng chứng). Không mở debt. DEBT-238 ĐÓNG. Bàn giao ⇒ **tester**.

## [2026-10-28] tester — PASS
- Preflight codegraph 1.6.2 sync OK; lock `vg:int-lock` trống; cổng 4000/5173/3000 trống, không `E2E_REUSE`.
- Thêm 14 test int: T2 T58-1…5 (`admin-users.int-spec.ts`: N lần + 6 song song, sweep lỗi ×2, DB lỗi, admin B vs member B, guard trên consent đã revoke); T3 T58-6…11 + 3 case admin look-alike (`b74-tester.int-spec.ts`: abort mid-body `/authorize/consent`, `/login` (+chunked), `/admin/clients`, `/introspect`; đối chứng 5xx thật có log).
- Mutation M-A…M-E + M-T1 đều RED đúng test; sha256 khôi phục OK. Không sửa code sản phẩm.
- Verify: be unit 614, typecheck/lint/build 0; int full 839+548 = 1387 (52 suite); root lint/typecheck 0; root test 614 + 1416 + 269; audit high 0 (1 ignored); E2E 36 passed; grep secret 0. Xem test-report.
- Kết quả: **PASS**, không debt mới. Bàn giao ⇒ orchestrator đóng run 58.
