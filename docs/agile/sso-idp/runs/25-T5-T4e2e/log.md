# Log — run 25 — T5 (security lab) + T4 E2E + DEBT-101/102

## orchestrator — 2026-10-16
- Mở run sau khi đóng run 24 (`374863d`, docs `4d67f3b`). spec/plan đã có ⇒ không gọi analyst; tự sinh `tasks.md` từ plan §7 (T4, T5) + mục "Tách run 25" của run 24 + DEBT-101/102 (+ DEBT-099 để tech-lead quyết). Cổng → tech-lead.

## tech-lead — 2026-10-16 — PASS (fold F1–F7)
- Preflight CodeGraph (1.6.2, status up to date, sync). Đọc code qua CodeGraph MCP + Git Bash; ghi UTF-8 không BOM. KHÔNG compose/FLUSH/drop, KHÔNG commit, KHÔNG sửa code.
- Đối chiếu `authorize.service.ts handle()`/controller: `redirect_uri` sai ⇒ trang lỗi 400 không redirect; plain/thiếu challenge ⇒ `invalid_request`; resource lạ/không absolute ⇒ `invalid_target`; **nonce không bắt buộc ở IdP** (kỳ vọng tasks sai ⇒ sửa thành trả `code`); `prompt=none` có phiên ⇒ không tất định ⇒ thay `prompt=none&max_age=0`.
- Fold vào `tasks.md`: F1 bảng kỳ vọng; F2 nhánh callback `lab` (state+iss, consume-once, không `/token`); F3 state tamper qua `finishLogin` thật; F4 `/lab` không `requireAuth` cấp route; F5 gate `import.meta.env.DEV` + `buildRoutes({lab})` + lazy, grep `dist/`; F6 lỗi `/token` có cấu trúc, RT cũ trong ref; F7 E2E (sync-indexes đã trong webServer, nghe mọi `/token`, smoke lab chạy cuối).
- Q-25.1 không cần BE; Q-25.2 hoãn DEBT-099; Q-25.3 `import.meta.env.DEV`.
- Debt mới: DEBT-107 (`/callback?error=` thường không kiểm state/iss), DEBT-108 (call log Playwright có thể in URL callback).
- Kết quả: **PASS** — `review-techlead.md`. Bàn giao: **frontend-dev** (Task 1 → 2,3 → 4). Không task [BE].

## frontend-dev — 2026-10-16 — Task 1–3 xong (Task 4 chưa làm)
- Preflight CodeGraph (1.6.2, up to date, sync). Git Bash, UTF-8 không BOM. Chỉ sửa `fe-sso-test/`; KHÔNG compose/FLUSH/drop, KHÔNG commit.
- T1: mọi `<a href>` nội bộ ⇒ `<Link to>` (8 file routes); `/callback?error=` gọi `clearTransient` (DEBT-101/102 đóng). Test page bọc `MemoryRouter`; `navigation.test.tsx` + router test DEBT-102.
- T2: `TokenEndpointError{code}` (message giữ nguyên); `lab.ts runRefreshReplay` (RT cũ chỉ là biến cục bộ) + `/lab` mục Refresh replay; xanh chỉ khi `invalid_grant`.
- T3: transient `purpose:"lab"`+`labScenario`; 8 kịch bản theo F1 (beginLogin + đổi param); callback lab consume-once, kiểm state+iss, không `/token`; state tamper chạy `finishLogin` thật. `invalid_target` thêm vào `oauthError`. `buildRoutes({lab})` + lazy, gate `import.meta.env.DEV && lab`.
- Verify: typecheck/lint sạch; `pnpm -C fe-sso-test test` **30 file / 236 test** (trước 187); build OK, grep `dist/` không còn chuỗi lab (`data-testid="lab-`, `oidc:lab_*`, id kịch bản). Mutation 11/11 RED rồi khôi phục byte-identical (cmp).
- Không smoke trình duyệt: :5173 đang bị project khác chiếm (strictPort) — Task 4 E2E sẽ phủ. Debt mới: DEBT-109.
- Bàn giao: Task 4 [E2E] (frontend-dev) → senior-reviewer.

## frontend-dev — 2026-10-16 — Task 4 [E2E] xong
- Preflight CodeGraph (1.6.2, up to date, sync). Git Bash, UTF-8 không BOM. Chỉ sửa `e2e/` (+ backlog/docs); KHÔNG sửa `be/`/`fe-sso-test/`, KHÔNG compose/FLUSH/drop, KHÔNG commit.
- Mới: `e2e/tests/support/oidc.ts` (thu secret MỌI `POST /token` 200 qua `page.on('response')`, sign-in + consent có/không, assert DOM/URL/storage bằng boolean — không in secret; chờ URL bằng predicate port/pathname, DEBT-108 cho spec mới); `api-test.spec.ts` (/profile → /api-test: A 200, C 200, B chuỗi redirect ⇒ PASS 401, A lại 200 sau khôi phục, `sub` /profile + mọi id_token trùng; ≥3 exchange, 0 body không đọc được); `lab.spec.ts` (redirect_uri sai ⇒ IdP 400 không redirect; 6 kịch bản error ⇒ PASS + iss ok + 0 `/token`; no-nonce ⇒ PASS, 0 `/token`; state tamper ⇒ PASS, 0 `/token`; refresh replay chạy CUỐI, login riêng ⇒ 3 bước PASS, đúng 2 exchange, không lộ secret).
- Verify: `pnpm -C e2e typecheck` sạch; `pnpm -C e2e e2e` 11/11 x2 (run 1 có consent `other`, run 2 không — phủ cả 2 nhánh), thêm no-nonce rồi **12/12 xanh 2 lần liên tiếp** (43.0s, 43.7s). Quét output 4 run: 0 khớp `code=`/`state=`/`eyJ`/cookie. Port 4000/5173 đã nhả sau mỗi run.
- Không lỗi FE/BE lộ ra. Debt mới 🟡: DEBT-110 (webServer stdout pipe ồn), DEBT-111 (cảnh báo `HydrateFallback`).
- Bàn giao: **senior-reviewer**.

## senior-reviewer — 2026-10-16 — PASS
- Preflight CodeGraph (up to date, sync). Git Bash; UTF-8 không BOM. KHÔNG chạy E2E, KHÔNG compose/FLUSH/drop, KHÔNG commit, KHÔNG sửa code.
- Tự chạy: `pnpm -C fe-sso-test test` 30 file / 236 xanh; typecheck + lint sạch; `pnpm -C e2e typecheck` sạch; `build` + grep `dist/` không còn chuỗi module lab (chỉ còn `labScenario`/`TokenEndpointError` thuộc code chung).
- Invariant đã kiểm: nhánh callback lab gated DEV, consume-once, PASS chỉ khi state+iss khớp, 0 `/token`; state tamper qua `finishLogin` thật (transient xoá trước so state); replay chỉ xanh với `invalid_grant`; prod build loại lab; E2E assert lộ lọt bằng boolean, chờ URL bằng predicate.
- 0 🔴. 🟡 → backlog: DEBT-112 [E2E] trace CI chứa body `/token`; DEBT-113 [FE] `SCENARIO_TEXT` tách khỏi `LAB_SCENARIOS`; DEBT-114 [FE] `useState` initializer có side effect; DEBT-115 ponytail (~-10 dòng). Ghi chú thêm vào DEBT-107/109.
- Kết quả: **PASS** — `review-senior.md`. Bàn giao: **tester**.

## tester — 2026-10-16 — PASS
- Preflight CodeGraph (1.6.2, up to date, sync). Git Bash; UTF-8 không BOM. KHÔNG compose/FLUSH/drop, KHÔNG commit; `be/` không đổi. Port 4000/5173 trống trước, nhả sau mỗi lượt.
- FE: typecheck + lint sạch; test 30 file/236 xanh; build OK, grep `dist/` 0 chuỗi lab (chỉ `labScenario` code chung, không có chunk Lab, không `"/lab"`).
- E2E: typecheck sạch; `pnpm -C e2e e2e` **12/12 x2 liên tiếp** (48.2s, 42.5s); quét output 0 khớp `code=`/`state=`/`eyJ`/cookie/`refresh_token`.
- BE hồi quy: `pnpm -C be test` 21 suite / 211 xanh.
- Thêm `fe-sso-test/test/lab-replay.test.ts` (4 test: replay lab callback consume-once, callback rỗng ⇒ rejected, no-nonce thiếu `iss` ⇒ FAIL, cờ tamper one-shot); mutation 3/3 RED rồi khôi phục byte-identical. FE sau cùng **31 file / 240 xanh**.
- Không lỗi [FE]/[E2E]/[BE]. Không debt mới. Kết quả: **PASS** — `test-report.md`. Bàn giao: **orchestrator** đóng run.
