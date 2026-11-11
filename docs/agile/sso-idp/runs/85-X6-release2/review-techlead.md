# Tech Lead Review — 2026-11-11 (run 85, X6 release checklist đợt 2, BE + UI + ops/docs + QA)

## Kết luận: PASS

Fold chi tiết (quyết định D85.1–D85.10, hợp đồng, AC, RED, mutation, bảng SHA, bảng Dependabot) nằm ở `tasks.md`, mục "Fold tech-lead (2026-11-11)". Đã kiểm trên `develop` HEAD `78724b7`.

| Task | Nội dung | P | Lane / người làm |
|---|---|---|---|
| T1 | mongoose 9.10.2 → 9.11.4 (4 GHSA ngày 2026-11-10); pin mọi action theo SHA đã peel, nâng lên major mới nhất, codeql v4 (DEBT-553/557); job `sbom` dùng `pnpm sbom`; `audit.yml` chạy hằng ngày; runbook-deploy §14 thời hạn khắc phục (DEBT-576) | P0 | [BE/ops] backend-dev |
| T2 | `request`/`request_uri` ⇒ `*_not_supported` + discovery khai `false` (DEBT-571); `POST /userinfo` (DEBT-584) | P0 | [BE] backend-dev |
| T3 | Danh sách 10 000 mật khẩu phổ biến (SecLists NCSC, MIT) + từ ngữ cảnh ở register/reset/đổi mật khẩu (DEBT-574) | P0 | [BE] backend-dev |
| T4 | Chống khoá có chủ đích: throttle theo (email, mạng)/email/thiết bị + device cookie `__Host-idp_dc`, bỏ khoá cứng (DEBT-575, đóng DEBT-016) | P0 | [BE+UI] backend-dev |
| T5 | Đổi mật khẩu `/account/password` (DEBT-573) | P0 | [BE+UI] backend-dev |
| T6 | Cập nhật checklist + security-matrix, spec tester, gate | — | [QA] tester |

Thứ tự: T1 → T2 → T3 → T4 → T5 (backend-dev; T2 được làm song song trong worktree riêng), rồi senior-reviewer, rồi T6 (tester). T1 đi đầu vì CI `pnpm audit --audit-level high` đang đỏ, và int FULL của các task sau phải chạy trên mongoose đã vá. T3 đi trước T5 vì T5 dùng `assertAcceptablePassword`. T4 đi trước T5 vì T5 dùng bước xoá device trust trong `revokeAllUserCredentials`.

Run 86 (X6 đợt 2b): DEBT-577 (P0, token đặt trong fragment), DEBT-393 [BE]+[FE], DEBT-572, DEBT-583. Diễn tập dời sang run 87, ký duyệt sang run 88.

## Kiến trúc đề xuất

Không đổi kiến trúc (modular monolith NestJS, Redis cho bộ đếm, Mongo cho state). Không thêm dependency runtime. Có hai thành phần mới, đều nằm trong module `authentication`:

- `password-policy/` gồm file dữ liệu tĩnh nhúng vào repo và hàm thuần `assertAcceptablePassword`. Tập dữ liệu nạp lúc khởi động, fail-closed.
- `login-throttle.service.ts` dùng lại `RateLimitService.reserve/refund` (Lua có sẵn). Thêm một ZSET thiết bị tin cậy cho mỗi user và một cookie `__Host-`.

Hai lựa chọn có chủ đích ngược với ứng viên:

1. **Đổi mật khẩu đăng xuất cả phiên hiện tại** (D85.6). Cách này dùng lại nguyên vẹn đường reset đã được kiểm (INV-11/28, DEBT-050/055); không có logic "trừ phiên hiện tại" và không có race giữa revoke và tạo phiên mới.
2. **DEBT-577 sửa bằng fragment, không chấp nhận ⚠** (D85.3). Lý do: chi phí thấp, chưa phát hành nên không cần tương thích, và phần rủi ro còn lại của query (log proxy/CDN, lịch sử trình duyệt) nằm ngoài tầm kiểm soát của IdP.

### Đã kiểm trên code

- `authorize.service.ts:84-97`: `AUTHORIZE_PARAM_KEYS` không có `request`/`request_uri`. Discovery không khai `request_uri_parameter_supported`, mà mặc định của OIDC Discovery là `true` ⇒ đang quảng cáo sai. Chỗ chèn kiểm: đầu Phase 2 (sau khi redirect_uri đã được tin).
- `userinfo.controller.ts:82`: chỉ có GET. Preflight đã cho POST (`client-cors.helper.ts:34`).
- Lockout: `user.service.ts:199-265` khoá 15' theo tài khoản. Limiter `ui.controller.ts:509-516` có chiều `account` (mặc định 100/60 s), cũng là một vector khoá. `setPassword` đã gỡ khoá tạm.
- Mật khẩu: chỉ kiểm độ dài 8–128 (`authentication.service.ts:313-316`); assets của Nest chỉ có `views`/`public`.
- Token email: `authentication.service.ts:289-290` dùng query. Logger cắt query (`logger.module.ts:53`). Đã có script ngoài `/assets/logout-redirect.js`.
- Key: `key-provider.ts:19` chỉ có `active|retiring`. Cả Local lẫn Vault ký ngay bằng version mới. fe-admin có enum zod và nhãn ở 3 file.
- Supply chain: 18 dòng `uses:` theo tag trôi. `pnpm sbom` có sẵn trong pnpm 12.6.0 (đã thử: be 177 component, fe-admin 233). `mongoose` 9.10.2 có 4 GHSA mới (2026-11-10); `pnpm audit` hôm nay ra high 2 / moderate 2 / low 1.

## Quyết định (người dùng ủy quyền; chi tiết ở fold)

1. **D85.1**: run 85 gồm T1–T6; run 86 gồm 577, 393 BE+FE, 572, 583; X6 dời: đợt 3 = run 87, đợt 4 = run 88.
2. **D85.2 DEBT-575**: throttle theo (email, mạng /32 hoặc /64) 5/15', theo email 20/15' cho thiết bị chưa tin cậy, theo (email, device cookie) 10/15' cho thiết bị tin cậy; bỏ khoá cứng; reserve trước Argon2; Redis lỗi ⇒ fail-closed. Đã loại progressive delay (giữ kết nối, khuếch đại DoS) và kiểu chỉ (account, IP) (botnet vượt qua được). Không CAPTCHA, không gọi ngoài.
3. **D85.3 DEBT-577**: sửa bằng fragment + `replaceState` + script ngoài, ở run 86. Lý do viết theo ASVS 14.2.1 ở fold.
4. **D85.4 DEBT-574**: SecLists (MIT) commit `64b41f2…`, `100k-most-used-passwords-NCSC.txt` (blob `38eb377…`), dẫn xuất 10 000 dòng dài 8–128, NFKC lowercase, khoảng 100 KB, có NOTICE ghi công NCSC/HIBP CC BY 4.0. Đưa vào build qua nest assets. Tải 1 lần, cần người dùng cho phép. 6.2.12 ⇒ ⚠ (DEBT-587).
5. **D85.5 DEBT-576**: `pnpm sbom` CycloneDX theo từng gói deploy, artifact CI 90 ngày; audit hằng ngày; bảng thời hạn Critical/High/Moderate/Low × runtime/dev.
6. **D85.6 DEBT-573**: route, CSRF, 2 limiter, CAS trên hash cũ, revoke toàn bộ (gồm device trust), thư thông báo khi đổi và khi reset, audit `AUTH_PASSWORD_CHANGED`.
7. **D85.7 DEBT-393**: trạng thái `pending` suy ra theo thời gian từ `createdAt + KEY_PREPUBLISH_SEC` (env mới 0–86400, mặc định 3600); 409 `rotation_pending`; emergency gỡ cả pending; Vault ký với `key_version`; admin API thêm `activatesAt`; thay đổi fe-admin liệt kê ở fold.
8. **D85.8 DEBT-553/557**: pin theo SHA đã peel; checkout v7.0.1, setup-node v7.1.0, cache v6.1.0, upload-artifact v7.0.2, codeql-action v4.39.3 (bảng SHA ở T1). Lý do lên major: v4 chạy Node 20 đã hết hạn; đã đọc release note, không có thay đổi chạm tới cấu hình của ta.
9. **D85.9**: `POST /userinfo` chỉ nhận token từ header; discovery khai `request(_uri)_parameter_supported: false`.
10. **D85.10**: P-level của 572/583/C-6.2c.

## Cổng security design

**T2 (`/authorize`, `/userinfo`)**
- Tài sản: tính đúng của request uỷ quyền (một request object không được kiểm mà bị bỏ qua thì RP tưởng tham số ký của mình đã được áp); claim người dùng. Trust boundary: RP → `/authorize`; RP/SPA → `/userinfo`.
- Invariant: chỉ redirect sau khi redirect_uri khớp chính xác (INV-3); có `request(_uri)` thì không tạo context/code. `/userinfo` không bao giờ đọc token từ query/body.
- Abuse cases: `request_uri` trỏ SSRF (không bao giờ fetch); redirect_uri chưa đăng ký + `request` ⇒ trang first-party; tham số lặp/rỗng ⇒ không 500; ID token dùng ở POST; token trong body.
- Failure semantics: key provider lỗi ⇒ 503 như GET. Exposure: `no-store`, `WWW-Authenticate`, ACAO theo client. Ca âm: (5), (8), (9) ở fold.

**T3 (mật khẩu)**
- Tài sản: mật khẩu mới. Invariant: không lưu mật khẩu nào thuộc tập hoặc trùng từ ngữ cảnh; phản hồi register không phụ thuộc tài khoản có tồn tại hay không. Failure: file thiếu ⇒ không khởi động (fail-closed). Exposure: câu cố định, không echo. Ca âm: token reset không bị tiêu khi mật khẩu bị từ chối.

**T4 (chống khoá)**
- Actor: kẻ đoán từ 1 mạng, botnet, kẻ chung NAT, kẻ đã từng biết mật khẩu (giữ device cookie).
- Invariant: không chuỗi request nào của kẻ không có device cookie hợp lệ của nạn nhân chặn được nạn nhân trên thiết bị quen; Argon2 chạy tối đa N lần mỗi (email, mạng) mỗi cửa sổ, kể cả khi request đồng thời.
- Abuse cases: tấn công DoS lockout (đóng); botnet (bị trần A chặn); cookie tin cậy dùng chéo user (bị chặn vì trust gắn với user); cookie bịa; email không tồn tại (cùng ngưỡng, cùng phản hồi ⇒ không enumeration); race (reserve nguyên tử); credential cũ sau reset (ZSET bị xoá); IPv6 xoay trong /64.
- Failure semantics: Redis lỗi ở đường kiểm ⇒ fail-closed; Redis lỗi khi ghi trust ⇒ fail-safe (chỉ mất trạng thái tin cậy); không lũ audit (1 bản ghi mỗi bucket mỗi cửa sổ).
- Exposure: câu 429 cố định, không nói bucket nào; cookie `HttpOnly`, `__Host-` khi chạy secure.
- Giới hạn còn lại (ghi tài liệu): kẻ chung NAT hoặc chung /64 với nạn nhân, khi nạn nhân dùng thiết bị mới, chặn được ≤ 15' mỗi lần; nạn nhân thoát bằng reset.

**T5 (đổi mật khẩu)**
- Actor: chủ tài khoản; kẻ cướp phiên không biết mật khẩu hiện tại; CSRF.
- State transition: hash cũ → hash mới (CAS) → mọi phiên/family/device trust bị huỷ → cookie bị xoá. Revoke lỗi ⇒ 5xx, không rollback (DEBT-050).
- Abuse cases: brute force mật khẩu hiện tại qua phiên bị cướp (5/15', reserve trước Argon2); race với reset (CAS ⇒ 409); admin khoá giữa chừng (CAS lọc theo lock ⇒ 409); CSRF (guard); user chỉ có federation.
- Exposure: không echo; thư thông báo không có token; `no-store`.

**T1 (supply chain)**
- Tài sản: tính toàn vẹn của CI/release.
- Invariant: không action nào chạy theo ref có thể dời; mọi advisory high/critical được phát hiện trong ≤ 24 h kể cả khi không có push.
- Abuse case: tag bị dời (pin theo SHA đã peel, xác minh bằng `git ls-remote` ngay trước khi sửa).
- Failure: registry lỗi ⇒ audit đỏ (fail-closed, như hiện tại).

## Điểm mạnh

- Mọi ứng viên đều có số dòng trỏ đúng code (đã đối chiếu). Checklist run 84 cho bằng chứng `grep -F` nên T6 chủ yếu là cập nhật.
- Hạ tầng sẵn có làm lô này rẻ: `reserve/refund` nguyên tử (DEBT-029), `revokeAllUserCredentials` với first-error-wins (DEBT-055), recorder `MAILER`, `hostCookieName`, tiền lệ script ngoài cho trang logout, `pnpm sbom` có sẵn.
- Quy tắc 14 ngày và ngoại lệ bảo mật đã có tiền lệ rõ (run 83) ⇒ quyết định mongoose và codeql v4 không cần chính sách mới.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các điểm ứng viên để mở đều đã chốt trong fold:

- [x] Phát hiện P0 ngoài ứng viên (mongoose, CI audit đỏ) ⇒ đưa vào T1, làm đầu tiên.
- [x] Discovery quảng cáo sai `request_uri_parameter_supported` (mặc định `true`) ⇒ sửa trong T2.
- [x] Limiter chung có chiều `account` cũng là vector khoá ⇒ bỏ cho `login` trong T4.
- [x] Lô vượt 6 task ⇒ tách run 86, dời kế hoạch X6 một run.
- [x] STATUS ghi "pnpm audit 0" đã cũ ⇒ sửa ở STATUS (lần cập nhật này).

## Đề xuất (không bắt buộc)

- DEBT-585: sau khi người dùng xem cột Manifest của Dependabot, sửa giả định "npm mù" (DEBT-500) nếu nó sai.
- DEBT-586: trang cho user xem và thu hồi thiết bị tin cậy, gộp với trang phiên (DEBT-582).
- DEBT-587: kiểm mật khẩu đã lộ (ASVS 6.2.12) nếu sau này chính sách cho phép gọi ngoài (HIBP range API, k-anonymity), hoặc dùng danh sách offline lớn hơn.
- DEBT-588: quy trình làm mới danh sách mật khẩu (pin commit SecLists, xem lại hằng năm).
- DEBT-589: dọn field cũ `failedLoginCount`/`lockTransitionNonce` và hiển thị trong admin sau T4.
- DEBT-590: pin digest cho image test trong CI và `docker-compose.yml`.
- DEBT-591: quét lỗ hổng base image Docker (Dependabot không cảnh báo cho docker).
- DEBT-592: ký/attest SBOM và provenance của image.
