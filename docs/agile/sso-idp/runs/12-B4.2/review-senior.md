# Senior Review — 2026-10-08 (run 12 — B4.2 Consent)

## Kết luận: PASS

Không còn 🔴. Correctness/security/production-readiness đạt. 264/264 test xanh
(unit 67 + int 197), typecheck + lint sạch — mình chạy lại độc lập, không chỉ tin
report. Một 🟡 (race union scope trong `grant`) → DEBT-027; không chặn merge.

## Tổng quan
Triển khai bám sát tasks.md + review-techlead. Điểm tốt:
- **Chống tráo tham số đúng**: `redirect_uri/state/scope/resource/client_id` khi issue
  code luôn lấy từ `AuthorizeRequestContext` đã consume (approve path) hoặc từ request
  đã validate (covered path) — KHÔNG từ body POST. `decideConsent` chỉ nhận `request_id`
  + `approve` từ body. Test `approve => code bound client/uri` chứng minh.
- **Replay fail-closed**: `contexts.consume` single-use (Lua atomic, đã kiểm ở B4.1);
  approve lần 2 cùng `request_id` → ctx null → trang expired, KHÔNG issue code lần 2.
- **CSRF nhất quán**: identity = session cookie; render dùng `csrf.token(sessionId)`,
  `CsrfGuard` verify cùng token bằng `constantTimeEqual`. Thiếu/sai `_csrf` → 403.
- **prompt=none fail-closed cả 2 chiều**: chưa covered → `consent_required` error (no UI);
  đã covered → issue code (success OIDC Core). Cả hai có test.
- **Open-redirect**: `redirect_uri` resolve+validate TRƯỚC (Phase 1); lỗi ở đây ném
  `AuthorizeErrorPage` (trang first-party, không redirect). `buildRedirect/URL` chỉ chạy
  trên `redirect_uri` đã tin cậy.
- **XSS**: `consent.eta` dùng `<%= %>` với Eta `autoEscape:true` (main.ts) → clientId/
  resource/scopes phản chiếu được escape.
- **Exposure**: audit `recordAuthorize/recordConsent` không log code/nonce/state/
  code_challenge; metadata chỉ `{outcome}`. Test audit "no sensitive values" xanh.
- **Fail-closed version**: env `CONSENT_*_VERSION` `z.string().min(1).default('1')` →
  không auto-approve do version rỗng khớp rỗng (đúng đề xuất tech-lead).
- **Scope không phình**: `grant` bound union bằng `allowedScopes` (client.scopes hiện
  hành) → scope client đã gỡ không carry-forward. Có test.
- Index đổi sang `{userId,clientId,resource}` unique; `indexes.int-spec` (kiểm index thật
  trên Mongo) xanh — index cũ đã bỏ.

## Security invariants / trust boundaries đã kiểm
- Identity/authn: consent owner = `session.userId` (liveSession đọc từ cookie→SessionService),
  KHÔNG bao giờ từ input. POST re-verify session; mất session → `/login`, không code (test 684).
- Authz/IDOR/cross-tenant: `find/grant` khóa theo `userId` session + `clientId` từ ctx;
  tenant suy từ client. Không có đường client/user khác đọc/ghi consent owner.
- State/concurrency: ctx single-use; covered path không tạo ctx thừa (đi thẳng issueCode).
- Chuỗi request: resume + consent giữ đúng `request_id`; redirect cuối có `iss` (RFC 9207),
  `state` echo nguyên vẹn.
- Failure: client biến mất giữa chừng → `access_denied` về redirect_uri đã lưu (fail-closed).
- Boundary: prompt validate (none không kết hợp); max_age validate; resource resolve qua
  identifier→resourceId (không so URI trực tiếp).

## 🔴 Blocker
- (không có)

## 🟡 Nên sửa
- **Race union scope trong `ConsentService.grant`** — consent.service.ts:~104-130.
  `grant` đọc `grantedScopes` bằng `findOne` rồi ghi `$set` ở `findOneAndUpdate` riêng →
  không atomic. Hai grant đồng thời cùng key (vd xin `openid` và `profile`) có thể
  last-writer-wins, mất 1 scope khỏi union. Test concurrency (consent.int-spec:68) chỉ
  assert `count==1`, KHÔNG assert union scope → không bắt được.
  Vì sao không 🔴: fail-closed — thiếu scope chỉ ép user re-consent, không bao giờ
  over-grant; và consent cùng user là tuần tự thực tế (hiếm concurrent). 
  Đề xuất: gộp thành 1 update atomic bằng `$addToSet` cho scope (lọc allowed trước) +
  `$pull`/pipeline update để drop scope ngoài allow-list, hoặc dùng update-pipeline
  (`$setIntersection/$setUnion`) trong 1 round-trip. → DEBT-027.
- **Comment lỗi thời** — consent.schema.ts:1 vẫn ghi "Granularity user × client (Q1 still
  open)" dù Q1 đã chốt = user×client×resource và index đã đổi. Sửa comment cho khớp.
- **Ops: drop index cũ khi deploy** — đổi unique index cần `db:sync-indexes` chạy để bỏ
  `{userId,clientId}` cũ; ghi chú trong runbook deploy (test đã lo môi trường test).
  → DEBT-028 (nhắc vận hành M3→M4).

## 💭 Nit
- `issueCode` và `issueCodeFromContext` gần trùng (chỉ khác nguồn params vs ctx); có thể
  gộp 1 helper nhận `CodeInput` — giữ riêng cũng chấp nhận được vì rõ ý.
- `decideConsent` trả object literal nhiều field optional (`code?/denied?`); union type
  rõ nghĩa hơn nhưng không đáng đổi.

## ✂️ Ponytail
- consent.service.ts:L104: shrink: bỏ `findOne` đọc trước trong `grant`. Thay bằng 1
  update-pipeline atomic (`$setUnion` lọc allowed) — cắt 1 round-trip + xóa cả race 🟡 ở trên.
- authorize.service.ts:L~360: shrink: gộp `issueCode`+`issueCodeFromContext` thành 1 helper
  `mint(input)` — 2 thân gần giống nhau.
net: -10 lines possible.
