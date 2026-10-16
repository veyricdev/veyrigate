# Summary — run 25 T5 + T4 E2E + DEBT-101/102 (M3) — ✅ PASS 4/4 task

- **Phạm vi**: T1 [FE] DEBT-101 (`<Link>` thay `<a href>` nội bộ ⇒ giữ session in-memory) + DEBT-102 (xoá transient ở `/callback?error=`). T2 [FE] lab refresh replay (INV-10/11; `TokenEndpointError.code`, chỉ xanh khi `invalid_grant`). T3 [FE] lab 8 kịch bản `/authorize` (redirect_uri sai, PKCE plain/thiếu, resource lạ/tương đối, `prompt=none`, no-nonce) + state tamper qua `finishLogin` thật; nhánh callback `lab` fail-closed (state+iss, không gọi `/token`, consume một lần); dev-only `import.meta.env.DEV`, `dist/` sạch lab. T4 [E2E] `api-test.spec.ts` (A/B/C) + `lab.spec.ts`.
- **Quyết định**: tech-lead fold F1–F7 (no-nonce ⇒ IdP trả code; `prompt=none&max_age=0` ⇒ `login_required`; `/lab` không `requireAuth`; replay chạy cuối E2E). Không cần BE. DEBT-099 hoãn.
- **Verify**: FE 240/240, E2E 12/12 × 2 lần liên tiếp (quét output: 0 `code=`/`state=`/`eyJ`/cookie), BE unit 211/211; mutation RED→khôi phục byte-identical.
- **Commit**: `d823b04`.
- **Vòng lặp**: tech-lead=1, FE dev=2 (T1–3, T4), senior=1, tester=1 — không REJECT/FAIL.
- **Debt**: đóng DEBT-101/102; mở DEBT-107…115. DEBT-054, 098, 099, 103–106 vẫn mở.
- **Ops**: người dùng cho phép dừng dev server tiptap-editor (PID 36084) để giải phóng :5173 — cần tự bật lại.
