# Tích hợp RP / RS với sso-idp: thu hồi token

Tài liệu cho người tích hợp: RP (Relying Party, ứng dụng đăng nhập qua IdP) và RS (Resource Server, API nhận access token). Hợp đồng token đầy đủ ở [spec §8](agile/sso-idp/spec.md#8-token-contract). Endpoint lấy từ discovery `/.well-known/openid-configuration` (`jwks_uri`, `introspection_endpoint`, `end_session_endpoint`).

Tóm tắt:

| Việc | Cách làm |
|---|---|
| Thao tác nhạy cảm ở RS | Gọi `POST /introspect` mỗi request; `active: false` ⇒ 401 |
| Thao tác thường ở RS | Verify JWT cục bộ, chấp nhận độ trễ thu hồi ≤ `ACCESS_TOKEN_TTL` |
| `ACCESS_TOKEN_TTL` | Giữ 900 s |
| ID token | Không thu hồi được; chỉ dùng xác lập danh tính lúc đăng nhập |
| Phát tán denylist tới RS | **Không có** |
| Mã redirect | Redirect về `redirect_uri` sau màn consent và về `post_logout_redirect_uri` sau `POST /logout` là `303` (RP không phải đổi gì) |

## 1. RS: thao tác nhạy cảm dùng `/introspect`

Access token là JWT tự chứa. RS verify cục bộ chỉ kiểm chữ ký và claim, nên **không thấy** các tín hiệu thu hồi nằm phía IdP. Các tín hiệu đó chỉ hiện qua `/introspect` (`active: false`) và `/userinfo` (401 `invalid_token`). Hai endpoint dùng chung một hàm kiểm `isAccessTokenLive` (`be/src/modules/oauth/access-token-liveness.ts`).

Thao tác nhạy cảm (đổi tiền, đổi quyền, xoá dữ liệu, thao tác quản trị…) phải gọi `/introspect` ở **mỗi request**, không cache kết quả `active: true`.

### Những gì làm access token inactive trước `exp`

Đây là danh sách đầy đủ theo code hiện tại. Ngoài các trường hợp này, access token còn hợp lệ tới `exp`, kể cả với `/introspect`.

**a. Denylist `at_revoked:{jti}`** (chỉ một nơi ghi):
- Authorization code bị dùng lại ở `/token` bởi **chính client đã đổi code đó** ⇒ access token đã phát từ code bị chặn theo `jti` tới `exp`, refresh family bị thu hồi (RFC 6749 §4.1.2). Client khác dùng lại code thì không đụng gì.

**b. Phiên IdP bị chấm dứt chủ động** (tombstone `sess_end:{sid}`). Chỉ áp dụng cho access token **có claim `sid`**:
- Đăng xuất `POST /logout`: phiên hiện tại; `scope=all` ⇒ mọi phiên của user.
- Thu hồi thiết bị ở `/account/sessions/revoke` và `/account/sessions/revoke-others`.
- Đặt lại mật khẩu (`POST /reset`) và đổi mật khẩu (`POST /account/password`) ⇒ mọi phiên.
- Bật MFA (`/account/mfa/confirm`) và tắt MFA (`/account/mfa/disable`) ⇒ mọi phiên.
- Admin: khoá user (`:id/lock`), thu hồi phiên (`:id/sessions/revoke`), reset MFA (`:id/mfa/reset`) ⇒ mọi phiên.

Phiên hết hạn tự nhiên (idle/absolute) hoặc bị thay khi đăng nhập lại **không** ghi tombstone, nên không làm access token inactive.

**c. Trạng thái hiện tại của client / resource / user**:
- Client phát hành token không còn tồn tại.
- Token được phát trước lần client bị vô hiệu hoá gần nhất (kể cả khi client đã bật lại).
- Client không còn được cấp resource ứng với `aud`.
- Token `aud` = admin API mà client đã mất quyền admin.
- User `sub` không còn tồn tại.

**Không** làm access token inactive (token vẫn sống tới `exp`, kể cả qua `/introspect`):
- `POST /revoke` với access token: trả 200 nhưng không làm gì; `/revoke` chỉ thu hồi refresh token (cả family).
- Thu hồi consent (`/account/apps/revoke` hoặc admin): chỉ thu hồi refresh family.
- Admin thu hồi một refresh family: không đụng access token đã phát.

### Cách gọi

RS đăng ký là **client confidential** (`client_secret_basic` hoặc `client_secret_post`) và có resource của mình trong `allowedResources`. Client `none`/public hoặc sai thông tin xác thực ⇒ 401 `invalid_client`, không có body introspect; sai liên tục ⇒ 429 + `Retry-After`.

```sh
curl -sS -X POST "<issuer>/introspect" \
  -u '<client_id>:<client_secret>' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'token=<access_token>'
```

Kết quả:
- `{"active": true, "token_type": "access_token", "scope", "client_id", "sub", "aud", "exp", "iat", "jti"}` ⇒ RS vẫn phải kiểm `aud` là định danh của mình và `scope` đủ cho thao tác.
- `{"active": false}` ⇒ trả 401. Đây là hình dạng chung cho mọi ca âm. Ví dụ token sai, hết hạn, bị thu hồi, là ID token, hoặc caller không phải `client_id` của token và không giữ `aud` của token.
- 5xx ⇒ **fail-closed**: từ chối request, không coi như `active: true`. IdP không bao giờ trả `active: true` khi Redis/Mongo lỗi.

Không log giá trị token hay `<client_secret>`. Secret lấy từ secret store lúc chạy, không ghi vào code/config được commit.

## 2. RS: verify JWT cục bộ (thao tác chịu được độ trễ)

Chỉ dùng cho thao tác chấp nhận được việc token đã bị thu hồi vẫn qua được tới `exp`, tức tối đa `ACCESS_TOKEN_TTL`.

Kiểm theo đúng thứ tự, sai bất kỳ ⇒ 401:
1. Header `alg` = `RS256`, **chỉ** `RS256`; từ chối `none`/`HS*`. Header `typ` = `at+jwt`: ID token cùng khoá ký nhưng `typ: JWT`, phải bị từ chối.
2. Chữ ký theo key `kid` trong JWKS (`jwks_uri`).
3. `iss` = issuer chính xác (so khớp chuỗi).
4. `aud` là **một chuỗi** và bằng định danh resource của RS. Không chấp nhận mảng, không so với `client_id`.
5. `exp` chưa qua (lệch giờ ≤ vài giây); `iat` có mặt.
6. `scope` đủ cho thao tác. Chỉ tin `sub`/`client_id`/`scope` sau các bước trên.

JWKS:
- IdP trả `/jwks.json` với `Cache-Control: no-cache`.
- RS được cache JWKS trong process, nhưng **không lâu hơn `KEY_PREPUBLISH_SEC`** (mặc định 3600 s). Rotate thường đăng key mới lên JWKS `KEY_PREPUBLISH_SEC` giây trước khi dùng nó để ký. Cache lâu hơn thì RS sẽ gặp `kid` chưa biết.
- Gặp `kid` lạ ⇒ tải lại JWKS một lần (có giới hạn tần suất), vẫn không có ⇒ 401. Rotate khẩn cấp bỏ qua giai đoạn pre-publish, key mới ký ngay.

## 3. `ACCESS_TOKEN_TTL` giữ 900 s

`ACCESS_TOKEN_TTL` = 900 s (15 phút) là giá trị đã chốt (plan §12). Đây cũng là cửa sổ tối đa một access token đã bị thu hồi vẫn được RS verify cục bộ chấp nhận. Tăng TTL là mở rộng cửa sổ đó. Không tăng để giảm số lần refresh; RP dùng refresh token (`offline_access`) thay vào đó.

## 4. ID token không thu hồi được

- ID token (`typ: JWT`, `aud` = `client_id`, TTL = `ACCESS_TOKEN_TTL`) không có cơ chế thu hồi nào: không denylist, không introspect (`/introspect` trả `active: false` cho ID token).
- RP chỉ dùng ID token để **xác lập danh tính lúc đăng nhập** (kiểm `iss`, `aud`, `exp`, `nonce`, chữ ký), rồi tạo phiên RP riêng.
- **Không** dùng ID token làm credential gọi API, và RS không nhận ID token.
- Phiên RP theo cơ chế logout hiện có: RP-initiated logout qua `end_session_endpoint` (`/logout`, kèm `id_token_hint`) và front-channel logout tới các RP đã nhận code trong phiên. Xem spec §9.8.

## 5. Không có phát tán denylist tới RS

IdP **không** đẩy (push, webhook, pub/sub) danh sách token bị thu hồi tới RS. Denylist `at_revoked:{jti}` và tombstone `sess_end:{sid}` chỉ nằm trong Redis của IdP, chỉ đọc được qua `/introspect` và `/userinfo`. RS cần thấy thu hồi ngay thì gọi `/introspect` (mục 1). Nếu không, RS chấp nhận độ trễ ≤ `ACCESS_TOKEN_TTL` (mục 2).
