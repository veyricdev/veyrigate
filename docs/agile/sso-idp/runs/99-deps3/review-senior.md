# Senior Review — 2026-11-21 (run 99 deps3: PR Dependabot #23, #22, DEBT-712)

## Kết luận: PASS

## Tổng quan
Diff chưa commit trên `develop` (`574f42a`, bỏ qua `.vscode/mcp.json`, `.mcp.json`) đúng phạm vi D99.1–D99.5, không lọt thay đổi ngoài phạm vi. Backend-dev áp nguyên diff của Dependabot (không `pnpm add`, không tự resolve) nên lockfile tái lập được và đối chiếu được bằng byte.

Bằng chứng (đo lại độc lập, không dựa vào log dev):
- sha256 file trong working tree **trùng byte** với file ở nhánh PR:
  - `origin/dependabot/npm_and_yarn/npm-minor-patch-a73d3f2602`: `be/package.json`, `e2e/package.json`, `fe-admin/package.json`, `fe-sso-test/package.json`, `pnpm-lock.yaml` — 5/5 SAME.
  - `origin/dependabot/docker/be/node-image-976c282264`: `be/Dockerfile`, `fe-admin/Dockerfile` — 2/2 SAME.
- `git diff --stat` của 2 PR (233+/231- và 4+/4-) cộng lại khớp diff working tree trên các file đó. Ngoài ra chỉ có `styles.css`, `backlog.md`, `STATUS.md` và thư mục run (untracked). `pnpm-workspace.yaml`, `package.json` gốc, `.github/` không đổi.
- Dockerfile: đúng 4 dòng `FROM` đổi digest `4b150b48…` ⇒ `5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`, tag vẫn `node:22.23.4-bookworm-slim`. Comment, stage, `.nvmrc`/engines giữ nguyên.
- Pin/override: hunk đầu tiên của lockfile ở dòng 194, nên khối `overrides:` ở đầu file không đổi. `fe-admin/package.json` vẫn `@tanstack/react-router` 1.170.42 và `@tanstack/react-start` 1.168.61. Trong lockfile, các dòng router/start/light-my-request/seroval/redocly chỉ đổi peer-suffix `vite@8.3.5` ⇒ `vite@8.3.6`, phiên bản không đổi.
- `be/src/public/styles.css`: 1 hunk, chỉ đổi banner `tailwindcss v4.3.4` ⇒ `v4.3.5` (D99.2).
- DEBT-712: chỉ nối vào cột ghi chú "kiểm 2026-11-21 (run 99): vẫn 7.13.0, peer ^5.x — chưa bump", đúng D99.5. Không đụng dependency openapi-typescript.

Điểm tốt: tuân thủ quy trình "áp diff bot rồi `--frozen-lockfile`". Cách này loại bỏ rủi ro resolve lệch so với PR, và Dependabot sẽ tự đóng #22/#23 sau push.

## 🔴 Blocker
Không có.

## Security invariants / trust boundaries đã kiểm
Không có thay đổi code ứng dụng. Trust boundary bị chạm gián tiếp qua dependency và base image:
- **Supply chain**: mọi bản ≥ 14 ngày (bảng ngày của tech-lead, bản trẻ nhất react-query 2026-11-06 23:04Z). Không thêm `minimumReleaseAgeExclude`, không thêm ignore. Lockfile giống hệt PR bot.
- **Base image**: pin bằng digest index chính thức (tech-lead đã `imagetools inspect`: source docker-node rev `80f02a54`). Chuỗi FROM build/runtime dùng cùng digest, nên không có lệch giữa 2 stage.
- **Static serving (Nest 12.4 #18414)**: BE dùng `@fastify/static` trực tiếp, không qua `useStaticAssets`. Bằng chứng runtime (traversal `b74-tester`, int 2524) thuộc gate tester D99.6 — **bắt buộc** chạy, không bỏ.
- **Cookie/session ở E2E (Playwright 1.65, so khớp cookie theo RFC 6265)**: đây là chỗ có thể lộ bug thật về scope cookie của app (host-only/path). Tester phải phân loại đúng D99.3 (a)/(b). Không được sửa test để che lỗi (b).
- **CSP**: CSS chỉ đổi comment banner. `style-src 'self'` không đổi, không có hash/SRI phụ thuộc nội dung.

## 🟡 Nên sửa
Không có.

## 💭 Nit
Không có.

## ✂️ Ponytail
Diff chỉ gồm version bump, digest và một dòng banner tái sinh. Không có code mới để cắt.
Lean already. Ship.

---

# Senior Review lần 2 — 2026-11-21 (retry 1, D99.7: giữ Playwright 1.64.1)
## Kết luận: PASS

## Tổng quan
Phạm vi lần 2 khớp D99.7 và gọn. Tôi đo độc lập:
- `e2e/package.json` trùng HEAD (`git diff HEAD -- e2e/` rỗng), `@playwright/test` 1.64.1.
- `pnpm-lock.yaml` so với nhánh PR #23 (`origin/dependabot/npm_and_yarn/npm-minor-patch-a73d3f2602`): chỉ khác ở `@playwright/test`, `playwright`, `playwright-core` (1.65.0 ⇒ 1.64.1: specifier, version, resolution, snapshot). Integrity của 3 gói trùng HEAD, vì `git diff HEAD -- pnpm-lock.yaml` không có dòng nào chứa playwright. Lockfile chỉ còn một phiên bản của mỗi gói. 3 package.json còn lại của #23 vẫn trùng byte nhánh PR.
- `.github/dependabot.yml`: thêm ignore `@playwright/test` `['1.65.0']` (khoá đúng một bản, nên 1.65.1+ vẫn được đề xuất khi hết cooldown). Comment ghi D99.7/DEBT-714 và điều kiện gỡ. Comment đầu file thêm 714 vào danh sách ignore có thể chặn PR bảo mật. Cùng mẫu với entry TS/TanStack.
- `backlog.md` DEBT-714: đủ triệu chứng (assert, điều kiện COOP cross-site), quyết định tạm, điều kiện đóng (≥ 1.65.1 từ 2026-11-27, X3 webkit 14/14, gỡ ignore).

## 🔴 Blocker
Không có.

## Security invariants / trust boundaries đã kiểm
- Không đổi code app. Đây là hạ phiên bản devDependency chỉ dùng cho test (e2e), không có trong image runtime.
- Supply chain: 1.64.1 là bản đã có ở HEAD (run 98, CI xanh), integrity trùng HEAD. Không thêm `minimumReleaseAgeExclude`. Backend-dev báo `--frozen-lockfile` qua chính sách.
- Chuỗi request/cookie: mục đích của retry là lấy lại bằng chứng X3 WebKit cross-site (host-only, `__Host-`, Lax). Bằng chứng này chỉ có sau khi tester chạy lại X3 42, đây là điều kiện bắt buộc để đóng run.
- Ignore Dependabot chỉ chặn đúng `1.65.0`, không chặn dải bản. Đã ghi rủi ro chặn PR bảo mật ở đầu file (DEBT-699/714).

## 🟡 Nên sửa
Không có.

## 💭 Nit / lưu ý cho tester
- Revision WebKit của Playwright 1.64.1 là **2370** (WebKit 27.2, theo `browsers.json` của `playwright-core@1.64.1`; override 2251 chỉ cho mac14). Không phải 2287 như `test-report.md` dòng 56 ghi "run 98 … WebKit 2287". 2287 chỉ là thư mục browser cũ còn sót trên máy. Hệ quả: lần gate lại chạy X3 trên WebKit 27.2 bản 2370, cùng major với bản 2388 của 1.65.0. Nếu webkit vẫn 8/14 trên 1.64.1 thì lỗi nằm ở build WebKit/COOP chứ không ở driver 1.65.0. Khi đó giả thuyết D99.7 sai, phải quay lại tech-lead, không được ghi DEBT-714 là xong. Tester nên ghi rõ revision webkit đã dùng (`webkit-2370`) trong report.
- Store pnpm local còn `playwright(-core)@1.65.0` và `1.64.0`. Lockfile không tham chiếu tới các bản này nên không ảnh hưởng.

## ✂️ Ponytail
Diff chỉ gồm 1 pin version, 1 entry ignore và 1 dòng backlog. Không có gì để cắt.
Lean already. Ship.
