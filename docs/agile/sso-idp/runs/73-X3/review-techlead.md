# Tech Lead Review — 2026-11-06 (retry 1)
## Kết luận: PASS

REJECT lượt 1 (thiếu Firefox/WebKit đúng revision) đã giải quyết: tech-lead tự kiểm `%LOCALAPPDATA%\ms-playwright` có chromium-1248, firefox-1555, webkit-2370 = `playwright-core@1.64.0/browsers.json`. Thiết kế bắt buộc: § "Fold tech-lead — retry 1" trong `tasks.md`.

## Kiến trúc đề xuất
- Không đổi kiến trúc sản phẩm. BE chỉ đổi tên cookie theo cờ `SESSION_COOKIE_SECURE` sẵn có (một nguồn sự thật, không env mới).
- Suite X3 = config Playwright riêng (`e2e/playwright.x3.config.ts`, `pnpm -C e2e e2e:x3`), topology `idp.alpha.localhost` / `app.alpha.localhost` (same-site) / `app.beta.localhost` (cross-site) sau một TLS reverse proxy Node chỉ bind loopback, cert tự ký sinh lúc chạy, `ignoreHTTPSErrors`.

## Bằng chứng khả thi (probe scratchpad `x3probe/`)
| Đo | Chromium 156 | Firefox 157 | WebKit 27.2 (Windows) |
|---|---|---|---|
| `*.localhost` tự phân giải loopback | ✅ | ✅ | ✅ |
| `a.alpha.localhost`↔`b.alpha.localhost` same-site / ↔`b.beta.localhost` cross-site | ✅ | ✅ | không phân biệt được (không áp SameSite) |
| Cross-site: `Lax` theo top-level GET, không theo POST/fetch/iframe | ✅ | ✅ | ❌ gửi mọi nơi (≠ Safari, DEBT-506) |
| Cookie không khai `SameSite` cross-site fetch/iframe | không gửi (Lax-by-default) | **gửi** (None) | gửi |
| `Secure` trên `http://*.localhost` gửi được | ✅ | ✅ | ❌ ⇒ X3 phải HTTPS |
| Tossing `__Host-x; Domain=alpha.localhost` từ sibling | bị từ chối | bị từ chối | bị từ chối |
| Tossing `legacy` / `__Secure-x` với `Domain=` tới IdP | đến IdP | đến IdP | đến IdP |

## Điểm mạnh
- Spec/plan/Q8 rõ (kiểm topology, không kiểm tên); fe-admin đã có mẫu `__Host-` theo protocol (`fe-admin/src/server/session/cookies.ts`) — BE làm tương tự.
- `SessionCookie` là điểm đọc/ghi duy nhất ⇒ đổi tên gọn; int-test chạy `cookieSecure:false` nên hầu hết không phải sửa.
- `startRp` (fe-sso-test thứ hai) đã có, chỉ cần tách origin công khai khỏi cổng nội bộ.

## Cổng security design
- Tài sản/actor/boundary: session ID + identity CSRF ẩn danh của IdP; actor = RP same-site (subdomain anh em, có thể bị chiếm), RP cross-site, attacker site. Boundary = host IdP (`__Host-` = host-only, Path=/, Secure).
- Invariant: tên cookie suy ra từ đúng 1 cờ; không bao giờ `Domain`; sau deploy chỉ tên mới được đọc (cắt cứng, không fallback — fallback = giữ lỗ tossing).
- Abuse cases có test âm: tossing tên cũ/`__Host-` với `Domain` (ca 6); cross-site POST không `_csrf` (ca 4); replay cookie sau logout (ca 3); cookie legacy hợp lệ sau đổi tên ⇒ anonymous, không 5xx (int).
- Failure semantics: không đổi đường Redis/Mongo (đọc session vẫn như cũ); harness thiếu `openssl` ⇒ fail-fast rõ; cổng bận ⇒ dừng, không kill.
- Exposure: bảng/JSON chỉ chứa tên cookie và kết quả; `trace: off`; không log giá trị cookie/`code`; key TLS git-ignored, không commit; proxy loopback-only.

## Vấn đề (bắt buộc — đã fold, không chặn)
- [x] `idp_csrf` cùng lỗ tossing với session (identity CSRF của form login) ⇒ đưa vào Task 1.
- [x] Không dùng `adminToken` cho X3 (chặn hop ở tầng mạng Chromium) ⇒ seed 2 client qua `seed:e2e-admin` khi `E2E_X3=1`.
- [x] WebKit-Win không áp SameSite ⇒ assert âm "cookie không gửi cross-site" chỉ cho Chromium/Firefox; WebKit chỉ ghi nhận, functional vẫn assert.

## Đề xuất (không bắt buộc) → backlog
- DEBT-505 🟡: `idp_fed`/`idp_link` (`Path=/auth/`) không mang được `__Host-`; tossing đo được ⇒ đổi `Path=/` + prefix.
- DEBT-506 🟡: chạy cột WebKit trên macOS/Safari thật trước launch (X6).
- DEBT-507 💭: biến thể chặn 3P cookie nếu sau này cần silent SSO iframe.
