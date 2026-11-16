# Senior Review — 2026-11-16 (lô C: T5 DEBT-662 + DEBT-663 + DEBT-667 d; ponytail lô B)

Các lô trước: A lượt 1 REJECT, lượt 2 PASS; B PASS (xem `log.md`).

Đối tượng: `git diff c7c54c2` phần `common/http/request-id.ts` + `framework-errors.ts`, `oauth/authorize/authorize.service.ts`, `oauth/discovery`, `ui/ui-session.helper.ts`, `ui/mfa.controller.ts`, `test/run91-lotc.int-spec.ts`, harness `checks.mjs`, runbook-deploy §5 / §4 bước 9; ponytail lô B (`AuthorizationCodeService` bỏ `@Optional`). Đối chiếu D91.10, D91.12. Preflight `codegraph sync` xong.

Senior tự chạy lại: unit `src/common/http` + `src/modules/ui` + `src/modules/oauth/code` 96/96 xanh; int `run91-lotc.int-spec.ts` 21/21 xanh. Không chạy harness/E2E. Kết luận về harness dưới đây là **đọc code** harness đối chiếu với hành vi mới.

## Kết luận: REJECT

Code sản phẩm đúng. REJECT vì **harness lô D chắc chắn đỏ / lỗi** ở 3 chỗ do chính lô C gây ra (hai check `must` và một mutation). Cả ba sửa nhỏ. Chuyển lại **backend-dev**; senior chỉ cần review lại phần sửa.

## Tổng quan

- **DEBT-662**: kiểm `response_mode` ở Phase 2, tức sau khi `client_id` và `redirect_uri` đã được tin ⇒ `AuthorizeRedirectError('invalid_request')` có `state` + `iss`, text cố định, không phản chiếu input. Trường hợp mảng, chuỗi rỗng, `query.jwt` đều bị chặn bởi `!== 'query'`. `redirect_uri` chưa hợp lệ ⇒ Phase 1 ⇒ trang 400, không có `Location`. Discovery đã có `response_modes_supported: ["query"]`. Int có 8 ca. Đạt.
- **DEBT-663**: `no-store` đặt ở `liveSession` (mọi trang phụ thuộc phiên, kể cả nhánh 302 của `/`) và `identity` (mọi form có CSRF) ⇒ đúng tinh thần "helper chung" của D91.12. `/login/mfa` đặt thủ công vì phụ thuộc ticket MFA chứ không phụ thuộc phiên: hợp lý. Có unit cho helper và int cho 12 route.
- **DEBT-667(d)**:
  - `BlockList` từ `node:net`, không thêm dependency.
  - So khớp theo `req.socket.remoteAddress` (peer thật), không theo XFF.
  - Peer dạng IPv4-mapped (`::ffff:a.b.c.d`) được kiểm như IPv4, sau đó vẫn kiểm như IPv6 nên một entry IPv6 cũng khớp được.
  - `parseTrustProxy` đã validate IP/CIDR trước khi tới `trustedProxies`.
  - `framework-errors.ts`: `trustProxy` của Fastify không đổi. Chỉ `genReqId` đổi, đúng ý D91.10: không có `TRUST_PROXY` ⇒ id của client bị bỏ qua, mọi request nhận UUID mới.
  - `full-app` truyền `TRUST_PROXY` chỉ cho test helper.
- **Ponytail lô B**:
  - Bỏ `@Optional ConfigService`: đã làm, tốt.
  - "Signer trả `jti`/`exp`": lý do bỏ (đổi `TokenSigner.sign` chạm golden test và vault spec) là hợp lý. Lợi ích khoảng −10 dòng không đáng rủi ro ở đường ký token ngay trước gate. Đóng, không mở DEBT.

## 🔴 Blocker (chặn gate lô D; sửa trước khi tester chạy harness)

- [ ] **Harness `CONTRACT-REQID-echo` (must) sẽ đỏ.** Ở `be/scripts/pentest/checks.mjs` khoảng dòng 998–1002, check vẫn đòi `x-request-id: pt-req-123` được echo nguyên văn.
  - Vì sao: profile harness D90.2 chạy với `TRUST_PROXY` rỗng (`pentest.mjs:6`, và check XFF-throttle cũng dựa vào điều này). Theo D91.10, id của client nay **luôn** bị thay ⇒ check này chắc chắn đỏ, `exit 1`.
  - Đề xuất: đổi hợp đồng của check theo D91.10. Không có proxy tin cậy ⇒ id hợp lệ của client **không** được echo, mà echo một id an toàn mới. Đổi tên/mô tả cho đúng (vd. `CONTRACT-REQID-untrusted`). Không đặt `TRUST_PROXY` cho cả profile, vì sẽ làm hỏng tiền đề của check XFF-throttle.
- [ ] **Mutation `m4` sẽ ném lỗi** ở `be/scripts/pentest/mutate.mjs:57-64`.
  - Vì sao: anchor `from` là `"typeof value === 'string' && SAFE_REQUEST_ID.test(value) ? value"`, nhưng `request-id.ts` nay xuống dòng ở `SAFE_REQUEST_ID.test(value)` (dòng 50) ⇒ anchor không còn khớp ⇒ `anchor not found exactly once` (`mutate.mjs:104`) ⇒ bộ mutation dừng.
  - Ngay cả khi khớp, với `TRUST_PROXY` rỗng thì header không bao giờ được dùng, nên bỏ kiểm safe-token cũng không làm `INJ-LONG-reqid` đỏ ⇒ mutation mất nghĩa.
  - Đề xuất: đổi m4 thành mutation của invariant mới, vd. bỏ điều kiện `fromTrustedProxy(trusted, req.socket?.remoteAddress) &&` ⇒ kỳ vọng `CONTRACT-REQID-untrusted` (và `INJ-LONG-reqid` nếu kèm bỏ safe-token) đỏ. Chạy `--mutate m4` ở gate.
- [ ] **Harness `SESS-HDR-authorize-error` (must) sẽ đỏ.** Route `/authorize?client_id=nope` không nằm trong `NO_STORE_EXEMPT`, nhưng `AuthorizeController.handleError` và `expiredPage` (`authorize.controller.ts` khoảng dòng 251–268) render `error.eta` 400 **không** có `Cache-Control`.
  - Quyết định phạm vi: **sửa code, không miễn** trong harness. Đề xuất đặt `no-store` một lần ở đầu handler `GET/POST /authorize`. Một dòng này phủ luôn trang lỗi, trang hết hạn, trang `mfa-required`/consent (hai trang đó đã có header riêng) và 302 mang `code`. Response mang code và trạng thái đăng nhập không được để cache trung gian giữ.

## Phạm vi `SESS-HDR-*` (quyết định của senior)

Đã đối chiếu từng route trong `HDR_ROUTES` với code:

- **Đã có `no-store`, sẽ xanh**:
  - UI (qua helper), `/login/mfa`, `/auth/*` (`federation.controller` đặt ở đầu `start`/`callback`/`link`).
  - `/admin/*` (guard `tenant-context.ts:175` đặt cho mọi response, kể cả lỗi; lỗi auth do `admin-auth.errors.ts`).
  - `/userinfo` (`@Header`, RFC/OIDC: response chứa PII), `/demo/me` (`@Header`), `/metrics` (`metrics.http.ts`).
  - `/token` (RFC 6749 §5.1, `noStore` sẵn có).
- **Miễn đúng** (`NO_STORE_EXEMPT`):
  - `discovery` (`public, max-age=300` là chủ đích), `jwks` (`no-cache` là chủ đích, cho xoay khoá khẩn).
  - `health`/`ready` (thực ra có đặt `no-store`, miễn cũng vô hại), `openapi-admin` (có đặt), `not-found-404` (tài liệu tĩnh/lỗi chung).
- **Thiếu**: chỉ `authorize-error` (🔴 thứ 3 ở trên).

Phạm vi "mọi route trừ danh sách miễn tường minh" là đúng hướng: route mới mặc định bị kiểm.

## Security invariants / trust boundaries đã kiểm

- **Open redirect / phản chiếu**: lỗi `response_mode` chỉ redirect tới URI đã đăng ký, với text cố định.
- **Request-id spoofing** (tương quan audit): chỉ peer thuộc `TRUST_PROXY` mới được đặt id, header vẫn phải qua kiểm safe-token. Không dùng XFF nên không giả mạo được qua header.
- **Cache**: trang phụ thuộc phiên/CSRF đã `no-store`. Còn thiếu `/authorize` (🔴).
- **Exposure**: không có gì mới được log hay echo.

## 🟡 Nên sửa

(không có ngoài 3 🔴)

## 💭 Nit

- AC int D91.10 đòi "audit `requestId` = header phản hồi ở **cả hai** trường hợp". `run91-lotc` chỉ có ca không tin cậy. Ca proxy tin cậy chỉ được khoá ở unit adapter (`inject` từ 127.0.0.1). Có thể thêm 1 ca int với `TRUST_PROXY=127.0.0.1`, không bắt buộc.

## ✂️ Ponytail

Lean already. Ship. `trustedProxies`/`fromTrustedProxy` dùng stdlib `BlockList`, không có abstraction thừa. Helper `no-store` đặt ở 2 điểm chung thay vì rải theo từng route.

---

# Senior Review — 2026-11-16 (lô C lượt 2, sau retry 1)

Đối tượng: `git diff` của `authorize.controller.ts`, `run91-lotc.int-spec.ts`, `checks.mjs`, `mutate.mjs`. Int `run91-lotc` chạy lại 22/22 xanh. Không chạy harness/E2E.

## Kết luận: PASS

- 🔴(1) đã sửa: `CONTRACT-REQID-echo` ⇒ `CONTRACT-REQID-untrusted` (must). Đòi: id hợp lệ và id 8 KB đều được echo bằng id an toàn mới, **không bao giờ** là giá trị client gửi (peer không thuộc `TRUST_PROXY`). Đúng D91.10; profile harness giữ `TRUST_PROXY` rỗng nên check XFF-throttle không bị ảnh hưởng.
- 🔴(2) đã sửa: m4 nay đột biến chính invariant mới (`fromTrustedProxy(...) &&` ⇒ `true &&`). Kỳ vọng `CONTRACT-REQID-untrusted` đỏ, vẫn nằm trong nhóm INJ như check. Backend-dev báo anchor khớp đúng 1 lần trong dist, và chạy riêng: bản gốc trả UUID, bản đột biến echo id. Cần `--mutate m4` ở gate để có evidence.
- 🔴(3) đã sửa: `no-store` là dòng đầu của `GET /authorize` và `POST /authorize/consent` ⇒ mọi nhánh trả về đều có header. Lỗi CSRF guard ở consent đi qua `html-exception.filter` (đã `no-store`). Int có ca mới cho 5 loại phản hồi (trang lỗi, trang hết hạn, 302 kèm code, 302 kèm error, 302 về /login).
- Không có 🟡 mới. Không mở DEBT. Ponytail: lean already. Ship.
