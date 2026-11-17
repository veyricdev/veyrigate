# Tech Lead Review — 2026-11-17 (run 92 `92-ci-green`)

## Kết luận: PASS (có điều kiện: thi hành D92.1–D92.14 ở cuối `tasks.md`)

Bảy task T1–T7 khả thi, đúng vấn đề (CI đỏ do 6 nguyên nhân độc lập + 40 cảnh báo CodeQL), không cần analyst. Plan có hai lỗ hổng, đã vá bằng quyết định thay vì REJECT:

1. **Job `e2e` không có Mailpit.** Bốn spec (`account-self-service`, `mfa`, `password-change`, `token-fragment`) đọc thư qua `http://localhost:8025`, BE gửi tới `smtp://localhost:1025`. Trên CI, các spec này không thể xanh (D92.5).
2. **"Treo 6 giờ" thực chất là "chậm có giới hạn".** Mọi vòng lặp trong `e2e/tests/support/*` đều có giới hạn. Tuy vậy 18 spec đặt `test.setTimeout` 90–240 s, Playwright không có `maxFailures` và `globalTimeout`. Một lỗi hệ thống (vd. mọi login admin kẹt ở `/login/mfa`) làm mọi test chạy tới hết timeout riêng, cộng dồn hàng giờ. Phải có cầu chì fail nhanh. Nguyên nhân gốc vẫn phải tìm (D92.5).

## Kiến trúc đề xuất

Không đổi kiến trúc sản phẩm. Về CI:

- Giữ một workflow `ci.yml`, các job độc lập.
- Service container chỉ dùng image pin digest đã có (redis 7.4.10, mailpit v1.21).
- Không tách int thành shard ở run này: `vg:int-lock`, cổng cố định, và Vault/Sentinel đều nằm trong job int.
- Không thêm GitHub secret: mọi khoá test sinh theo lượt và được mask.

## Điểm mạnh

- Bằng chứng CI đọc trực tiếp từ log, mỗi job có một nguyên nhân cụ thể.
- Ràng buộc cứng rõ ràng: không rewrite lịch sử, không in secret.
- T1 bắt buộc xác minh từng phát hiện và có điều kiện DỪNG khi gặp khoá thật.
- T7 ưu tiên đúng các cảnh báo trên đường xác thực: logout, tra cứu client, Bearer.

## Vấn đề (đã chuyển thành quyết định bắt buộc, không REJECT)

- [x] e2e thiếu service Mailpit ⇒ D92.5.
- [x] e2e không có cầu chì fail nhanh ⇒ D92.5: thêm `maxFailures`, `globalTimeout`, chặn trên cho bộ cấp mã TOTP.
- [x] Mâu thuẫn ràng buộc: "KHÔNG tạo container" và việc chạy `docker-smoke.sh` / gitleaks image cục bộ ⇒ D92.7.
- [x] T5: `workerIdleMemoryLimit` không có tác dụng hiển nhiên khi script chạy `--runInBand` ⇒ D92.3 bắt buộc đo trước và chứng minh hiệu lực.
- [x] T1: không nên dựa vào cwd mặc định của image gitleaks để tìm `.gitleaksignore` ⇒ D92.8 truyền cờ tường minh.
- [x] T2: khoá MFA mới phải vào canary của check 11 và vào các lượt CLI 12/13. Check 9 vẫn phải fail vì đúng biến dự định ⇒ D92.6.
- [x] T7: thiếu tiêu chí sửa/dismiss và cổng security cho các bản sửa trên trust boundary ⇒ D92.9, D92.10.

## Cổng security (T7: các sửa chạm trust boundary)

| Bản sửa | Tài sản / biên | Invariant | Abuse case | Test âm bắt buộc |
|---|---|---|---|---|
| **#1** `bearerToken` | Access token trong header `Authorization` (mọi API Bearer) | Tập chấp nhận giữ nguyên: `Bearer` không phân biệt hoa thường, ≥ 1 dấu cách, token đã trim. Header lặp ⇒ `undefined`. | ReDoS bằng header 16 KiB toàn dấu cách | `Bearer` + 16 KiB dấu cách (có và không có token) ⇒ kết quả như hàm cũ, < 50 ms. Bảng ca cũ giữ xanh. |
| **#9** logout `state` | Redirect sau logout về URI đã đăng ký | `state` không phải string (lặp/mảng) ⇒ coi như vắng, giống quy tắc `> MAX_STATE_LENGTH`. Không 500, không ghép giá trị mảng. | Tham số lặp vượt kiểm tra độ dài; nối chuỗi `a,b` | `?state=a&state=b` với `post_logout_redirect_uri` hợp lệ ⇒ redirect không có `state`. Các tham số logout khác bị lặp ⇒ không 5xx. |
| **#7/#8** truy vấn Mongo | Bảng `clients` / `resources` | Giá trị không phải string không bao giờ tới filter Mongo. `findByClientId` trả `null` (= client lạ). | Operator injection `client_id[$ne]=` qua form/JSON | Unit: `{ $ne: null }` ⇒ `null`, không gọi `findOne`. Int: `/token` với `client_id` dạng object ⇒ `invalid_client`/400, không cấp token. Admin create với `resourceId` object ⇒ 400. |
| **#2** `logout-redirect.js` | Điều hướng trình duyệt sau front-channel logout | Chỉ điều hướng URL tuyệt đối `http:`/`https:` (`new URL(target, location.href)`), còn lại không làm gì. Kiểm tra phía server với URI đã đăng ký giữ nguyên. | `javascript:` / `data:` trong `data-target` | Test với `document`/`window` giả: `javascript:alert(1)` ⇒ không gọi `replace`; `https://…` ⇒ có gọi. |

**Failure semantics:** không có phụ thuộc ngoài mới. Riêng `findByClientId` khi gặp kiểu sai thì fail-closed: client lạ ⇒ `invalid_client`.

**Exposure:** không phản chiếu giá trị đầu vào trong response/log; text lỗi giữ cố định như hiện tại.

## Đề xuất (không bắt buộc)

Đã chuyển vào backlog:

- **DEBT-673:** `.agents/` có 266 file vendored bị track trong repo sản phẩm, nên bị gitleaks/CodeQL quét.
- **DEBT-674:** cấu hình `query-filters` của CodeQL cho thư mục test sau khi đã có dữ liệu triage.
- **DEBT-675:** không chạy được smoke image cục bộ dưới ràng buộc hạ tầng chung, nên CI là cổng duy nhất.
