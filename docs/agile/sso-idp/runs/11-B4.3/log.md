# Log — run 11 — B4.3 (AuthorizationCode store)

> Nhật ký ngắn theo thời gian. Mỗi mục ≤ 8 dòng.

## [2026-10-08 08:40] orchestrator — khởi tạo
- Mở run 11 cho B4.3. spec/plan đã có ⇒ bỏ qua analyst, sinh tasks.md từ plan §B4.3.
- Chọn B4.3 vì không bị chặn: B4.2 chờ Q1, B4.4 chờ Q4. Phụ thuộc B1.4 đã xong.
- Preflight CodeGraph: v1.6.2, sync OK. Cổng tiếp theo: tech-lead.

## [2026-10-08 09:05] tech-lead — review
- Preflight CodeGraph OK (v1.6.2, sync up to date). Đọc spec §9.1/9.5/§4/§10/§15, plan §B4.3, backlog DEBT-013.
- Kiểm code thật: Lua loader B1.4 (lua-loader.ts), crypto B1.5 (generateToken/sha256), pattern AuthorizeRequestContextService/SessionService (Redis Lua single-key, hash-based key, CSPRNG) — tasks.md khớp pattern.
- Verdict: **PASS** kèm 7 điều kiện (C1-C7): key theo hash không plaintext; Lua tên riêng 
umberOfKeys:1; SET NX PX khi tạo; 4 test integration bắt buộc (sai binding giữ code, concurrent 1 thắng, TTL thật, replay null); không log plaintext code; không bịa field ngoài spec.
- Phạm vi đúng (không đụng /authorize, /token), Cluster-safe (1 key, đúng note DEBT-013).
- Ghi eview-techlead.md. Chuyển sang backend-dev.

## [2026-10-08 08:50] backend-dev — triển khai
- Preflight CodeGraph OK (sync up to date). Đọc tasks.md + review-techlead.md (C1-C7), spec §9.1/9.5/§10, pattern `AuthorizeRequestContextService`/`SessionService`.
- Tạo `be/src/modules/oauth/code/authorization-code.service.ts`: key `authz_code:{sha256(code)}`, Lua `consumeAuthCode` (1 KEY, ARGV clientId/redirectUri, chỉ DEL khi khớp cả hai — đúng §9.5), `create` dùng `SET...PX 60000 NX`, payload đúng 7 field spec + `authTime` optional. Không log plaintext code.
- Wire `AuthorizationCodeService` vào `providers`+`exports` của `OauthModule`; KHÔNG đụng `/authorize`/`/token`.
- Boundary bảo mật: tài sản = authorization code (bearer, 1 lần, 60s); actor = RP tại `/token` (run sau); abuse case = client gửi `client_id`/`redirect_uri` sai để "tiêu" code hợp lệ của người khác (premature consumption/DoS) — chặn bằng Lua atomic chỉ DEL khi khớp cả hai, sai → trả null không xoá (INV-13); state transition pending→consumed hoặc pending→expired; fail-closed khi Redis lỗi (throw, không coi là "không có code").
- Test `be/test/authorization-code.int-spec.ts` (8 case, Redis thật @6479): payload+TTL+hash-key, sai clientId/redirectUri giữ code còn dùng được, 2 consume đồng thời chỉ 1 thắng, TTL thật ≤60000ms, hết hạn qua PEXPIRE 1ms thật (không sleep 60s) → null, consume 2 lần → null, code rỗng/không tồn tại → null.
- Verify: typecheck PASS, lint PASS (eslint --fix 2 lỗi prettier), unit 67/67 PASS, integration 174/174 PASS (12 suite, suite mới 8/8).
- Kết quả: DONE. Bàn giao: senior-reviewer — review service + test mới, đối chiếu C1-C7.

## [2026-10-08 08:56] senior-reviewer — review
- Preflight CodeGraph OK (sync, 3 file). Chạy lại toàn bộ: typecheck/lint PASS, unit 67/67, int 174/174 (suite mới 8/8) — khớp số dev khai.
- Verify Lua **độc lập** trên Redis thật (`SCRIPT LOAD`+`EVALSHA` tay qua `redis-cli`, ngoài code TS của dev): sai binding → nil, key còn `EXISTS=1`, consume đúng sau đó vẫn OK; đúng binding → DEL thành công; consume lần 2 → nil; key không tồn tại → nil an toàn; giá trị corrupt (không phải JSON thật qua API) → throw fail-closed, không lộ gì nhạy cảm.
- Concurrency: chạy **10 tiến trình `docker exec` độc lập song song** (PowerShell `Start-Job`) gọi `EVALSHA` cùng key → đúng 1 thành công — mạnh hơn yêu cầu C5(b), loại khả năng atomicity chỉ là artifact của Node event loop/ioredis pipelining.
- Đối chiếu C1-C7: tất cả đạt. Payload đúng 7 field spec §10 + `authTime` optional có giải thích. Không log/lộ plaintext code (đọc source + test quét toàn keyspace xác nhận). Phạm vi đúng: `AuthorizationCodeService` chỉ trong DI, chưa controller nào gọi (`usages_ide` xác nhận) — không đụng `/authorize`/`/token`.
- Ponytail: 1 phát hiện 🟡 (yagni) — `AuthCodeRedis` trùng `AuthzRedis` giữa 2 service, không đủ lớn để REJECT, ghi `DEBT-025` vào backlog (liên-file, để dành khi có script thứ 3).
- Verdict: **PASS**. Ghi `review-senior.md`. Chuyển sang tester.

## [2026-10-08 09:15] tester (orchestrator bổ sung — agent bị ngắt do lỗi model sau khi đã ghi test-report)
- Map đủ 8 AC → test; thêm 4 test (authTime round-trip/omit, CSPRNG distinct, 5 consume đồng thời). Không sửa code production.
- Kết quả: PASS — unit 67/67, int 178/178 (authorization-code 12/12). Xem `test-report.md`.

## [2026-10-08 09:25] orchestrator — đóng run
- Verify độc lập: typecheck/lint PASS, unit 67/67, int 178/178 → 245/245. Không còn file tạm.
- Đóng run 11, viết `summary.md`, cập nhật STATUS, commit.