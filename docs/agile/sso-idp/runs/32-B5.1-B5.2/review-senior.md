# Senior Review — 2026-10-19 (run 32, B5.1 + B5.2 federation)

## Kết luận: PASS

Không có 🔴. Còn 🟡 → DEBT-189, DEBT-190 trong `backlog.md`. Chuyển → **tester**.

Kiểm chứng tại chỗ (vg-test-*): `pnpm -C be typecheck` sạch; `pnpm -C be test` 303/303; `pnpm -C be test:int -- federation indexes` 49/49. Không chạy E2E, không gọi Google/GitHub thật.

## Tổng quan

Diff gọn và bám fold F1–F16. Điểm tốt:
- **INV-23**: endpoint là hằng https trong `providers.ts`. Seam test là DI `FEDERATION_PROVIDERS` + `overrideProvider`, không có provider `mock` trong `src/`, không rẽ nhánh theo `NODE_ENV`. Unit `federation.client.spec.ts:318` khẳng định tĩnh rằng không đọc env/request vào URL và chỉ helper được gọi `fetch`. `redirect_uri` dựng từ `ISSUER`, không dùng Host.
- **State**: Lua GET+DEL theo `sha256(state)` được gọi **trước** mọi kiểm (`federation.service.ts:112`). Sau đó mới kiểm provider của record (mix-up), cookie `idp_fed` so constant-time (login CSRF), và `iss` Google (RFC 9207). Mutation F15 có RED.
- **Redirect**: đích chỉ là URL registry hoặc `/authorize?request_id=<encodeURIComponent(record.requestId)>`, dựng từ record server. Mọi lỗi là trang first-party và không bao giờ redirect về RP.
- **Google**: `jwtVerify` chốt RS256, `iss` theo allowlist, `aud`, `exp`/`iat`, clockTolerance 60s, `nonce` constant-time, `sub` không rỗng, `email_verified === true`. **GitHub**: `providerId = String(id)` (không dùng `login`). Email phải `primary && verified`. Token trả 200 kèm `error` bị coi là lỗi.
- **Provisioning**: không auto-link theo email (409, 0 User, 0 FI). Bù trừ User + membership khi FI bị E11000, có test race ×10 cho cả cùng email và khác email. Bị lock thì không có session.
- **Session**: `sessions.establish(cookie cũ, …)` chống fixation; `amr` đi session → code → ID token (DEBT-030); refresh không bịa `amr`.
- **Exposure**: logger chỉ ghi mã cố định, audit chỉ ghi `{provider,newUser}`. Lỗi jose/fetch bị nuốt, không ghi `err.message`. Có test exposure trên log/audit/trang lỗi.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| INV-23 không có URL provider từ input/env/DB | OK | `providers.ts:20-34,82-115`; `provider-http.ts` là điểm `fetch` duy nhất; unit static check |
| State single-use, consume trước | OK | `federation-state.store.ts` (Lua), `federation.service.ts:112`; int "replayed state", mutation "consume sau exchange" RED |
| Login CSRF (`idp_fed`) | OK | `federation.service.ts:116-117`; cookie `HttpOnly; SameSite=Lax; Path=/auth/`, Lax vẫn gửi ở callback top-level GET; int "missing or foreign idp_fed" |
| Mix-up / `iss` | OK | `record.provider !== provider.name`; Google `iss` ∈ allowlist khi có; int cross-route + iss lạ |
| Open redirect | OK | `resume` dựng từ `record.requestId` (đã peek tồn tại ở start), encode; `loginUrl` cũng vậy; `error.eta` escape bằng `<%= %>` |
| Google ID token | OK (💭 `azp`) | `federation.client.ts:95-134`; unit sai iss/aud/nonce/chữ ký/HS256/hết hạn |
| GitHub email primary+verified | OK | `federation.client.ts:166-174`; int `it.each` 905 |
| Không auto-link | OK | `resolveUser` chỉ tra `(provider, providerId)`; email trùng ⇒ 409 + audit `federated_email_conflict` |
| Fixation | OK | `establish` revoke id cũ, cấp id mới |
| `prompt=login` | OK | Google `max_age=0` + `auth_time >= createdAt-60s`; GitHub start bị từ chối và nút ẩn |
| `max_age` khi KHÔNG có session IdP | 🟡 lỗ hổng (DEBT-189) | xem dưới |
| Lock | OK (TOCTOU nhỏ đã có DEBT-187) | `loginExisting`; int admin-lock |
| Race tạo user / orphan | OK (crash: DEBT-182) | compensation + test ×10; 🟡 lỗi trong lúc bù trừ, xem dưới |
| Fail-closed khi provider lỗi | OK | timeout 5s, `redirect:'error'`, non-2xx/JSON lỗi ⇒ 502, không session; JWKS timeout ⇒ 502 |
| Exposure | OK | `fail()` chỉ log `err.code`; audit không có providerId/email/token |
| `amr` | OK | server-set, không đọc từ request; code cũ ⇒ `['pwd']` |
| Rate limit | OK | bucket `federation` theo ip (+ cookie); ip luôn bị đếm nên xoay cookie không né được |

## 🟡 Nên sửa

🟡 **[BE] Bảo mật/OIDC: `max_age` bị phiên Google vượt qua khi chưa có session IdP (DEBT-189)**
`authorize.service.ts:201` + `maxAgeExceeded` (dòng 493): khi `session === null`, `max_age=N` (không kèm `prompt=login`) **không** sinh `reauthAfter`. Hệ quả là `federation.service.ts:82` coi `reauth=false`, nên không gửi `max_age` sang Google và không kiểm `auth_time` của Google. Sau đó `establish` đặt `authTime = now`.
Vì sao: với login local, "không có session" nghĩa là user phải gõ mật khẩu ngay lúc đó, nên giả định cũ đúng. Với federation, Google có thể SSO im lặng bằng một phiên đăng nhập từ nhiều tuần trước, nhưng ID token của ta vẫn ghi `auth_time` = bây giờ. RP gửi `max_age=300` sẽ tin rằng user vừa xác thực trong 5 phút. Đây là "bịa" độ mới, trái với nguyên tắc "never fabricate auth_time" của chính codebase. Step-up admin dùng `prompt=login&max_age=0` nên **không** bị ảnh hưởng, vì vậy đây không phải 🔴.
Đề xuất (cân nhắc): lưu `maxAge` vào `AuthorizeRequestContext`. Ở `start`, nếu context có `maxAge` thì gửi `max_age=<maxAge>` cho Google và yêu cầu `auth_time*1000 >= now - maxAge*1000 - skew`. GitHub thì ẩn/từ chối như F8. Một cách gọn hơn là đặt `reauthAfter` cho mọi context có `max_age`, kể cả khi `session === null`: login local không đổi hành vi (session mới luôn mới), còn federation tự đi nhánh F8. Thêm int: `max_age=60`, không session, Google `auth_time` cũ ⇒ từ chối.

🟡 **[BE] Lỗi ở bước bù trừ che lỗi gốc và để lại user mồ côi (mở rộng DEBT-182, ghi vào DEBT-190)**
`federation.service.ts:221-226`: nếu `deleteMembership`/`deleteById` ném lỗi (Mongo chập chờn đúng lúc), lỗi gốc của `link` bị mất. User vừa tạo vẫn còn (có email, không có FI), nên lần sau user đó vào nhánh `email_conflict` vĩnh viễn, đúng triệu chứng DEBT-182.
Đề xuất: bù trừ best-effort (`Promise.allSettled`), log mã cố định khi bù trừ thất bại (không log email), rồi ném lại lỗi gốc.

🟡 **[BE] Ponytail (DEBT-190)**: xem mục ✂️.

## 💭 Nit

- `federation.client.ts:102`: không kiểm `azp`. Với code flow lấy token trực tiếp qua TLS và `aud` đơn của Google thì rủi ro thấp. Nếu muốn chặt hơn: khi `aud` là mảng, yêu cầu `azp === clientId`.
- `provider-http.ts:147`: `res.json()` không giới hạn kích thước body. Host đã cứng nên chấp nhận được; có thể đọc text và chặn khoảng 64KB trước khi parse.
- `federation.client.ts:110`: lỗi mạng JWKS khác timeout (ECONNREFUSED, 5xx) bị trả `invalid_identity` (400) thay vì `provider_unavailable` (502). Chỉ lệch status/thông điệp, vẫn fail-closed.
- Thiếu test cho `redirect: 'error'` (provider trả 3xx ⇒ 502). Một case mock 302 là đủ để khoá hành vi chống SSRF qua redirect.
- `amr: ['fed']` không thuộc RFC 8176 (giá trị không đăng ký vẫn hợp lệ, nhưng nên ghi rõ trong discovery/docs cho RP).

## ✂️ Ponytail

- federation.service.ts:L26: delete: `FederationAuditContext` trùng `AuthContext` (`authentication.service.ts:35`). Import lại `AuthContext`.
- federation.service.ts:L190-L201: shrink: nhánh email trùng tự tra lại FI rồi `loginExisting`, lặp đúng `afterLostRace`. Thay bằng `try { return await this.afterLostRace(...) } catch { recordFailed; throw email_conflict }`, hoặc tách helper `winnerOrNull`.
- ui.controller.ts:L95: yagni: `@Optional()` registry chỉ phục vụ test compose thiếu module; production luôn có (`UiModule` import `FederationModule`). Nếu wiring hỏng, nút sẽ âm thầm biến mất. Nên bỏ `@Optional` và cho test override `FEDERATION_PROVIDERS` (hoặc import module), hoặc ít nhất ghi rõ đánh đổi trong DEBT.
- providers.ts:L83-L90: shrink: hai object trung gian `google`/`github` rồi spread. Gán trực tiếp `clientId: cfg.googleClientId ?? ''` và tính `enabled` từ hai field đó.
net: -15 lines possible.
