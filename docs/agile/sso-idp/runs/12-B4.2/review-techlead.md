# Tech Lead Review — 2026-10-08 (run 12 — B4.2 Consent)

## Kết luận: PASS

Q1/Q4 đúng cho production; tasks.md B4.2a/B4.2b khả thi, atomic, đúng thứ tự phụ thuộc, security invariants đầy đủ và đo được. Hai bổ sung nhỏ (success-case + normalization) đã được thêm trực tiếp vào acceptance criteria của tasks.md (analyst được ủy quyền) — không chặn triển khai.

## Thẩm định quyết định Q1/Q4 (được ủy quyền override — KHÔNG override)

**Q1 — Consent key = `user × client × resource`, sentinel `resource=""`: ĐÚNG, giữ nguyên.**
- Nhất quán với invariant đã có: `/authorize` bind đúng 1 `resource` (`resolveResource` → `string | undefined`, INV-14/15). Consent tính theo resource ⇒ scope-audience đúng boundary, revoke/version độc lập từng resource — chuẩn RFC 8707.
- Tenant không cần trong key: `Client.tenantId` bắt buộc (1 client ⇒ 1 tenant), đưa vào là thừa. Đúng.
- Sentinel `""` cho public client (không gửi `resource`) giữ 1 unique index, tránh null-collision của Mongo partial/sparse. Hợp lý production (Mongo unique index coi nhiều `null` là trùng → sentinel né được).

**Q4 — D3 (step-up max_age/auth_time) + D7 (offline_access ⇒ refresh_token): ĐÚNG, giữ nguyên.**
- Khớp OIDC Core (`prompt=login`/`max_age` re-auth; `auth_time` claim) và §offline_access (refresh token chỉ khi client có grant `refresh_token` VÀ scope gồm `offline_access`).
- Ghi chú `Client.grantTypes[]` còn thiếu, đẩy sang B4.4 — đúng phạm vi, B4.2 không đụng. OK.
- Không ảnh hưởng B4.2 (step-up/refresh là B4.4); việc chốt sớm là hợp lý để tránh rework schema.

## Điểm mạnh
- Tái dùng hạ tầng đã kiểm chứng: `AuthorizeRequestContextService.consume` (single-use, Lua atomic) + `AuthorizationCodeService.create/consume` (INV-13, bind clientId/redirectUri). Không phát minh lại.
- Chống tráo tham số đúng: `redirect_uri/state/scope/resource/client_id` khi issue code lấy từ ctx đã lưu, KHÔNG từ body POST — đối xứng resume B4.1.
- Mô hình CSRF nhất quán: identity = session cookie (đã verify ở `ui.controller.identity()` + `CsrfGuard`), nên `_csrf = CsrfService.token(session)` khớp guard khi user đã signed-in.
- Security gate đủ: actor/owner/cross-tenant, state transition, replay (ctx single-use), IDOR, prompt=none fail-closed, exposure budget (INV-20 redact code/_csrf/nonce/code_challenge). Có acceptance âm đo được.
- Đóng DEBT-022 (gộp type Fastify req/reply) + chứng minh DEBT-015 (form-action self: POST same-origin rồi redirect GET) bằng test — dọn nợ đúng lúc.

## Vấn đề (đã xử lý trong run này, không chặn)
- (đã thêm) Thiếu success-case `prompt=none` + đã covered → PHẢI issue code (không error). Đã bổ sung acceptance.
- (đã thêm) Normalization `resource: undefined → ""` tại ranh giới gọi ConsentService: `/authorize` dùng `undefined`, store dùng sentinel `""`. Phải chuẩn hóa 1 điểm, test public-client. Đã bổ sung acceptance.

## Đề xuất (không bắt buộc — vào backlog nếu bỏ qua)
- Nhánh "đã covered" gọi `createContext` trong `handle()` rồi consume ngay trong cùng request: chấp nhận được cho walking skeleton, nhưng cân nhắc đường tắt (issue code không qua ctx) ở B4.4 để tránh 1 cặp write/consume Redis thừa mỗi lần. Không làm ở B4.2.
- Config version hiện hành (`policyVersion`/`termsVersion`) đọc từ env: đảm bảo có giá trị mặc định + validate khi khởi động (fail-fast nếu thiếu) để không auto-approve do version rỗng khớp rỗng.
- Khi `grant` union scope: đảm bảo không giữ lại scope cũ đã bị client gỡ khỏi `client.scopes` (chỉ union trong phạm vi scope hợp lệ hiện tại) — tránh consent "phình" scope quá hạn.

## Bàn giao
PASS → **backend-dev**: triển khai B4.2a (store/service) trước, rồi B4.2b (wire + UI + issue code). Cả hai đều [BE].
