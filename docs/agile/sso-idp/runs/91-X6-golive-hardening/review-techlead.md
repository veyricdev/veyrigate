# Tech Lead Review — 2026-11-16

Đối tượng: nháp `tasks.md` của orchestrator (analyst bỏ qua), HEAD `c7c54c2`. Đã kiểm code đích qua CodeGraph: `authentication.service.ts` (`detach`/`settled`/`register`/`forgotPassword`/`issueToken`), `common/metrics/metrics.ts` + `ops-rules.spec.ts` + `ops/prometheus/alerts.yml`, `token.controller.ts` `handleAuthorizationCodeGrant`, `authorization-code.service.ts` (Lua consume), `access-token-liveness.ts`, `ui.controller.ts` `home`, `common/http/request-id.ts` + `framework-errors.ts`.

## Kết luận: PASS (sau khi fold — `tasks.md` đã viết lại)

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Giữ nguyên monolith NestJS; không thêm dịch vụ hay dependency mới. Điều chỉnh so với nháp:

- Metric dùng tiền tố có sẵn `sso_` (nháp ghi `idp_`); alert đặt trong `ops/prometheus/alerts.yml` để `ops-rules.spec.ts` tự kiểm — nháp chỉ nói runbook (D91.2).
- Đếm thêm lỗi gửi thư `auth_mail`: `issueToken` hiện `void mailer.send().catch(log)` cũng im lặng như lỗi DB (D91.3).
- DEBT-651: code nằm trong Redis và bị `DEL` khi consume ⇒ không có "bản ghi code" để ghi family như nháp. Thiết kế lại: dấu `authz_code_used` ghi nguyên tử trong Lua + cờ `replayed` đọc lại sau khi phát (đóng cửa sổ đua giữa consume và insert family) + chỉ thu hồi khi cùng client (chống confused deputy) (D91.6/D91.7).
- AT là JWT không trạng thái; `isAccessTokenLive` chỉ kiểm tombstone `sid` ⇒ "AT inactive" cần denylist `jti` có TTL, đặt trong hàm dùng chung nên áp luôn cho introspect/userinfo/admin guard (D91.8).
- DEBT-667 (d) quyết: nhận `x-request-id` chỉ từ địa chỉ thuộc `TRUST_PROXY`, so CIDR bằng `node:net` `BlockList` (D91.10).
- Thứ tự lô: A (T1→T2→T3 cùng `detach`) → B (T4 riêng, rủi ro cao) → C → D.

## Điểm mạnh

- Nháp chọn đúng các mục còn mở sau pentest và điều kiện go-live (2); ràng buộc cứng đầy đủ (Mailpit/harness, int một lượt, không đọc secret).
- Giữ nguyên nguyên tắc D90.19 (không thêm `await` phụ thuộc-tồn-tại trên đường phản hồi) cho T3.

## Vấn đề (đã sửa khi fold — không còn chặn)

- [x] T2 (DEBT-651) nháp "ghi family/jti vào bản ghi code" không khả thi với store hiện tại (Redis, `DEL` khi consume) và bỏ sót đua lặp-trong-lúc-phát ⇒ thiết kế 4 bước trong `tasks.md` T4.
- [x] Thiếu ranh giới tin cậy cho lần đổi lặp: client B trình code của client A không được thu hồi token của A ⇒ AC âm `OAUTH-CODE-REPLAY-XCLIENT` + int.
- [x] Failure semantics chưa nêu: Redis lỗi khi ghi dấu ⇒ fail-closed 500 + revoke family; lỗi khi revoke ở lần lặp ⇒ 500; denylist lỗi ⇒ ném (fail-closed như hiện tại); shutdown chờ có giới hạn 5 s.
- [x] T3 thiếu giới hạn lạm dụng (spam thư tới hộp thư nạn nhân qua `/register` lặp) ⇒ chỉ phát khi không còn token sống (≤ 1 thư/24 h) + throttle sẵn; harness timing biến thể chưa xác minh.
- [x] AC chung chung ("lỗi giả ⇒ counter +1") ⇒ đã thành AC đo được: series theo `what`, `/metrics` không chứa email, phản hồi giống hệt nhánh thành công, promtool test qua `ops-rules.spec.ts`.
- [x] Exposure: audit reuse không chứa code/jti; `error_description` của `response_mode` không phản chiếu input; log shutdown chỉ có số lượng.

## Security design gate (T4 chạm trust boundary token endpoint)

- Tài sản: RT family, AT (JWT), code. Actor: client hợp lệ, kẻ chặn được code (cùng client_id với public client, hoặc client khác). Ranh giới: client đã xác thực ở `/token`.
- Invariant: một code ⇒ tối đa một bộ token còn sống; sau lần lặp cùng client, không token nào từ code đó còn active ở IdP (RT refresh 400, AT `active:false`, userinfo 401).
- Abuse: replay (ca chính), đua replay giữa consume và phát (cờ `replayed`), confused deputy (khác client ⇒ không thu hồi), DoS (kẻ có code chỉ thu hồi được bộ token của chính code đó — chấp nhận, đúng RFC).
- Failure: Redis/Mongo lỗi ⇒ 500, không trả token; denylist lỗi ⇒ fail-closed.
- Giới hạn chấp nhận: ID token và RS tự verify JWT cục bộ ⇒ DEBT-669.

## Đề xuất (không bắt buộc)

- DEBT-669 (mới): ID token và RS verify JWT cục bộ không thấy denylist `jti`; ghi vào hướng dẫn RP (dùng introspect cho thao tác nhạy cảm, AT TTL ngắn).
- DEBT-670 (mới): receiver/route Alertmanager do môi trường quyết định; repo chỉ có rule. Gộp vào smoke go-live (1).
- Panel Grafana cho counter mới: tuỳ chọn trong lô A.

## Bổ sung — sau senior REJECT lô A (2026-11-16)

Tech-lead bỏ sót kịch bản pre-hijacking ở D91.4 gốc: gửi lại thư xác minh để nạn nhân tự kích hoạt mật khẩu của kẻ tấn công. Cách chốt lại:

- **D91.4 sửa**: nhánh gửi lại phát token đặt lại kèm thư "hoàn tất đăng ký".
- **D91.13**: invariant khoá bằng int — mật khẩu do bên thứ ba đặt không đăng nhập được sau luồng phục hồi.
- **D91.14**: DEBT-671 làm ngay trong run 91 — `/verify-email` đòi mật khẩu, kiểm trước khi tiêu thụ token, ≤ 5 lần sai/token.
- **runbook-ops §13 bước 3** viết lại theo `what`.

Chi tiết và AC ở `tasks.md` T3. Kết luận cho plan đã sửa: **PASS**; lô A quay lại backend-dev (retry 1).
