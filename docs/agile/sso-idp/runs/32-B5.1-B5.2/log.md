# Log — run 32 — B5.1 + B5.2 (federation: provider tĩnh + broker flow)

## orchestrator — 2026-10-19
- Mở M6. spec/plan có sẵn ⇒ tự sinh `tasks.md` từ plan §B5 (B5.1, B5.2), spec §9.9, §9.1, INV-23, X4 (mock provider). B5.3 (account linking) + X4 E2E → run 33. Cổng → tech-lead.

## tech-lead — 2026-10-19
- **PASS có điều kiện**: fold F1–F16 vào `tasks.md` (bắt buộc). Xem `review-techlead.md`.
- Đối chiếu code a299314: FederatedIdentity schema/service + unique index đã có (B2.2) ⇒ Task 3 thu nhỏ (index `userId` + `lastLoginAt`); `FederationModule` stub chưa import; env `GOOGLE_*/GITHUB_*` đang bắt buộc + placeholder trong `.env.example` ⇒ đổi optional/rỗng (F4).
- Chỉnh thiết kế: callback KHÔNG consume `AuthorizeRequestContext`, chỉ establish session rồi 302 `/authorize?request_id` (tái dùng resume: reauth, consent, echo state) (F6); bỏ nới CSP cho provider (F12); cookie binding `idp_fed` chống login CSRF (F5); provisioning có bù trừ race + chặn user bị khoá (F7); reauth: Google `max_age=0` + `auth_time`, GitHub ẩn khi `reauthAfter` (F8); đóng DEBT-030 `amr` trong run này (F10).
- Q-32.1: DI `FEDERATION_PROVIDERS` + `overrideProvider` trong int-test, mock `node:http` 127.0.0.1; không provider mock trong src. Q-32.2: verify ID token qua JWKS cứng (`jose`), không userinfo. Q-32.3: `DEFAULT_TENANT_ID`, `emailVerifiedAt=now`, không password. Q-32.4: vừa 1 run sau khi cắt.
- Mở DEBT-182…186. Chuyển → **backend-dev** (Task 1 → 3 → 2 → 4).

## backend-dev — 2026-10-19
- Trust boundary: tài sản = session IdP/user/FI; actor = user, kẻ tấn công login-CSRF/mix-up/replay, provider lỗi. State `fed_state:{sha256}` Lua GET+DEL TRƯỚC mọi kiểm; cookie `idp_fed` (sha256, so constant-time); mọi lỗi = trang first-party (fail-closed, không session, không redirect RP); exposure: log chỉ mã cố định, audit chỉ `{provider,newUser}`.
- T1: `federation/providers.ts` (hằng https + DI `FEDERATION_PROVIDERS`, enabled khi đủ cặp), `provider-http.ts` (timeout 5s, `redirect:'error'`, không retry), Google verify ID token jose (iss/aud/exp±60s/nonce/RS256, `auth_time` khi reauth), GitHub id số + email primary&verified; env optional, nửa cặp ⇒ boot fail; `.env.example` để trống. T3: index `{userId:1}` + `touchLastLogin`. T2: start/callback, provisioning + bù trừ race, lock, reauth, `amr` (đóng DEBT-030). T4: nút `<a>` chỉ khi enabled + context login, GitHub ẩn khi `reauthAfter`; CSP không đổi. `UiController` inject registry `@Optional` (10 int-spec cũ không phải sửa).
- Lệch nhỏ: User E11000 mà FI chưa có ⇒ 503 "thử lại" (thay vì 409); nhánh email trùng đọc lại FI theo providerId trước khi báo 409 (DEBT-188). Static check src/federation (unit) thay cho grep tay.
- Verify: typecheck/lint sạch; unit 303/303 (+32); int 762/762 (+32; `federation.int-spec` 31); E2E 12/12 (`e2e/config/env.ts`: GOOGLE_/GITHUB_ = "" để hermetic). Smoke `dist/main.js` env tường minh: nửa cặp ⇒ boot lỗi nêu biến; không creds ⇒ /login không nút, /auth/* 404; có Google ⇒ start 400 context_expired.
- Mutation F15 (sao lưu cp + sha256 khớp sau khôi phục): bỏ binding ⇒ RED 1; bỏ kiểm provider ⇒ RED 1; consume sau exchange ⇒ RED 2; bỏ bù trừ ⇒ RED 1 (race email khác nhau); bỏ `lockedUntil` ⇒ RED 1.
- ⚠ `be/.env` (dev) đang có placeholder `your-*` cho 4 biến GOOGLE_/GITHUB_ ⇒ nay BẬT provider với credential rác ⇒ người dùng cần đặt rỗng (không sửa hộ). Mở DEBT-187/188. Cổng → **senior-reviewer**.

## senior-reviewer — 2026-10-19
- **PASS** (không 🔴). Xem `review-senior.md`. Verify tại chỗ: typecheck sạch, unit 303/303, int `federation`+`indexes` 49/49 (vg-test-*); không E2E, không gọi provider thật.
- Lượt invariant: INV-23 (registry hằng + DI, fetch chỉ ở helper), state consume trước mọi kiểm, binding `idp_fed` constant-time, mix-up/`iss`, redirect chỉ từ record, Google ID token (RS256/iss/aud/exp/nonce), GitHub primary+verified, không auto-link, fixation (`establish`), `prompt=login` (Google max_age=0 + auth_time, GitHub chặn), lock, race/bù trừ, exposure, `amr` — OK.
- 🟡 mở **DEBT-189** (`max_age` khi chưa có session IdP không ép Google re-auth ⇒ `auth_time` bị làm mới), **DEBT-190** (bù trừ ném lỗi che lỗi gốc + ponytail ~-15 dòng). 💭: `azp`, giới hạn body, JWKS lỗi mạng ⇒ 400, thiếu test 3xx, `amr:fed` không đăng ký RFC 8176.
- Cổng → **tester**.

## tester — 2026-10-19
- **PASS**. Xem `test-report.md`. typecheck/lint sạch; BE unit 303/303; BE int 780/780 (+18 tester trong `federation.int-spec.ts` › `tester risk matrix (run 32)`); FE 240/240; E2E 12/12 (:5173/:4000 trống, không phải kill gì). Mock `node:http`, không gọi provider thật.
- Ma trận rủi ro đã thêm: replay state song song ×6, query lặp, cookie `idp_fed` của trình duyệt khác, `error`+`code`, provider 3xx (token, GitHub `/user`), body 8 MB, emails sai kiểu/rỗng, JWKS lỗi, nonce/iss giả, email trùng không phân biệt hoa thường + local chưa verify, cùng id chéo provider + email chéo provider ⇒ 409, FI mồ côi, khoá brute-force, Redis/Mongo lỗi ⇒ 500 fail-closed, `max_age=0` khi có session.
- Mutation (cp + sha256 OK): `redirect:'follow'` ⇒ RED 2; consume không atomic ⇒ RED 1 (replay song song).
- **DEBT-189 xác nhận bằng test thật** (`max_age` 60/0 khi không có session IdP ⇒ không chuyển cho Google, ID token `auth_time≈now` với auth Google 30 ngày tuổi). **Chấp nhận 🟡** vì step-up hệ thống (`prompt=login&max_age=0`) không bị vượt, điều kiện khai thác cần sẵn phiên Google của nạn nhân, không cross-tenant/replay/rò secret. Phải đóng ở run 33, trước khi có RP chỉ dựa vào `max_age`. Test #18 đặc tả hành vi hiện tại, sẽ RED khi sửa.
- Mở DEBT-191. Cổng → **orchestrator** đóng run.

## orchestrator — 2026-10-19 (đóng run)
- Mọi cổng PASS. Commit `4c36371`.
