# Log — run 20 — bugfix (DEBT-067/029/039/007/021/053/061)

## 2026-10-13 — analyst (lượt 1)

- Preflight CodeGraph: v1.6.2, index up to date (158 file). Đọc STATUS, backlog (DEBT-007/021/029/039/053/061/062/067/068/069), run 19 tasks/test-report.
- Đối chiếu code thật — xác nhận là lỗi:
  - DEBT-067: `token.controller.ts:213–227` revoke trước `recordIssued failure` ⇒ revoke ném thì mất audit. Gộp DEBT-068 (`recordIssued` tự tính lại `refresh`).
  - DEBT-029/039: `/token`, `/revoke`, `/introspect` không gọi `RateLimitService`; Argon2 chạy mỗi request (kể cả client_id không tồn tại). Guard `@RateLimit` không thấy client_id trong Basic ⇒ đề xuất gọi `hit()` sau `resolveClientAuth`, trước `authenticate`.
  - DEBT-007: `local-key-provider.ts:56–78` rm PEM trước `writeState`; `writeState` không atomic.
  - DEBT-021: ngoài race, còn lỗi tuần tự — `nextVersion` chỉ tính từ credential active ⇒ revoke/expire version mới nhất rồi rotate ⇒ trùng version. Index `{clientId,version}` non-unique.
  - DEBT-061: mongoose 9.10.2 `syncIndexes` = `cleanIndexes` trước `createIndexes` ⇒ E11000 để lại `consents` không unique index.
  - DEBT-053: dòng `/introspect` trùng ở spec §11 còn; nhãn "(Task 3)" đã hết.
- Viết `tasks.md`: 5 task [BE] (T1 067+068, T2 029+039, T3 007, T4 021, T5 053+061 + ponytail rẻ). 7 quyết định mở D1–D7 (khoá/ngưỡng/cách dùng RateLimitService/body 429/fail-closed/`/revoke`/retry E11000).
- Hoãn run kế: DEBT-062+069 (ponytail đụng file T1/T2), DEBT-006 (trustProxy), DEBT-070/054.
- Bàn giao → **tech-lead**.
## 2026-10-13 10:50 — tech-lead
- Đã làm: đối chiếu code (CodeGraph) — 5 mục đều là lỗi thật; chốt D1–D7; đưa DEBT-006 (trustProxy) vào T2 bước 0; fold 6 chỉnh sửa vào tasks.md.
- File đổi: runs/20-bugfix/review-techlead.md, runs/20-bugfix/tasks.md, backlog.md (DEBT-071/072), STATUS.md
- Kết quả: PASS — kèm fold: rate limit failure-only (peek/hit) trong ClientAuthenticationService, 1 bucket chung; createSecret phải dùng nextVersion (unique index làm vỡ introspect.int-spec); bỏ GC PEM mồ côi (race).
- Bàn giao: backend-dev — T1 → T2 (bước 0 trustProxy trước) → T3 → T4 → T5.
## 2026-10-13 10:52 — backend-dev (T1)
- Đã làm: DEBT-067 — bọc try/catch quanh revokeFamilyForEndedSession trong nhánh !live, ghi recordIssued(failure session_ended) best-effort rồi rethrow (không finally). DEBT-068 — recordIssued nhận refresh:boolean từ caller (!!familyId), không tự tính lại.
- File đổi: token.controller.ts, token.service.ts, token.service.spec.ts, test/token.int-spec.ts
- RED: DEBT-067 int ⇒ failures.toHaveLength(1) fail (0 audit vì revoke ném trước). GREEN sau fix.
- Kết quả: DONE — int token.int-spec 87/87 (gồm DEBT-067/068 mới), unit token.service.spec 20/20, typecheck+lint sạch 4 file.
- Bàn giao: tiếp T2 (bước 0 trustProxy).

## 2026-10-13 11:25 — backend-dev (T2)
- Đã làm: Bước 0 DEBT-006 parseTrustProxy (false mặc định, từ chối true/IP sai) + wire main.ts/validation/config/.env.example. Rate limit failure-only trong ClientAuthenticationService.authenticate(input,{ip}): peek 2 khoá (ip IP_MAX, clientId|ip CLIENT_MAX) trước Argon2, hit khi invalid_client; 429 temporarily_unavailable + Retry-After + no-store; Redis lỗi ⇒ 500; none bỏ qua. RateLimitService.peek (>=) + keysFor tách dùng chung với hit (>). 2 controller map 429.
- File đổi: trust-proxy.ts(+spec), validation.schema.ts(+spec), configuration.ts, main.ts, client-authentication.service.ts, rate-limit.service.ts, token.controller.ts, token.errors.ts, introspect.controller.ts, .env.example; test modules token/introspect/refresh-token/session-reflection/clients (chữ ký+security cfg+RateLimitService), rate-limit.int-spec (peek), client-auth-rate-limit.int-spec (mới, a–j + trustProxy).
- RED: 4 wrong-secret ⇒ Argon2 vẫn chạy (không chặn) trước fix. GREEN sau.
- Kết quả: DONE — int 427/427 (22 suites), unit trust-proxy 7/7, validation 20/20. exit-1 cuối là pre-existing (baseline cũng exit-1, xác minh bằng git stash).
- Bàn giao: tiếp T3 (LocalKeyProvider.rotate atomic).

## 2026-10-13 11:40 — backend-dev (T3)
- Đã làm: DEBT-007 — rotate() ghi writeState(next) TRƯỚC khi xoá PEM cũ; removePem best-effort (warn normal / error emergency, chỉ kid). writeState atomic: ghi keys.json.<uuid>.tmp (0600) rồi rename; rename lỗi ⇒ rm tmp + rethrow. KHÔNG GC PEM mồ côi (fold — tránh race rolling deploy).
- File đổi: local-key-provider.ts, keys.spec.ts (+4 test DEBT-007)
- RED: stash fix provider ⇒ 3 test DEBT-007 fail (getSigningKey ENOENT sau writeState lỗi). GREEN sau khi pop.
- Kết quả: DONE — keys.spec 32/32; test PEM lạ không bị đụng; rm lỗi ⇒ rotate vẫn resolve + warn.
- Bàn giao: tiếp T4 (rotateSecret/createSecret nextVersion + unique index).

## 2026-10-13 11:55 — backend-dev (T4)
- Đã làm: DEBT-021 — insertNextVersion(clientId,secretHash) dùng chung createSecret+rotateSecret: findOne({clientId}).sort(version:-1)+1, create, E11000 ⇒ tính lại + retry đúng 1 lần, lần 2 rethrow. createSecret bỏ hardcode version:1. Index {clientId,version} unique.
- File đổi: client-credential.service.ts, schemas/client-credential.schema.ts, test/clients.int-spec.ts (concurrent sửa + sequential/expired/createSecret-twice), test/indexes.int-spec.ts (unique + E11000 CC)
- RED: stash fix ⇒ 4 test DEBT-021 fail (createSecret v1 trùng; nextVersion từ active trả v2 lặp; không unique). GREEN sau pop.
- Kết quả: DONE — clients 42/42, indexes 17/17, introspect 32/32 (createSecret nhiều lần không còn E11000).
- Bàn giao: tiếp T5 (spec §11 + runbook).

## 2026-10-13 12:15 — backend-dev (T5)
- Đã làm: DEBT-053 — xoá dòng /introspect trùng ở spec §11 (còn đúng 1), thêm văn bản rate limit vào /token, /revoke, /introspect. DEBT-061 — runbook §2b mục phục hồi E11000 (consents mất unique index, model sau chưa sync, không xoá doc, 5 bước) + §2d ClientCredential unique + §4 bước 2' + §5 TRUST_PROXY. Ponytail: introspect/userinfo truyền this.sessions thay vì wrapper isEnded.
- File đổi: spec.md, runbook-deploy.md, introspect.controller.ts, userinfo.controller.ts, test/indexes.int-spec.ts
- Kết quả: DONE — grep /introspect table=1, Task=0. Full: unit 159/159, int 431/431 (22 suites, 0 FAIL). typecheck+lint sạch. exit-1 int pre-existing (baseline xác minh).
- Bàn giao: senior-reviewer — 5/5 task [BE], 590 test pass (+35 so với 555). KHÔNG commit.

## 2026-10-13 12:40 — senior-reviewer
- Đã làm: review 5 task [BE] run 20, đối chiếu tasks.md (bản fold) + review-techlead.md. Tự chạy lại: unit 159/159, int 431/431, tsc 0 lỗi. Chạy 18 mutation (khôi phục byte-identical, so hash) + thực nghiệm race song song (test tạm đã gỡ).
- Kết quả: **REJECT** — 🔴1 race peek→hit không có cận trên (CLIENT_MAX=3: 200 request song song ⇒ 200 lần Argon2, 0 lần 429); 🔴2 `parseTrustProxy` nhận `0.0.0.0/0`/`::/0` (tương đương `true`). 8 mục 🟡 (main.ts đọc TRUST_PROXY trước khi .env được nạp; findByClientId chạy trước peek; thiếu test (h), (j) yếu, retry E11000/tmp+rename/emergency-error chưa test — M5/M11/M15/M16 sống). T1/T3/T4/T5 đạt về hành vi.
- File: runs/20-bugfix/review-senior.md
- Bàn giao: tech-lead chốt cách sửa 🔴1 (reserve-then-refund hoặc semaphore Argon2 theo IP) → backend-dev sửa 🔴 + 🟡 → senior-reviewer vòng 2.

## 2026-10-13 13:10 — tech-lead (retry 1)
- Đã làm: CodeGraph sync; đọc review-senior + code (`client-authentication.service.ts`, `rate-limit.service.ts`, `trust-proxy.ts`, `main.ts`, `config.module.ts`). Thử nhanh: `process.loadEnvFile` không ghi đè env thật; `@fastify/proxy-addr` `::ffff:0:0/96` tin mọi IPv4.
- Quyết định: 🔴1 ⇒ (a) reserve-then-refund atomic (1 Lua, 2 khoá cùng hash tag `{sha256(ip)}`, reserve trước `findByClientId`, refund khi thành công, refund lỗi ⇒ warn + 200; xoá `peek`). 🔴2 ⇒ từ chối prefix < 8 (v4/v6), IPv4-mapped < /104, hop > 10. 🟡: tất cả bắt buộc; `main.ts` nạp `.env` sớm + check nhất quán.
- File: runs/20-bugfix/tasks.md (fold retry 1, Task 2 → [ ]), runs/20-bugfix/review-techlead.md (bổ sung), backlog.md (DEBT-073).
- Bàn giao: backend-dev retry 1 → senior-reviewer vòng 2.

## 2026-10-13 12:55 — backend-dev (retry 1)
- R1: reserve-then-refund atomic ? Lua `rateLimitReserve` (kiem moi khoa truoc, vuot nguong ? blocked khong INCR; else INCR+PEXPIRE lan dau) + `rateLimitRefund` (DECR khi ton tai & >0). Khoa cung hash tag `{sha256(ip)}`. Bo `peek()`. `authenticate`: reserve TRUOC findByClientId; success ? refund best-effort (warn). File: rate-limit.service.ts, client-authentication.service.ts.
- R2: trust-proxy.ts ? tu choi CIDR prefix <8 (v4/v6), IPv4-mapped prefix <104, hop >10. R3: main.ts loadEnvFile('.env') som + assertTrustProxyConsistent (reader cho app.trustProxy). Nit: writeFile(tmp) vao try; them seam atomicRename.
- R4 test: (k)N=50 ? verifySecret dung CLIENT_MAX, (k-variant) IP_MAX, (l),(m),(n),(o),(p); (j) viet lai (M5 chet); (h) INV-13; (f) IP2+secret dung; DEBT-021 retry E11000 + 2x nem (M11); keys atomic rename (M15) + emergency error (M16); DEBT-067 double-throw. noRateLimit mock ? reserve/refund.
- Verify THAT: tsc 0, eslint 0, unit **165/165**, int **442/442** (22 suites, exit 0). Tong **607** (baseline 555, +52).
- Mutation (khoi phuc byte-identical, so sha256 truoc/sau khop):
  - M-R1: bo kiem nguong + luon INCR trong `rateLimitReserve` ⇒ (k)/(k-variant)/(a)/(b)/(d)/(e)/(g)/(o)/(h)/TRUST_PROXY fail (11 fail). ☠️ bat.
  - M-R2: lam yeu guard IPv4-mapped (`bits < 0`) ⇒ test "rejects mapped /96" fail. ☠️ bat.
- Bug trong qua trinh: (j) ban dau fill IP bang cung client ⇒ client bucket trip o CLIENT_MAX<IP_MAX; sua = xoay client_id. (h) token issuance can `resource` ⇒ doi sang chung minh INV-13 truc tiep bang `codeSvc.consume` (code con nguyen sau 429, single-use). clients.int-spec thieu `import {jest}`.
- Ban giao: senior-reviewer luot 2. KHONG commit.

## 2026-10-13 13:50 — senior-reviewer (lượt 2)
- Đã làm: CodeGraph sync; tự chạy unit 165/165, int 442/442, tsc 0, eslint 0. 10 mutation (M1–M3, M4b, M5–M10), tất cả ☠️ bị bắt, khôi phục byte-identical (so sha256). Thử thật `loadEnvFile` (không ghi đè env thật) và `@fastify/proxy-addr` với các cách viết TRUST_PROXY.
- Kết quả: **REJECT** — 🔴 `isMappedV4` chỉ khớp chữ `::ffff:` ⇒ `0:0:0:0:0:ffff:0:0/96`, `::0:ffff:0:0/96`, `0::ffff:0.0.0.0/96` được chấp nhận mà proxy-addr lại tin mọi IPv4. R1 (Lua reserve/refund, cùng slot, TTL, không reset được bằng cách xen kẽ đúng/sai), R3, R4 đều đạt. 🟡: `assertTrustProxyConsistent` chưa có test.
- File: runs/20-bugfix/review-senior.md
- Bàn giao: backend-dev — chuẩn hoá IPv6 trước khi phân loại mapped (ipaddr.js `isIPv4MappedAddress`) + unit test 4 cách viết + test cho assertTrustProxyConsistent → senior-reviewer lượt 3 (chỉ kiểm phần trust-proxy).
## 2026-10-13 14:05 — backend-dev (retry 2)
- 🔴 fix: `parseTrustProxy` (trust-proxy.ts) không còn regex `/^::ffff:/` trên chuỗi thô. Dùng `ipaddr.parseCIDR` + `kind()`/`isIPv4MappedAddress()` (chính thư viện `@fastify/proxy-addr@5.1.1` dùng) để phân loại trên địa chỉ đã chuẩn hoá; áp cho MỌI kiểm tra prefix. 4 cách viết IPv6 tương đương (`0:0:0:0:0:ffff:0:0/96` v.v.) nay bị từ chối; `0:0:0:0:0:ffff:a00:0/104` được chấp nhận.
- Dep: thêm `ipaddr.js@2.5.0` làm dependency trực tiếp của `be/` (khớp version proxy-addr dùng; lockfile cập nhật dòng importer của be).
- Test mới (trust-proxy.spec.ts, +5): 4 cách viết → throw; long-form /104 → accept; cross-check `trustsCandidate` (mô phỏng match của proxy-addr dùng chính ipaddr.js) cho MỌI entry được chấp nhận → public IP `203.0.113.9` KHÔNG được tin; 🟡 `assertTrustProxyConsistent` 2 case (đồng ⇒ không throw; lệch ⇒ throw).
- Mutation (khôi phục byte-identical sau đó): khôi phục regex thô `/^::ffff:/` ⇒ test "equivalent IPv6 forms" FAIL (1 failed/16). ☠️ bị bắt. Khôi phục xong 16/16 PASS.
- Verify THẬT: tsc 0, eslint 0, unit **170/170** (17 suites), int **442/442** (22 suites), đều exit 0. Tổng **612**.
- Fix encoding: dòng log retry 1 `12:55 ? backend-dev` → em dash UTF-8.
- Bàn giao: senior-reviewer lượt 3 (chỉ kiểm trust-proxy). KHÔNG commit.
## 2026-10-13 14:40 — senior-reviewer (lượt 3)
- Đã làm: CodeGraph sync. Fuzz ~75 giá trị TRUST_PROXY qua `parseTrustProxy` thật, đối chiếu `@fastify/proxy-addr@5.1.1` thật và `FastifyAdapter` thật. Mutation M11 (regex thô) ☠️ 1/16, khôi phục byte-identical (sha256 4042AB60…). Tự chạy tsc 0, eslint 0, unit 170/170. Int không chạy lại (container test đang dùng).
- Kết quả: **REJECT**. 🔴 lượt 2 ĐÃ ĐÓNG: không còn cách viết IPv4-mapped/compatible/zone/khoảng trắng/nhiều mục nào được chấp nhận mà khiến proxy-addr tin IPv4 public. 🔴 MỚI: `TRUST_PROXY=<n>` được chấp nhận, nhưng fastify@5.12.5 `getTrustProxyFn` với number ⇒ luôn `false` (đã thử: `trustProxy:1` ⇒ `req.ip`=socket). Theo runbook/.env.example thì sau proxy mọi client chung IP ⇒ ai cũng khoá được client auth, và không có cảnh báo nào. Lỗi có từ lượt 1; lượt 1–2 senior bỏ sót.
- 🟡: `010.0.0.0/8` được chấp nhận nhưng thực tế là 8.0.0.0/8 (nhánh CIDR không kiểm dạng IPv4 chuẩn); `trustsCandidate` chép tay proxy-addr; `","` ⇒ `[]`.
- File: runs/20-bugfix/review-senior.md
- Bàn giao: backend-dev retry 3 — từ chối hop count (khuyến nghị) + sửa runbook/.env.example/AC; kiểm dạng IPv4 chuẩn ở nhánh CIDR; test qua FastifyAdapter/proxy-addr thật. Tech-lead ghi 1 dòng xác nhận bỏ hop count. Sau đó → senior lượt 4 (chỉ trust-proxy).
## 2026-10-13 14:41 — backend-dev (retry 3, +1 lượt ngoài giới hạn)
- 🔴 BỎ hop count: parseTrustProxy (trust-proxy.ts) throw với giá trị dạng số (thông báo hướng dẫn dùng IP/CIDR vì fastify@5.12.5 getTrustProxyFn fail-closed với number). Bỏ MAX_HOPS, nhánh 
umber; type alse | string[]; bỏ cast ở main.ts + int-spec. configuration/validation.schema cập nhật theo. Orchestrator chốt 1 dòng ở review-techlead.md "Bổ sung — retry 3".
- 🟡1: nhánh CIDR thêm isIP(entry.slice(0,slash)) trước parseCIDR ⇒  10.0.0.0/8, x7f.0.0.1/8,127.1/8 bị từ chối (trước đó bị chuẩn hoá thành 8.0.0.0/8 public). 🟡3: danh sách rỗng sau tách (,) ⇒ throw.
- 🟡2: xoá 	rustsCandidate chép tay; dùng @fastify/proxy-addr thật (resolve qua fastify) + test qua FastifyAdapter thật (inject XFF, kiểm eq.ip: 127.0.0.1⇒198.51.100.7; 10.0.0.0/8 từ loopback⇒socket). Docs: runbook §5, .env.example, AC tasks.md.
- Mutation (khôi phục byte-identical, sha256  731df6d…0002 trước=sau): (A) khôi phục số ⇒ 2 test FAIL (unit numeric + FastifyAdapter numeric); (B) bỏ isIP CIDR ⇒ test  10.0.0.0/8 FAIL. ☠️ đều bị bắt.
- Verify THẬT: tsc 0, eslint 0, unit **175/175** (17 suites), int **442/442** (22 suites). (int: ELIFECYCLE teardown ioredis "Connection is closed" như cũ, không phải test fail.)
- Bàn giao: senior-reviewer lượt 4 (chỉ trust-proxy). KHÔNG commit.

## 2026-10-13 15:30 — senior-reviewer (lượt 4, +1 ngoài giới hạn)
- Đã làm: CodeGraph sync. Thử 44 giá trị TRUST_PROXY qua `parseTrustProxy` → `FastifyAdapter` thật → `inject` (đọc `req.ip`); 12 danh sách qua `@fastify/proxy-addr@5.1.1` thật (keyword `loopback`/`uniquelocal`/`linklocal`, danh sách trộn, IPv6/zone/mapped, `::/8`…`::/95`, prefix lạ). Mutation B (bỏ isIP) ☠️, C (bỏ throw danh sách rỗng) ☠️, A′ (bỏ regex số) sống nhưng an toàn (isIP vẫn từ chối); khôi phục byte-identical (sha256 0731DF6D…0002). tsc 0, eslint 0, unit 175/175, int client-auth-rate-limit 16/16.
- Kết quả: **PASS**. 🔴 lượt 3 đóng (số ⇒ throw có hướng dẫn); 🟡1 (octal CIDR), 🟡2 (lib thật + FastifyAdapter), 🟡3 (`,` ⇒ throw) đóng. Keyword proxy-addr bị từ chối ⇒ đúng (không phân loại được; dùng CIDR tương đương). Không giá trị nào được chấp nhận mà tin IP public v4.
- 🟡 mới: comment `validation.schema.ts:72–73` còn "or a hop count" ⇒ DEBT-074. Nit hoãn `/introspect` 429 `error_description` ⇒ DEBT-075.
- File: runs/20-bugfix/review-senior.md, backlog.md
- Bàn giao: tester. KHÔNG commit.n## [2026-10-13 15:46] tester
- Đã làm: đối chiếu acceptance (gồm tech-lead fold + retry 1/3) ↔ code+test thật; xác minh risk matrix (reserve atomic song song, refund, 429 3 endpoint, không khoá client ở IP khác (f), 429 không consume code, Redis→500, TRUST_PROXY qua FastifyAdapter+proxy-addr thật, DEBT-067 audit, key rotate atomic, insertNextVersion+unique index). Sửa DEBT-074 (comment validation.schema.ts, 0 đổi hành vi).
- File đổi: be/src/config/validation.schema.ts (comment), runs/20-bugfix/test-report.md (mới), backlog.md (DEBT-074→đóng), STATUS.md.
- Kết quả: PASS — 617/617 (unit 175 + int 442), tsc 0, eslint 0. (int in [ELIFECYCLE] exit 1 = teardown jest --runInBand, 0 test fail.)
- Bàn giao: orchestrator — đóng run 20, rồi commit.

## [2026-10-13] orchestrator
- Đã làm: chọn phương án 1 (cho thêm 1 lượt sửa ngoài giới hạn, bỏ hop count TRUST_PROXY); commit code `08adee8`; viết `summary.md`; cập nhật `STATUS.md`; chuyển DEBT đã xử lý sang bảng Đã đóng.
- Kết quả: DONE — run 20 đóng.
