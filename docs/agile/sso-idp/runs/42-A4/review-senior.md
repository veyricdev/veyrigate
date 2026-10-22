# Senior Review — 2026-10-22 — run 42 (A4 đăng nhập OIDC kiểu BFF cho fe-admin)

## Kết luận: REJECT

Lý do REJECT là 1 🔴 về **bằng chứng kiểm chứng**, không phải lỗi logic. Code đã thực thi đúng hai invariant "discovery tin cậy" và "`azp` khi nhiều `aud`", nhưng không test nào khoá chúng lại: xoá check đi thì cả 187 test vẫn xanh. Sửa khoảng 4 test, không phải đổi code. Sau khi sửa, chuyển lại senior để xác nhận nhanh (chỉ đọc test mới và chạy lại `pnpm -C fe-admin test`).

Đã chạy lại: `pnpm -C fe-admin typecheck && lint && test && build && check:bundle`. Kết quả: exit 0, **187/187** (11 file, có int test với vg-test-redis), build OK, check:bundle 0 hit. Không chạy E2E (đúng quy tắc).

## Tổng quan

Đây là một RP/BFF tự viết, gọn (~1.4k dòng src, bff.ts 359 dòng) và bám sát fold của tech-lead.

- Callback fail-closed theo đúng thứ tự 1→11. State gắn cookie `fea_tx`, tx single-use `GETDEL`. `iss` được kiểm trước `/token`. Mọi lần từ chối sau khi đã đổi code đều revoke RT mới.
- ID token chỉ chấp nhận RS256, có kiểm `iss`/`aud`/`exp`/`iat`/`sub`/`nonce`. Ở chế độ refresh, nonce và auth_time không bắt buộc nhưng `sub` phải khớp phiên.
- Session crypto đúng: HKDF tách 2 khoá (id/enc). Khoá Redis là HMAC của cookie. AES-256-GCM dùng IV 12 byte ngẫu nhiên mỗi lần ghi, AAD là Redis key nên không chuyển blob sang phiên khác được (đã có test). `SET XX KEEPTTL` không hồi sinh phiên.
- Single-flight refresh đọc lại bản ghi, không retry. Lỗi được phân loại: `invalid_grant` thì destroy, 5xx thì 503. Nếu logout xen giữa thì revoke RT mới.
- Step-up kiểm cả `sub` lẫn `tenantId` và `auth_time` ≥ createdAt − 30s. Nếu lệch thì huỷ cả hai phiên và revoke cả hai RT (DEBT-117).
- Logout chỉ nhận POST và chỉ khi `Sec-Fetch-Site: same-origin`. `same-site` (IdP cùng host khác port) bị chặn đúng. `post_logout_redirect_uri` chỉ lấy từ env.
- `APP_URL` bị ép là origin trần nên `redirect_uri` và so origin của `returnTo` không lệch được.
- Mutation test dev tự làm (state/nonce/iss/sub×3) là điểm cộng lớn.

## 🔴 Blocker

- [x] **[FE] Thiếu test âm cho discovery tin cậy (INV-6, rò `client_secret`)** — `fe-admin/src/server/oidc/discovery.ts:43-48`.
  - Hiện trạng: `createDiscovery` có kiểm `issuer === OIDC_ISSUER` và mọi endpoint cùng origin với issuer. Nhưng chỉ đường happy path được chạy, qua `test/support/fake-idp.ts:171`. Grep `test/` không thấy case nào cho issuer lệch hay endpoint khác origin.
  - Vì sao chặn: `token_endpoint` và `revocation_endpoint` nhận header `Authorization: Basic <client_secret>` (`idp.ts:39-48`). Nếu ai đó nới hoặc xoá vòng `for` kiểm origin (refactor, port lại từ chỗ khác) thì không test nào đỏ. Lúc đó một discovery doc bị thao túng sẽ khiến secret bị gửi sang origin lạ. Theo checklist, thiếu bằng chứng cho invariant có thể gây rò secret là 🔴.
  - Đề xuất (unit, fetch tiêm vào, khoảng 25 dòng) ba case, mỗi case kỳ vọng `discovery()` reject và login/callback không gọi `/token`:
    - (a) `issuer` khác (kể cả chỉ khác dấu `/` cuối);
    - (b) `token_endpoint` = `http://evil.test/token`;
    - (c) `jwks_uri` khác origin.
- [x] **[FE] Thiếu test cho `azp` khi `aud` nhiều giá trị** — `fe-admin/src/server/oidc/id-token.ts:34-36`.
  - Đây là mục được nêu rõ trong trọng tâm review (INV-6). Code đúng nhưng không case nào trong `it.each` ở `bff.test.ts:181-193` chạm tới nó.
  - Đề xuất: thêm 2 dòng vào bảng đó: `aud: [CLIENT, "other"]` không có `azp` thì bị từ chối và RT bị revoke; `azp: "other"` thì cũng bị từ chối. Thêm 1 case dương: có `azp` bằng CLIENT thì được chấp nhận.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| ID token: RS256 only, chữ ký JWKS, iss, aud, exp/iat, sub string, nonce | ✅ code + test (none/HS256/khoá lạ/aud/iss/exp/nonce/sub) | `id-token.ts:26-38`, `bff.test.ts:181` |
| `azp` khi nhiều aud | ✅ code, ❌ test → 🔴 | `id-token.ts:34` |
| Refresh: không đòi nonce/auth_time, `sub` phải khớp | ✅ | `bff.ts:268`, test `:317` |
| Callback CSRF/replay: cookie `fea_tx` === state, GETDEL, iss RFC 9207 trước `/token` | ✅ | `bff.ts:128-140`, test `:154-179` |
| Discovery: issuer exact, endpoint cùng origin, timeout 5s, `redirect: manual` | ✅ code, ❌ test → 🔴 | `discovery.ts:13,43-48` |
| Session crypto (HKDF/HMAC/GCM IV mới/AAD key) | ✅ + int test (sửa 1 byte, đổi key, `v` lạ) | `store.ts:102-134` |
| Cookie flags theo giao thức `APP_URL` (`__Host-`+Secure / http không Secure), HttpOnly, Lax, Path=/, host-only | ✅ | `cookies.ts:15-31`, test `:80-93` |
| Session fixation: luôn ID mới; phiên cũ huỷ sau khi tạo phiên mới | ✅ | `bff.ts:202-220`, test `:237` |
| Single-flight, không retry, `invalid_grant` ⇒ destroy, 5xx ⇒ 503 giữ phiên, logout xen giữa ⇒ không hồi sinh + revoke | ✅ | `bff.ts:233-294`, test `:261-342` |
| Step-up đổi user/tenant ⇒ huỷ cả 2 phiên (DEBT-117), auth_time mới | ✅ | `bff.ts:169-188`, test `:382-420` |
| Logout POST-only, same-origin (same-site bị chặn), post_logout từ env, revoke RT | ✅ | `bff.ts:317-354`, test `:425-495` |
| Open redirect `returnTo` (//, /\\, scheme, %2F, /auth/, control, ≤512) lưu server-side, kiểm lại khi đọc | ✅ | `return-to.ts`, test `:102-118` |
| Không rò token/secret: client chỉ nhận Viewer allowlist; lỗi → PublicError + request id; log chỉ name/message; bundle scan | ✅ (canary SSR + `/_serverFn`, E2E `eyJ`) | `errors.ts`, `start.ts`, `route-boundary.ts`, `viewer.ts` |
| Redis lỗi fail-closed: 503/500 trang chung, không xoá cookie, không redirect login | ✅ (status SSR là 500, DEBT-282 chấp nhận) | `store.ts:105-111`, test `:344` |
| Lệch dev tự khai (guard ở root `beforeLoad`; logout không cookie ⇒ 303 `/`; có cookie mất phiên ⇒ end_session không hint) | ✅ chấp nhận: `/auth/*` là server route nên không vào router; IdP vẫn hỏi xác nhận | DEBT-283 |

## 🟡 Nên sửa (không chặn; vào backlog DEBT-286…287)

- **[FE] Nhánh exception trong callback/logout bỏ qua dọn dẹp** — `bff.ts:137, 145, 202, 346`.
  - Hiện trạng: nếu `takeTx`/`policy()`/`store.create` ném lỗi (Redis hoặc discovery down), `withErrorPage` trả trang 500/503 mà không xoá `fea_tx`. Fold yêu cầu xoá "ở MỌI nhánh"; hiện cookie chỉ tự hết sau 600s.
  - Nặng hơn: `store.create` ném lỗi **sau** khi đã đổi code thì RT mới không bị revoke. RT không lộ ra ngoài, nhưng family sống tới khi IdP hết hạn.
  - Tương tự ở logout: `deps.discovery()` ném lỗi thì header `clearSid` bị mất. Phiên Redis đã bị xoá nên mức độ thấp.
  - Cân nhắc:
    - bọc phần sau bước (5) bằng `try { … } catch (e) { return abort(503) }`;
    - cho `withErrorPage` nhận thêm danh sách cookie cần xoá (`clearTx`, `clearSid`).
- **[FE] Refresh coi `tenantId` đổi là đổi danh tính, kể cả khi phiên chưa có tenant** — `bff.ts:277`.
  - Hiện trạng: user đăng nhập lúc chưa là admin có `tenantId: ""`. Nếu sau đó được cấp quyền admin thì ở lần refresh kế tiếp `/admin/me` trả tenant thật, lệch với `""`, nên phiên bị huỷ và user bị đăng xuất.
  - Đánh giá: an toàn (fail-closed) nhưng gây bất ngờ cho người dùng. Cân nhắc chỉ so `tenantId` khi `data.tenantId !== ""`, hoặc ghi rõ đây là hành vi chủ đích.

## 💭 Nit

- `id-token.ts:34`: OIDC Core §3.1.3.7 khuyến nghị kiểm `azp` cả khi `aud` chỉ có một giá trị. Nếu có `azp` thì nó phải bằng client_id. Thêm điều kiện `payload.azp !== undefined && payload.azp !== clientId` là đủ.
- `viewer.ts:13`: `setResponseHeader("set-cookie", …)` ghi đè thay vì append. Hiện chỉ có một cookie nên chưa sao, nhưng nên dùng `deleteCookie`/append của Start để về sau không nuốt mất cookie khác.
- `fea_tx` chỉ có một slot, nên đăng nhập song song ở 2 tab thì tab mở trước sẽ fail. Đây chỉ là vấn đề UX, và thiết kế như vậy là có chủ đích.

## ✂️ Ponytail

- fe-admin/src/server/auth/instance.ts:L11: shrink: `jwksCache` `Map<uri, JWKS>` thừa vì chỉ có một issuer và một `jwks_uri` (đã ép cùng origin). Thay bằng `let jwks: JWTVerifyGetKey | undefined` khởi tạo lười.

net: -5 lines possible. Phần còn lại đã gọn: RP tự viết + jose là đúng mức, không có abstraction thừa.

---

# Lượt 2 — 2026-10-22 (sau frontend-dev retry 1)

## Kết luận: PASS

Cả hai 🔴 lượt 1 đã đóng bằng test thật; phần gộp DEBT-286/287 không mở lỗ mới. Chuyển **tester**.

Đã chạy lại: `pnpm -C fe-admin typecheck && lint && test && build && check:bundle` ⇒ exit 0, **206/206** (12 file, int vg-test-redis), build OK, check:bundle 0 hit. Không chạy E2E (đúng quy tắc; dev báo 23/23).

## 🔴 Lượt 1 — xác nhận

- [x] Discovery tin cậy — `test/bff.test.ts:578-613`: 9 case (issuer khác / chỉ khác `/` cuối; token_endpoint khác origin / khác port; jwks/revocation/end_session/userinfo/authorization khác origin). Mỗi case: login ném, callback với tx hợp lệ ⇒ 500 + xoá `fea_tx`, `/token`=0, revoke=0, và **mọi URL đã gọi chỉ là discovery của issuer** (khẳng định mạnh hơn đề xuất: không request nào mang Basic secret ra ngoài).
- [x] `azp` nhiều `aud` — `bff.test.ts:190-191` (thiếu `azp` / `azp` khác ⇒ từ chối + revoke RT) và `:200` case dương.

## Kiểm phần code mới (bff.ts / errors.ts / viewer.ts)

| Rủi ro được hỏi | Kết quả | Bằng chứng |
|---|---|---|
| Revoke nhầm RT | ✅ Không: `pending.rt` chỉ gán từ `tokens.refresh_token` của **chính lần đổi code này** (`bff.ts:167-168`), xoá ngay sau `store.create` thành công (`:226`) ⇒ lỗi khi dọn phiên cũ (đã có try/catch riêng) không thể revoke RT mà phiên mới đang sở hữu. Nhánh `abort()` không ném (revoke best-effort) ⇒ không revoke đôi. | `bff.ts:126-134,167-226`, test `:256,:272` |
| Lỗi bị nuốt thành 200/302 | ✅ Không: catch ở `callback` luôn ra `unexpectedErrorPage` 500/503 (`toPublicError`), không có đường nào trả redirect/thành công; log chỉ name/message + request id. | `errors.ts:76-81` |
| Cookie không xoá | ✅ Callback mọi exception ⇒ `clearTx`; logout discovery lỗi ⇒ 503 + `clearSid` (phiên Redis đã xoá trước đó). | test `:247,:256,:272,:550` |
| `withErrorPage` thay đổi hành vi | ✅ Chỉ tách `unexpectedErrorPage` dùng chung, mặc định `setCookies=[]` như cũ. | `errors.ts:84-95` |
| `viewer.ts` append | ✅ Đã đọc mã Start `@tanstack/start-server-core@1.169.39` `getResponseHeaders()` trả **chính** `event.res.headers` (đối tượng sống), nên `append` tới được response thật, không chỉ trong mock. | `request-response.js:121` |
| Tenant `""` (DEBT-287) | ✅ Vẫn fail-closed khi cả hai có tenant và khác nhau; `sub` vẫn so trước. Phiên `""` nhận tenant từ `/admin/me` cùng `sub` — BE là nguồn sự thật, không nới quyền phía BE. | `bff.ts:294-299`, test `:391,:401` |

Không hồi quy phần đạt lượt 1 (bảng invariant lượt 1 vẫn đúng; số test tăng 187→206, không case cũ nào bị xoá/nới).

## 🔴 Blocker

Không có.

## 🟡 Nên sửa

Không có mục mới (các điểm còn lại đã nằm trong DEBT-288).

## 💭 Nit

- `bff.ts:200-202` + catch `:130-132`: step-up đổi danh tính mà `endSession(prevKey)` ném (Redis down) ⇒ trang 503 chỉ xoá `fea_tx`, không xoá `fea_sid`, phiên cũ còn trong Redis. Không phải hồi quy (lượt 1 cũng vậy) và Redis down thì phiên cũ không dùng được; nếu muốn chặt hơn có thể đưa `clearSid` vào catch khi `tx.stepUp`. Ghi chú, không mở DEBT.
- Ngoài ra tham khảo DEBT-288 (azp aud đơn, jwksCache, logout không revoke khi discovery lỗi, tenant rỗng từ BE).

## ✂️ Ponytail (delta)

Lean already. Ship. (Ponytail lượt 1 `instance.ts` jwksCache vẫn còn, đã nằm trong DEBT-288.)
