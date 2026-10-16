# Senior Review — 2026-10-16 (run 25, lượt 1)

## Kết luận: PASS

Không có 🔴. Các 🟡 bên dưới không chặn ⇒ ghi `backlog.md` DEBT-112…DEBT-115. Bàn giao **tester**.

Phạm vi: diff chưa commit kể từ `4d67f3b` trong `fe-sso-test/` và `e2e/` (gồm file untracked: `oidc/lab.ts`, `routes/Lab.tsx`, `test/{lab,Lab,navigation,router-lab}.test.*`, `e2e/tests/{api-test,lab}.spec.ts`, `e2e/tests/support/oidc.ts`). Bỏ qua `.github/agents`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`.

Preflight: `codegraph --version/status/sync` (up to date). Git Bash. Không chạy E2E, không compose/FLUSH/drop, không commit.

Bằng chứng tự chạy:
- `pnpm -C fe-sso-test test` ⇒ **30 file / 236 test xanh**; `typecheck` + `lint` sạch; `pnpm -C e2e typecheck` sạch.
- `pnpm -C fe-sso-test build` (dist đã gitignore) rồi grep `dist/` các chuỗi `lab-tampered-state|oidc:lab_|lab-replay|prompt-none-max-age-0|Security lab` ⇒ **0 khớp**. Chỉ còn `labScenario` (spread trong `authorize.ts`) và class `TokenEndpointError` — là code chung, không phải module lab ⇒ module `oidc/lab.ts` + chunk `Lab` bị loại khỏi prod (F5 đạt).

## Tổng quan

Chất lượng tốt, bám sát fold F1–F7:
- Lab tái dùng `beginLogin` + đổi 1 param (không builder thứ hai); kỳ vọng `no-nonce` = `code` đúng hành vi IdP.
- Nhánh callback lab gated `import.meta.env.DEV && lab`, đặt **trước** aud-probe/silentRestore; `recordLabCallback` đọc rồi `clearTransient` ngay (consume-once, kể cả khi transient không phải lab/scenario lạ), PASS chỉ khi `state` khớp **và** `iss === issuer` **và** kết quả khớp kỳ vọng; không gọi `/token`, không lưu `code`/`state` (kết quả chỉ gồm id whitelist, outcome, mã lỗi qua `describeOAuthError`, boolean).
- State tamper chạy `finishLogin` thật; `exchange()` đã `clearTransient` trước khi so state và ném trước `postToken` ⇒ 0 `/token`; có test đối chứng (state thật ⇒ tới `/token` ⇒ FAIL) chống tautology.
- Refresh replay: RT cũ chỉ là biến cục bộ trong `runRefreshReplay`; chỉ `TokenEndpointError.code === "invalid_grant"` mới xanh (5xx/network ⇒ "inconclusive" đỏ) — fail-closed đúng F6; message lỗi cũ giữ nguyên.
- DEBT-101/102 làm gọn; test điều hướng + router test DEBT-102 có.
- E2E: thu secret qua `page.on('response')` cho mọi `POST /token` 200; assert lộ lọt bằng boolean (không echo secret vào report); chờ URL bằng predicate port/pathname; replay chạy cuối, login riêng; context sạch cho kịch bản `prompt=none`. Thiết kế chống flaky hợp lý (`approveConsentUntil` có giới hạn vòng, race consent có/không).

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- **Identity / CSRF (callback)**: nhánh lab — `state` lệch/thiếu transient ⇒ `rejected`, `pass:false` (test `lab.test.ts:140`); `iss` thiếu/sai ⇒ FAIL (`:146`); transient lạ/scenario lạ ⇒ không ghi, transient vẫn bị tiêu (`:163`). Link giả `/callback?state=lab-tampered-state` khi cờ tamper được arm ⇒ vẫn đi qua `finishLogin` thật ⇒ bị từ chối; cờ là one-shot, bị xoá ở mọi callback dev.
- **Replay / consume-once**: transient lab, cờ `oidc:lab_expect`, `oidc:lab_result` đều read-and-delete. Mã `code` của kịch bản `no-nonce` không bao giờ được đổi (E2E: `exchanges === 0`).
- **Refresh rotation (INV-10/11)**: 3 bước, mutation IdP chấp nhận replay ⇒ step 2 FAIL; không revoke family ⇒ step 3 FAIL; không rotate ⇒ dừng, không gửi replay.
- **Prod exclusion (F5)**: `buildRoutes({lab:false})` không có `/lab` và bỏ qua transient lab + cờ tamper (`router-lab.test.tsx:80-93`); build + grep `dist/` xác nhận (ở trên).
- **Exposure**: Lab không render token/code/state (test `Lab.test.tsx:72` kiểm DOM + storage); `takeLabResult` lọc lại JSON (scenario whitelist, outcome set, mã lỗi qua `describeOAuthError`) trước khi render; E2E `expectNoSecretsExposed` kiểm DOM/URL/local+sessionStorage với mọi secret thu được, sau B và sau replay; URL cuối không có `code`/`state`.
- **Failure behavior**: discovery lỗi ⇒ thông báo cố định "Could not start the flow"; `/token` 5xx/network ⇒ đỏ "inconclusive", không retry.
- **Open redirect / returnTo**: link `/login?returnTo=/lab` đi qua `sanitizeReturnTo` hiện có.
- **Đã biết, không mới**: DEBT-107 (nhánh `?error=` thường không kiểm `state`/`iss`) — sau DEBT-102, link giả `/callback?error=x` còn xoá được transient đang chờ của người dùng (huỷ một lần login đang dở; không leo thang, chỉ là DoS UX) ⇒ ghi chú thêm vào DEBT-107, không mở debt mới.

## 🟡 Nên sửa (không chặn)

🟡 **[E2E] Trace CI có thể chứa token thô** — `e2e/playwright.config.ts:32` `trace: CI ? "retain-on-failure" : "off"`.
Vì sao: trace Playwright ghi body response mạng (gồm `POST /token` ⇒ access/refresh/id token) và URL `/callback?code=&state=`; artifact CI giữ lại khi fail. Có sẵn từ trước run 25 nhưng run này thêm nhiều exchange hơn (probe, restore, replay) và cam kết "log E2E không chứa token". Token E2E là token DB `sso-idp-e2e`, rủi ro thấp.
Đề xuất: cân nhắc `trace: "off"` (hoặc chỉ `E2E_TRACE=1` cục bộ) khi đưa E2E lên CI (X2/X5). ⇒ **DEBT-112**.

🟡 **[FE] Văn bản kịch bản tách khỏi định nghĩa kịch bản** — `fe-sso-test/src/routes/Lab.tsx:14` `SCENARIO_TEXT: Record<string, …>` tra theo `s.id` ở `:177`.
Vì sao: thêm 1 kịch bản vào `LAB_SCENARIOS` mà quên text ⇒ `text.title` của `undefined` ⇒ crash trang `/lab`; `Record<string,…>` khiến TypeScript không bắt.
Đề xuất: gõ khoá theo union id (`(typeof LAB_SCENARIOS)[number]["id"]` với `as const`/`satisfies`) hoặc để text vào chính `LabScenario` (chunk lab vẫn dev-only nên không lo kích thước prod). ⇒ **DEBT-113**.

🟡 **[FE] Lazy initializer có side effect** — `Lab.tsx:92` `useState(takeLabResult)` đọc-và-xoá sessionStorage trong initializer.
Vì sao: initializer phải thuần; React StrictMode dev gọi initializer 2 lần. Hiện chạy đúng vì React giữ kết quả lần đầu (E2E xanh chứng minh), nhưng phụ thuộc chi tiết hiện thực React; nếu component remount (vd key đổi, HMR) kết quả one-shot mất.
Đề xuất: đọc kết quả trong `loader` của route `/lab` (cùng chỗ đã đọc-xoá các one-shot khác trong router) rồi `useLoaderData()`. ⇒ **DEBT-114**.

🟡 **[FE] Thông báo FAIL state-tamper khó hiểu khi IdP trả `error`** — `Lab.tsx` hiển thị "not rejected as expected (rejected)" khi `finishLogin` ném lỗi khác "state mismatch" (vd người dùng từ chối consent ⇒ `?error=`).
Vì sao: fail-closed đúng nhưng chữ mâu thuẫn ("not rejected … (rejected)") gây hiểu nhầm khi debug. Gộp cùng DEBT-109 (lỗi callback có cấu trúc `reason`) để hiển thị lý do thật. ⇒ ghi chú vào **DEBT-109**, không mở debt riêng.

## 💭 Nit

- `lab.ts` `takeLabResult` re-validate toàn bộ JSON tự ghi trong sessionStorage cùng origin — phòng thủ hợp lý (React đã escape) nhưng hơi dày; giữ được.
- Kịch bản `no-nonce` để lại một `code` chưa dùng còn hiệu lực tới TTL (60s, single-use) ở IdP — dev-only, chấp nhận; có thể ghi một dòng trên trang lab.
- `client.ts` `replayRefreshToken` truyền `fetch` toàn cục thay vì `fetchImpl` như các hàm khác — nhất quán với wrapper khác trong file, không vấn đề.

## ✂️ Ponytail

- fe-sso-test/src/router.tsx:L34: shrink: `loadLab` (const ternary DEV ? fn : null) + check `withLab && loadLab` ở L131 là gate kép (`withLab` đã gồm `import.meta.env.DEV`). Inline `lazy: async () => ({ Component: (await import("./routes/Lab")).default })` trong spread `withLab ? [...] : []`; rolldown vẫn fold `DEV` ⇒ tree-shake (xác nhận lại bằng grep `dist/`).
- fe-sso-test/src/routes/Lab.tsx:L14: shrink: map text riêng theo id. Gộp vào `LAB_SCENARIOS` (xem DEBT-113).
- fe-sso-test/src/oidc/lab.ts:L114: shrink: `isLabCallbackPending` + `recordLabCallback` đọc transient 2 lần. Có thể để `recordLabCallback` trả `undefined` khi không phải lab và router dùng kết quả đó; lợi ích nhỏ, tuỳ.
net: -10 lines possible. ⇒ **DEBT-115** (ponytail, khi chạm file).
