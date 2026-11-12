# Senior Review — 2026-11-11 (run 86, T1–T5 BE + T3 FE, code chưa commit trên `e39b7b5`)

## Kết luận: PASS

Không có 🔴. Ba 🟡 ghi vào backlog (DEBT-605/606/607). Chuyển **tester** (T6).

## Tổng quan

Diff bám sát fold D86.1–D86.15, comment giải thích "vì sao" ở mọi chỗ đổi hành vi, mutation được làm thật. Điểm tốt:
- T1 cắt token khỏi request line ở cả ba lớp: link (`hash`), GET (bỏ `@Query`), helper int `tokenFromMailLink` (ném lỗi nếu link có `?`). Nhờ helper này, mọi int đọc thư cũng là bằng chứng cho AC1.
- T4 tách `renderLogoutConfirm` dùng chung GET/POST, nên POST không `_csrf` thừa hưởng nguyên quy tắc "chỉ phản chiếu URI đã kiểm" và CSP nới theo origin đã kiểm.
- T2 suy trạng thái key theo thời gian và đọc ở mỗi lần ký, không có job nền. Pending được kiểm trong mutex Local. PEM chỉ bị xoá khi key không còn ký trong state mới, chặt hơn chữ của fold.
- T3 dùng tập kid cho uncertain normal, gửi lại 0 lần, re-read khi 409.

Đã chạy: be unit 3 lượt liên tiếp, 976/976 cả 3 (không tái hiện lỗi đỏ 1 lần); int có mục tiêu `run86-*` + `ui.int-spec` 114/114.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

**T1 token sang fragment (DEBT-577)**
- Phản chiếu: `verifyForm`/`resetForm` không còn đọc query; template `value=""` cố định. Int AC3 kiểm chuỗi đánh dấu không có trong body ✅.
- XSS trong script: regex có `^…$`, charset base64url, chỉ gán `.value`, không `innerHTML`. Không có sink HTML ✅.
- CSP: script ngoài `/assets/token-fragment.js`, không inline, CSP `=== buildCsp()` ✅.
- Thư HTML: link và mã đều qua `escapeHtml`. Mã là base64url nên escape chỉ là phòng xa ✅.
- Lộ thông tin: token chỉ còn trong thư và DOM; `replaceState` gỡ mọi `#token=` kể cả sai dạng. Rủi ro lịch sử trình duyệt đã có DEBT-604.
- Fail-safe: asset 404 hoặc fragment sai ⇒ field hiện ra để nhập tay. Xem 🟡1 cho đường nhập tay.

**T4 POST `/logout` (DEBT-572)**
- CSRF: thiếu khoá `_csrf` ⇒ chỉ render trang xác nhận (không `sessions.get`/revoke/audit/clear). Có khoá ⇒ `typeof !== 'string'` cho 400, còn sai giá trị (kể cả `""`) cho 403 trước mọi thao tác session. Guard (body thô) và handler (`body?._csrf === undefined` sau pipe) nhất quán: form/JSON không thể gửi khoá có giá trị `undefined` ✅.
- Identity thứ hai (HMAC cookie ẩn danh): để giả được, kẻ tấn công phải đọc cookie httpOnly của nạn nhân hoặc *đặt* cookie đó. Ở chế độ secure, `__Host-` chặn cookie tossing. Ở chế độ không secure thì còn rủi ro, giống mọi form ẩn danh hiện có. Hậu quả tối đa là đăng xuất. AC6 (cookie của trình duyệt khác ⇒ 403) và ca cookie rỗng có test ✅.
- Session fixation: logout không bao giờ tạo hay giữ phiên; cookie ẩn danh không được nâng lên thành phiên ⇒ không có đường fixation ✅.
- Tham số RP: đường xác nhận gọi `resolvePostLogoutRedirect(…, undefined)` như GET, chỉ phản chiếu URI hợp lệ (`id_token_hint` và `post_logout_redirect_uri` đã đăng ký). POST có `_csrf` vẫn kiểm lại như cũ ✅. `logout_hint`/`ui_locales` qua whitelist và không phản chiếu (AC7) ✅.
- Clickjacking: `frame-ancestors 'none'` không đổi ✅.
- Lệch 1 (`@Body() body: LogoutDto`, không dùng union): đúng. Union phát metadata `Object` nên ValidationPipe bỏ qua DTO. `body ?? {}` chỉ cần ở nhánh không `_csrf`, các nhánh sau luôn có body ✅.

**T2 pre-publish (DEBT-393)**
- INV-K2 (không ký bằng pending):
  - Local: `loadSigningKey` lấy `status === 'active'` từ `live()`.
  - Vault: `signWith` dùng `active(set)` cho `key_version`; `signOnce` retry khi version **active** đổi ✅.
- JWKS có pending: `getPublicKeys` = `live()` gồm cả pending, ở cả hai provider ✅.
- Thời điểm retire: Local `retireAt = fresh.activatesAt + retainSec`. Vault `activatesAt(v+1) + ttl + KEY_CACHE_TTL_MS`. INV-K3 ✅.
- Emergency gỡ pending:
  - Local: `next = [fresh]` và xoá mọi PEM cũ.
  - Vault: `min_*_version = n` + `trim` ✅.
  - Xem 🟡3 cho emergency dở ở Vault.
- PEM Local không bao giờ bị xoá khi key đang active/pending: tập `signing` được tính trên `live(next, now)` và loại `retiring` ✅ (lệch 2, hợp lý). Sau `init`/emergency, key ký luôn ✅.
- Rotate đồng thời:
  - Local: kiểm trong mutex, AC5 có test ✅.
  - Vault: không nguyên tử, vô hại, đã có DEBT-603.
- `keys.json` legacy: bỏ qua `status`; thiếu `activatesAt` ⇒ dùng `createdAt` và coi là đã kích hoạt; `retireAt` cũ được giữ; đọc không ghi file ✅.
- Lệch 3 ("kích hoạt lúc tạo ⇒ active bất kể đồng hồ"): hợp lý, cùng ngữ nghĩa với floor của Vault. Chặn được ca đồng hồ lùi làm sống lại key cũ đã mất PEM ở trạng thái thường gặp. Còn một ca hẹp hơn ở 💭3.
- Exposure: Admin DTO chỉ thêm `activatesAt`; 409 dùng câu cố định, không thời gian, không kid. Audit ghi `pendingKid` (kid là dữ liệu công khai) ✅.

**T5**
- `base-uri 'none'` có ở cả helmet lẫn `csp.ts`, test byte-identity giữ ✅.
- `networkOf`: cổng `isIP`, rồi `process`, đệm 4 hextet ⇒ key Redis không đổi byte ✅.

**Phụ thuộc thời gian (lỗi unit đỏ 1 lần)**: code mới không đọc đồng hồ thật trong unit. Local/Vault spec tiêm `now`. `now` mặc định đọc `Date.now()` ở mỗi lần gọi. 3 lượt full unit đều xanh. Không tìm thấy nguồn flake trong diff.

## 🟡 Nên sửa

1. 🟡 **`pattern` của field mã không hợp lệ, còn `maxlength` làm hỏng trim** — `be/src/views/reset.eta:1`, `be/src/views/verify.eta:1`.
   - `pattern="[A-Za-z0-9_-]{43}"`: trình duyệt hiện đại biên dịch `pattern` với cờ `v` (Chrome 112+, Firefox 116+, Safari 17+). Dưới cờ `v`, dấu `-` không escape trong lớp ký tự là lỗi cú pháp. Đã kiểm bằng `new RegExp('^(?:[A-Za-z0-9_-]{43})$','v')` ⇒ `Invalid character in character class`. Kết quả: pattern bị bỏ qua và console báo lỗi, tức thuộc tính này là code chết.
   - `maxlength="43"`: trình duyệt cắt phần dán vượt 43 ký tự. Dán `" <mã>"` (có khoảng trắng đầu) sẽ mất ký tự cuối, nên `@Transform` trim của D86.1 không cứu được. AC5 chỉ kiểm bằng POST trực tiếp nên không bắt được ca này.
   - Đề xuất: bỏ cả `pattern` lẫn `maxlength`. Server đã trim và đi đường lỗi sẵn có, không thêm oracle. Nếu muốn giữ kiểm phía client thì dùng `pattern="\s*[A-Za-z0-9_\-]{43}\s*"` và không đặt `maxlength`. → DEBT-605.
2. 🟡 **Nút Rotate bị khoá sau khi pending đã kích hoạt** — `fe-admin/src/routes/keys/index.tsx` (`hasPending`, `statusText`).
   - Danh sách chỉ được đọc một lần. Qua `activatesAt` thì hàng vẫn ghi "Pending" và nút vẫn disabled cho tới khi refetch (focus lại cửa sổ hoặc reload). Câu hướng dẫn lại bảo "Rotate again after it activates", nên admin dễ tưởng key bị kẹt.
   - Đề xuất: khi có pending, dùng `refetchInterval`, hoặc hẹn `setTimeout` tới `min(activatesAt)` rồi `refetch`. → DEBT-606.
3. 🟡 **Emergency Vault dở dang giờ để key bị lộ tiếp tục ký** — `be/src/modules/keys/vault-transit-key-provider.ts:226-243`.
   - Nếu `transit/rotate` thành công mà `config` lỗi, floor không được nâng. Version mới `n > floor` nên thành **pending** (`activatesAt = createdAt + prepublish`), và IdP vẫn ký bằng key cũ, đúng là key nghi bị lộ.
   - Trước run 86, `n` là `latest` nên ký ngay. Lỗi vẫn trả 5xx và runbook đã ghi "gọi lại emergency", nên đây không phải blocker.
   - Đề xuất: ở nhánh emergency, nếu `config` ném lỗi thì ghi log ERROR nói rõ "old key still signing", và cân nhắc để `active()` coi version mới nhất là active khi biết emergency đang dở. Tối thiểu nên thêm một ca vault-spec hoặc unit khoá hành vi này. → DEBT-607.

## 💭 Nit

1. `login-throttle.service.ts` (`networkOf`): `ipaddr.process` ném lỗi nếu gặp địa chỉ mà `isIP` của Node nhận còn ipaddr.js từ chối (ca biên, ví dụ zone lạ). Lỗi đó sẽ thành 5xx ở `/login`. Bọc `try { … } catch { return 'unknown'; }` thì rẻ.
2. `vault-transit-key-provider.ts` `active()`: fallback `?? set.versions.get(set.latest)!` không bao giờ chạy tới, vì luôn có ít nhất một version ≥ floor. Có thể bỏ.
3. `local-key-provider.ts` `live()`: một ca hẹp còn lại khi đồng hồ lùi. [A, B pending] ⇒ B kích hoạt ⇒ rotate (xoá PEM A, C pending) ⇒ đồng hồ lùi về trước `B.activatesAt` ⇒ A thành active mà không còn PEM, gây `ENOENT`. Chỉ ảnh hưởng dev; ghi chú cho DEBT-602.
4. Trang keys không có cột "Activates at"; thời điểm chỉ nằm trong nhãn trạng thái. Chấp nhận được.

## ✂️ Ponytail

- be/src/views/reset.eta:L1: delete: `maxlength="43" pattern="[A-Za-z0-9_-]{43}"` (pattern không hợp lệ dưới cờ `v`, maxlength chặn trim). Server trim + đường lỗi sẵn có.
- be/src/views/verify.eta:L1: delete: như trên.
- be/src/modules/keys/vault-transit-key-provider.ts:L318: shrink: `?? set.versions.get(set.latest)!` không chạy tới. Bỏ.
net: -3 lines possible.
