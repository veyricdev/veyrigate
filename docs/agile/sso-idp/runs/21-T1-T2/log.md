# Log — run 21 — T1–T2 (scaffold fe-sso-test + OIDC client)

## 2026-10-13 — analyst: viết tasks.md

- Preflight CodeGraph OK (v1.6.2; index up-to-date, 161 files; `codegraph sync` → already up to date). Đọc code qua CodeGraph/Git Bash.
- Đọc: `spec.md` §7 (RFC 8707 resource), §9.1–9.2 (state/nonce/PKCE/resource binding), §9.8 (logout RP-initiated), §12 discovery, INV-6/7/9; `plan.md` §7 (Phase T: T1/T2/… ), §8 (X1), §9 (ma trận INV); `STATUS.md` (đang M4; B5/B6/B7/deploy còn nợ).
- Khám phá BE (kết quả quan trọng cho X1):
  - Discovery `/.well-known/openid-configuration` CÓ `end_session_endpoint`, `jwks_uri`, `userinfo_endpoint`, `token_endpoint_auth_methods_supported` gồm `none` (public client). (discovery.controller.ts)
  - CORS **động theo client** qua `Client.allowedCorsOrigins` (client-cors.service.ts, DEBT-019, spec §9.7) — KHÔNG có allowlist tĩnh `:5173`.
  - `ClientService.create` nhận `clientType:'public'`, `redirect_uris`, `allowedCorsOrigins`, `allowedResources`. (client.service.ts, client.schema.ts)
  - THIẾU: seed/provision tự động cho client `fe-sso-test` + resource `demo` + endpoint `GET /demo/me`. Theo plan là **B6.4 (seed)** + **B6.5/B4.6 (demo-resource)** — CHƯA làm (B6 chưa tới). → Task 4 [BE] + ghi chú chặn run 22.
- Viết `runs/21-T1-T2/tasks.md`: 4 task (T1 scaffold [FE], T2 phần 1 login [FE], T2 phần 2 callback/validate/refresh/logout [FE], Task 4 [BE] điều kiện tiên quyết X1). UTF-8 không BOM, đã verify.
- Quyết định công cụ: Vitest + happy-dom (WebCrypto thật, test PKCE S256 + jose JWKS); React Router Data Mode `createBrowserRouter`; **bỏ Tailwind**.
- Quyết định MỞ cho tech-lead: OPEN-1 token in-memory ⇒ mất khi reload (đề xuất chấp nhận cho app test); OPEN-2 không làm silent `prompt=none` run này; OPEN-3 xử lý cả trường hợp không có refresh_token.
- X1 (Playwright) KHÔNG thuộc run này — đã liệt kê "cần sẵn cho X1" ở cuối tasks.md.
- Cổng: analyst xong → đề nghị chuyển **tech-lead**.

## [2026-10-13 16:20] tech-lead
- Đã làm: review tasks.md đối chiếu BE thật (client/resource/token/authorize/CORS) + registry; chốt OPEN-1 (in-memory) / OPEN-2 (không silent) / OPEN-3 (cả 2 nhánh; refresh chỉ khi `offline_access`+grant); Task 4 = seed CLI dev-only tối thiểu, KHÔNG `/demo/me` (B6.5).
- Fold F1–F9 vào tasks.md: version thật (Vite 8.3.4, RR 8.4.0, TS 5.7.3), callback đổi code 1 lần (StrictMode), refresh single-flight + ID token refresh không nonce, issuer/`iss` bắt buộc, timeout, cấu hình seed exact (scopes, resource identifier, CORS).
- File đổi: runs/21-T1-T2/review-techlead.md, runs/21-T1-T2/tasks.md, backlog.md (DEBT-076/077), STATUS.md
- Kết quả: PASS — fold bắt buộc, không cần quay lại analyst.
- Bàn giao: frontend-dev — Task 1 → 2 → 3; sau đó backend-dev — Task 4.

## [2026-10-13 16:36] frontend-dev
- ?? l?m: Task 1–3 (T1 scaffold + T2 OIDC client vi?t tay): Vite 8 + React 19 + RR 8.4.0 Data Mode + zod env; `src/oidc/` (pkce S256, discovery issuer-check F5, authorize 9 params, callback single-flight F2, idToken jose RS256 F4/F5, refresh single-flight F3, logout RP-initiated, token in-memory F7); wiring UI.
- File ??i: fe-sso-test/{package.json,.env.example (+offline_access),vite.config.ts,eslint.config.js,tsconfig*.json,index.html,.gitignore}, src/{env.ts,env.app.ts,main.tsx,router.tsx,index.css,vite-env.d.ts,routes/*,oidc/*}, test/* (10 file), pnpm-lock.yaml.
- K?t qu?: DONE — typecheck/lint/build pass; vitest **45/45** (10 file); dev :5173 strictPort OK; thi?u env ? UI l?i r? (role=alert, kh?ng blank); callback error-element fail-closed.
- L?u ?: RR 8.4.0 d?ng ???c, KH?NG c?n fallback 7.18.4. `.env.example` scope th?m `offline_access` (kh?p seed F8/OPEN-3).
- B?n giao: backend-dev — Task 4 (seed-dev `fe-sso-test` + resource `demo`, F8/F9); sau ?? senior-reviewer.

## [2026-10-13 16:50] backend-dev
- Đã làm: Task 4 [BE] — CLI dev-only `be/src/database/seed-dev.ts` (mẫu `sync-indexes.ts`) + script `db:seed-dev`; upsert `$set` theo khoá (clientId/identifier), bắt E11000; `assertNotProduction` fail-closed TRƯỚC khi connect DB; client public `none` (không secret), grant `authorization_code`+`refresh_token`, scopes `openid profile email offline_access`, redirect `:5173/callback`, post-logout `:5173/`, CORS chỉ `:5173`, resource `demo` = `${ISSUER}/demo/` — khớp fe-sso-test/.env.example (F8). KHÔNG hook boot, KHÔNG chạy trong int-test.
- Security invariant: control-plane write từ code server tin cậy, không input ngoài; public client ⇒ 0 ClientCredential; URI/identifier qua `validateRedirectUriList`/`validateResourceFormat` (INV-4/INV-14); fail-closed env.
- File đổi: be/src/database/seed-dev.ts (mới), be/test/seed-dev.int-spec.ts (mới, 7 case), be/package.json (+db:seed-dev), be/README.md (lệnh seed).
- Kết quả: DONE — typecheck/lint xanh; `pnpm test` 175/175; `pnpm test:int` 449/449 (gồm 7 case mới) ⇒ 624 tổng, 0 regress (617→624). F9 cover: seed×2 idempotent, production throw+0 ghi, authorize scope⊆/resolveForClient resolve (không invalid_scope/invalid_target), CORS :5173 có/:5174 không.
- Bàn giao: senior-reviewer — review toàn run (T1–T3 FE đã DONE + Task 4 BE).

## [2026-10-13 17:10] senior-reviewer
- Đã làm: Preflight CodeGraph OK (1.6.2, sync). Review toàn run (T1–T3 FE + Task 4 BE) đối chiếu tasks.md + F1–F9. Tự chạy lại FE typecheck/lint/vitest 45/45, BE `seed-dev.int-spec` 7/7. Chạy mutation 18 điểm FE + 2 điểm BE; khôi phục byte-identical (sha256 khớp).
- Mutation SỐNG: (1) callback bỏ `validateIdToken` → 45/45 xanh; (2) nới `algorithms` (PS256/HS256) → xanh; (3) BE bỏ `assertNotProduction` trong `main()` → 7/7 xanh.
- File đổi: runs/21-T1-T2/review-senior.md, runs/21-T1-T2/log.md, STATUS.md. Không sửa code.
- Kết quả: **REJECT** — 4 🔴: [FE] test callback không khóa được validate ID token (nonce/sig ở mức callback); [FE] thiếu test alg≠RS256 (F5); [FE] transient không xoá ở nhánh lỗi (error/state/iss mismatch); [BE] guard production của CLI không có test khóa (test hiện là tautology). 7 🟡 (logout `state`, `azp`, validate response `/token`, refresh hồi sinh phiên sau logout, `error_description` spoofing, test F9 mô phỏng thay vì gọi endpoint, resource upsert theo identifier).
- Bàn giao: frontend-dev (🔴 #1–#3) + backend-dev (🔴 #4) → senior-reviewer review lại.
## [2026-10-13 17:22] frontend-dev (retry 1)
- Da lam: Sua 3 BLOCKER FE + 7 YELLOW. ??1 callback.test: them case id_token nonce lech & ky bang key la -> reject + `tokens.get()===null`; them `tokens.get()===null` cho state/iss/error. ??2 idToken.test: them PS256 (key khop trong JWKS)/HS256/`none` -> reject; bo header-check trung, de `algorithms:["RS256"]` khoa. ??3 callback.ts: `clearTransient` ngay sau `readTransient` + nhanh error/thieu code|state; test tung nhanh.
- Yellow: logout gui `state` (+`consumeLogoutState` verify 1-shot); kiem `azp` khi `aud` nhieu gia tri; zod validate response `/token`; refresh khong hoi sinh phien sau logout (commit chi khi `tokens.get()===current`); `error_description` khong hien nguyen van (message co dinh + `error` whitelist/escape, danh dau tu IdP). Ponytail: xoa `oidc/index.ts`, bo `globals:true`, `token.refresh_token` truc tiep.
- File doi: src/oidc/{callback,idToken,token-exchange,logout,refresh,client,types}.ts; vite.config.ts; test/{callback,idToken,logout,refresh,token-exchange}.test.ts; test/helpers/jwt.ts; xoa src/oidc/index.ts.
- Mutation (bang chung): ??1 decode khong verify -> 2 fail; ??2 noi algorithms PS256/HS256 -> PS256 fail; ??3 bo clearTransient -> 3 fail (state/iss/F2). Khoi phuc byte-identical: callback.ts sha256 c6e2145...a4cfb, idToken.ts 2ffc684...4918e (khop baseline).
- Verify: typecheck PASS; lint PASS; vitest **65/65** (11 file, +20 vs 45); build PASS.
- Ban giao: senior-reviewer review lai FE (??#1-#3 + 7??). Khong dung be/.

## backend-dev (retry 1)
- R4: guard production chuyen vao chinh seedDev(conn, issuer, nodeEnv) (assertNotProduction truoc moi ghi DB); main() van kiem truoc khi connect; seedDev truyen process.env.NODE_ENV.
- Test R4 (F9): goi THAT seedDev(conn, ISSUER, 'production') -> rejects + countDocuments client/resource = 0 (dem sau khi da goi seed).
- Mutation R4: bo assertNotProduction trong seedDev -> test FAIL (seedDev resolved, da upsert client+resource). Khoi phuc byte-identical: seed-dev.ts sha256 9dc7daa9...cca52 (khop baseline).
- Yellow: them test goi endpoint THAT GET /authorize voi client sau seed (scope 'openid profile email offline_access' khop fe-sso-test/.env.example) -> 302 /login, khong error=; negative: scope ngoai -> invalid_scope, resource la -> invalid_target. Preflight THAT OPTIONS /token qua registerCorsPreflight: :5173 -> 204+ACAO, :5174 -> khong ACAO.
- Yellow: Resource upsert doi khoa tu identifier -> resourceId (on dinh); test doi ISSUER khong sinh ban thu 2 (1 doc, identifier update tai cho). resourceId khong co unique index -> ghi debt (DEBT-077/B6.4), khong doi schema.
- Verify: typecheck PASS; lint PASS; unit test 175/175 PASS; test:int 452/452 PASS (23 suites, jest exit 0 voi --forceExit). File doi: be/src/database/seed-dev.ts, be/test/seed-dev.int-spec.ts (10/10). Khong dung fe-sso-test/, mcp.json, .github/agents/*.

## [2026-10-14 08:40] senior-reviewer (lượt 2)
- Kết luận: **PASS** — 4 🔴 lượt 1 đã đóng, không 🔴 mới. Chi tiết `review-senior.md` (Lượt 2).
- Tự chạy FE: typecheck/lint ✅, vitest 65/65 ✅, build ✅. Mutation (khôi phục byte-identical, sha256 ok): bỏ verify id_token → 2 fail; nới/bỏ `algorithms` → PS256 fail; bỏ clearTransient sau read → 3 fail, ở nhánh IdP error → 1 fail; refresh commit vô điều kiện → 1 fail; consumeLogoutState nới/không one-shot → 3/1 fail.
- Probe jose cùng key RSA ký PS256: `algorithms:["RS256"]` → ERR_JOSE_ALG_NOT_ALLOWED (cả JWK có/không `alg`). Zod `/token`: bearer/BEARER OK, trường thừa strip, DPoP reject.
- BE: Mongo test :27117 ECONNREFUSED từ shell reviewer (không compose up theo lệnh) → không chạy được `test:int seed-dev`. Thay bằng probe ts-node connection giả: gốc REJECTED touched=0, mutant bỏ guard RESOLVED touched=6. **Tester phải chạy lại seed-dev int (10/10).** Lưu ý `pnpm test:int -- x --forceExit` làm jest treo (--forceExit thành pattern).
- Hash cuối: callback.ts c6e2145…, idToken.ts 2ffc684…, seed-dev.ts 9dc7daa9… (khớp).
- 🟡 mở → backlog DEBT-078 (refresh lỗi xoá phiên mới), DEBT-079 (consumeLogoutState chưa nối), DEBT-080 (error_description /token), DEBT-081 (ponytail).
- Bàn giao: **tester**.

## tester — 2026-10-14 (xác minh run 21)

- Preflight CodeGraph OK (v1.6.2, 200 files / 3,199 nodes). Terminal = Git Bash. Đọc code qua CodeGraph + cat.
- Đối chiếu acceptance (Task 1-4 + fold F1-F9) ↔ test hiện có: coverage đầy đủ cho mọi AC/INV ưu tiên.
- Chạy THẬT toàn bộ gate: FE typecheck/lint ✅, vitest 65 (gốc) ✅, build ✅. BE typecheck/lint ✅, unit 175/175 ✅.
- BE 	est:int lần 1 FAIL 366/452 = ECONNREFUSED :27117 (container Exited giữa chừng) → hạ tầng, KHÔNG phải bug. docker start vg-test-mongo vg-test-redis, rs PRIMARY (myState=1), chạy lại → **23/23 suites, 452/452** ✅; PASS seed-dev.int-spec.ts (9.9s).
- Smoke FE dev: :5173 strictPort, curl -I ⇒ HTTP 200 text/html; dừng vite (PID), port free.
- Bổ sung 2 FE test (invariants.test.ts): runtime stub Web Storage chứng minh token không bao giờ setItem qua callback+refresh; reload→store mới null. FE 65→**67/67**; typecheck/lint vẫn xanh. KHÔNG sửa code sản phẩm.
- DEBT-078/079/080/081 là code sản phẩm (senior PASS lượt 2, tracked) — để nguyên, acceptance tương ứng đã có test xanh. Không mở DEBT mới.
- Kết luận: **PASS 694/694** (FE 67 + BE unit 175 + BE int 452). Xem test-report.md.
- Bàn giao: **orchestrator** (đóng run).
