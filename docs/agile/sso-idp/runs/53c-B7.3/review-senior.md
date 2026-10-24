# Senior Review — 2026-10-24 — run 53c (B7.3 phần 3: Redis Sentinel + Redis-down 503 + DEBT-394/395/397)

## Kết luận: PASS

Không có 🔴. Còn 5 🟡, tất cả là tài liệu hoặc file mẫu ops, không có lỗi ở đường chạy của app ⇒ ghi DEBT-403…407.

Đã tự chạy lại (foreground): `pnpm -C be typecheck` 0, `pnpm -C be lint` 0, `pnpm -C be test` 36 suite / **519/519**. Không chạy int/sentinel/vault/E2E (bằng chứng dev ở `log.md` đủ chi tiết, có mutation 5/5; không dựng container).

## Tổng quan

Thay đổi gọn, đúng hướng fail-closed. Những điểm tốt:
- Predicate `isRedisUnavailable` dựng từ **bảng lỗi quan sát thật** (proxy refuse/blackhole + Sentinel thật), khớp chính xác `name`/`constructor === Error` + message, không dùng regex rộng. Unit test có cả các ca gần trùng (`TypeError` cùng message, message thêm `!`, object giả có `name`).
- 503 chỉ **thay mã trạng thái** ở những nhánh trước đây đã là 500. Không thêm nhánh nào trả 2xx, cookie hay token. Các lỗi lạ vẫn rơi về 500.
- Kill test `redis-down.int-spec.ts` kiểm cả 9 endpoint × 2 chế độ trên cùng một hợp đồng (503, `Retry-After: 5`, `no-store`, không cookie phiên, không chuỗi giống token, introspect không có `active`), rồi kiểm phục hồi: cùng code/RT/phiên dùng được tiếp, không kích hoạt phát hiện dùng lại (reuse detection).
- DEBT-394: `decodeProtectedHeader` nằm **ngoài** khối try, nên token hỏng định dạng vẫn ra 401/inactive. Chỉ lỗi khi lấy key mới bị bọc thành `KeyProviderUnavailableError`. Cả 4 caller của `verifyAccessToken` đều đã rethrow (đã grep: demo, tenant-context, userinfo, introspect). `AdminAuthErrorFilter` chỉ `@Catch(AdminAuthError)` nên lỗi 503 đi qua filter toàn cục, đúng như mong đợi.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

- **Fail-closed / không fail-open**: `oauth-exception.filter.ts:75` chỉ đổi status/error/description trong nhánh non-HttpException (log vẫn ghi như 500). `html-exception.filter.ts:17-31`: một `HttpException` (kể cả 429) giữ nguyên status. `token.controller.ts:489` và `introspect.controller.ts:265` trả lời sớm, không có token và không có `active`. Riêng `/introspect`: kiểm `ClientAuthRateLimitedError` trước, rồi đến dependency, rồi `IntrospectError`, nên thứ tự đúng và không biến lỗi thành `active:false`. Ma trận #28 giữ đúng nghĩa ("infra ⇒ 5xx, never active"), lý do ghi trong log là hợp lý.
- **`no-store`**: `/token` và `/introspect` gọi `noStore(reply)` ở đầu handler (`token.controller.ts:77/95`, `introspect.controller.ts:96`). Hai filter đặt `no-store` ở mọi nhánh. Kill test assert điều này.
- **Predicate có bắt nhầm không**: `MaxRetriesPerRequestError` chỉ có ở ioredis. `Error('Command timed out')` chỉ ioredis tạo bằng `new Error` (grep `src`: không có mã nào khác throw chuỗi này; lỗi Mongo/Vault là subclass hoặc message khác). Nếu bắt nhầm thì hậu quả chỉ là 500 thành 503, vẫn fail-closed, không lộ dữ liệu. Message 503 cố định, không echo input.
- **DEBT-394 / Vault down**: không có đường nào chấp nhận token khi không lấy được key (`createLocalJWKSet` chỉ chạy khi có `keys`). Logout: `logout.service.ts:77-87` `verifyHint` bắt mọi lỗi và trả `null`, rồi `resolvePostLogoutRedirect` trả `DEFAULT_REDIRECT` **trước** khi xét `post_logout_redirect_uri`. Không có open redirect; `post_logout_redirect_uri` chỉ được dùng sau khi hint verify xong và khớp exact allowlist (`isRegisteredRedirectUri`). Phiên vẫn bị chấm dứt. Chấp nhận được.
- **Token có `kid` lạ + Vault down**: `getPublicKeys(kidHint)` gọi `refresh(false)`, tối đa 1 lần / 5 s (cooldown), throw rồi thành 503. Kẻ tấn công chỉ đổi được 401 thành 503 cho token giả, không vượt được, không khuếch đại tải Vault (single-flight + cooldown).
- **DEBT-395**: `refresh(false)` dùng chung promise đang chạy. Nếu `latest` không đổi thì trả lỗi gốc (fail-closed). Unit: 10 lần ký bị từ chối ⇒ 1 lần đọc metadata.
- **DEBT-397 / mất ghi dở**: Nest gọi `dispose()` (đóng HTTP, Fastify chờ request đang chạy) **trước** `onApplicationShutdown`, nên khi tới hook không còn request nào ghi Redis. Khi `ready`: `QUIT` xếp sau các lệnh đang chờ, có hạn 1 s. Khi không `ready`: lệnh trong hàng đợi offline đằng nào cũng không tới được Redis. Luôn gọi `disconnect()` nên client không reconnect mãi. Timer được `clearTimeout`. Không thấy rủi ro mất dữ liệu mới.
- **Config Sentinel**: `superRefine` cấm có cả `REDIS_URL` lẫn `REDIS_SENTINELS`, cũng cấm thiếu cả hai. Credential/db chỉ hợp lệ ở chế độ Sentinel. Thông báo lỗi chỉ nêu tên biến (có test canary). `parseHostPort` từ chối host rỗng, port ngoài 1..65535, khoảng trắng, phần tử rỗng. `natMap` chỉ có trong `test/redis-sentinel.sentinel-spec.ts` (grep `src`: 0). Log lỗi client đi qua `scrubUriCredentials`.
- **Exposure**: `KeyProviderUnavailableError.message` cố định, cause chỉ vào log qua `errorForLog`. Body 503 không chứa chi tiết. Smoke/CI không đưa secret ra dòng lệnh.

## 🟡 Nên sửa

🟡 **Tài liệu: `NOREPLICAS` được hứa là 503 nhưng thực tế là 500**
`docs/agile/sso-idp/runbook-ops.md:314` (bước 3) và `ops/compose/prod.example.yml:13-15` ghi "`min-replicas-to-write 1` + replica chết ⇒ master từ chối ghi ⇒ app 503".
Vì sao: Redis trả `NOREPLICAS Not enough good replicas to write.` dưới dạng `ReplyError`, **không** khớp `isRedisUnavailable` ⇒ thực tế là 500 `server_error` không có `Retry-After`. Vẫn fail-closed, nhưng on-call đọc runbook sẽ chờ một tín hiệu không bao giờ xuất hiện. Thêm nữa, topology 1 replica + `min-replicas-to-write 1` nghĩa là **chỉ một replica chết cũng làm toàn bộ thao tác ghi dừng** (login/token).
Đề xuất: sửa hai chỗ thành "500 (fail-closed; DEBT-402 khi quan sát được thì đưa vào predicate kèm test)". Đồng thời ghi rõ đánh đổi này trong runbook-deploy §10, hoặc cân nhắc 2 replica trong mẫu. (DEBT-403)

🟡 **Tài liệu: "request lỗi không tiêu code/RT/phiên ⇒ chỉ cần thử lại" nói quá điều đã chứng minh**
`runbook-ops.md` bước 5, `runbook-deploy.md` §10 ("Request thất bại không tiêu code/RT/phiên"), log Task 1–4.
Vì sao: kill test chỉ chứng minh trường hợp Redis chết **trước** lệnh Redis đầu tiên của request. `Command timed out` không có nghĩa là lệnh chưa chạy: Redis chậm, hoặc failover xảy ra giữa request, vẫn có thể đã chạy Lua consume code (`authorization-code.service.ts:48-54`) rồi mới timeout ở bước `sessions.exists` sau đó. Khi ấy client nhận 503 + `Retry-After: 5`, thử lại sẽ ra `invalid_grant`. Vẫn an toàn, nhưng RP làm theo runbook sẽ tưởng là lỗi.
Đề xuất: đổi thành "thường không tiêu (Redis chết hẳn). Lệnh timeout có thể đã chạy, nên thử lại `/token` mà nhận `invalid_grant` thì bắt đầu lại flow". (DEBT-404)

🟡 **File mẫu: các thiết lập hardening có thể làm container không khởi động được**
`ops/compose/prod.example.yml:18-22` (`x-hardening`: `read_only`, `cap_drop: [ALL]`) áp vào `redis-master`/`redis-replica`/`vault-agent`, nhưng các service này không khai báo `user:`.
Vì sao: entrypoint chính thức của `redis` chạy dưới root rồi hạ quyền bằng `gosu`/`setpriv` (cần `CAP_SETUID`/`CAP_SETGID`). Entrypoint của `hashicorp/vault` gọi `setcap` (cần ghi vào rootfs, nhưng rootfs đang `read_only`) rồi `su-exec`. Khả năng cao 3 service này thoát ngay lúc khởi động. Riêng các sentinel thì chạy được, nhưng chạy bằng **uid 0** (không có cap). Log ghi "parse YAML OK, không chạy", nên chưa có gì xác nhận mẫu này chạy được.
Đề xuất: thêm `user: '999:999'` cho redis/sentinel (tmpfs `/etc/sentinel` đặt `uid=999`), và cho `vault-agent` thêm `user: '100:1000'` + `SKIP_SETCAP=true` + `SKIP_CHOWN=true` (khi đó bỏ được `cap_add: IPC_LOCK`). Ở run sau, nếu người dùng cho phép, chạy `docker compose -f ops/compose/prod.example.yml config` rồi thử một lần trên mạng tạm. (DEBT-405)

🟡 **File mẫu: comment nói sai về việc lộ secret qua `docker inspect`**
`ops/compose/prod.example.yml:9-10` + `:29`: "No secret … in `environment:` values … (docker inspect / ps leak): … the app gets its env from a file".
Vì sao: biến nạp qua `env_file:` vẫn nằm trong `Config.Env`, nên `docker inspect` vẫn thấy `REDIS_PASSWORD`, `CSRF_SECRET`, `MONGO_URI` (có mật khẩu). Comment tạo cảm giác an toàn không đúng. App hiện chỉ đọc được secret từ file với `VAULT_TOKEN_FILE`.
Đề xuất: sửa comment thành "env_file giữ secret ngoài file compose/git, nhưng vẫn thấy qua `docker inspect` (quyền docker = root)". Nếu cần hơn nữa thì hỗ trợ `*_FILE` cho các secret (X6). (DEBT-406)

🟡 **Backlog: DEBT-392 vẫn để đích "53c" và bị trùng với DEBT-402**
`backlog.md` DEBT-392 (🟡, TLS/ACL Sentinel, "Nên làm ở: 53c") vẫn còn mở và chưa cập nhật. Trong khi đó DEBT-402 (💭) lại nhắc lại phần TLS.
Vì sao: DEBT-392 cho phép hoãn với điều kiện runbook ghi "mạng riêng bắt buộc", và điều kiện này đã thoả (runbook-deploy §10, compose `internal: true`). Nhưng dòng debt chưa phản ánh việc đó, nên debt 🟡 có nguy cơ bị chìm vào một dòng 💭.
Đề xuất: cập nhật DEBT-392 (đích X6, ghi "53c: runbook §10 mạng nội bộ; chưa TLS/ACL") và bỏ phần TLS khỏi DEBT-402. (DEBT-407)

## 💭 Nit

- `runbook-ops.md` §5 bước 1: `redis-cli … -a <sentinel_pw>` để lộ mật khẩu trong `ps`/history. Nên dùng `REDISCLI_AUTH=… redis-cli` hoặc `--askpass`.
- Failover do phân vùng mạng: Sentinel gửi `CLIENT KILL TYPE normal` khi cấu hình lại master cũ nên `READONLY` hiếm gặp. Nếu sau này thấy `READONLY`, có thể dùng `reconnectOnError` cho `READONLY` (đưa vào danh sách theo dõi của DEBT-402).
- `html-exception.filter.ts:36-43`: ternary lồng 3 tầng cho `message`. Nên tách ra một hàm nhỏ `messageFor(status, unavailable)` cho dễ đọc.
- Runbook-deploy §8 có thể thêm một dòng: khi Vault down mà cache còn hạn, token có `kid` lạ ⇒ 503 (tối đa 1 lần / 5 s), các token khác ⇒ 401. Đây là hành vi đúng, chỉ chưa được ghi lại.

## ✂️ Ponytail

- be/src/config/configuration.ts:L146: shrink: 3 lần spread có điều kiện `...(x ? { k: x } : {})` cho `sentinelPassword`/`username`/`password`. Gán thẳng `sentinelPassword: env.REDIS_SENTINEL_PASSWORD` (không bật `exactOptionalPropertyTypes`, ioredis bỏ qua `undefined`, `toEqual` cũng bỏ qua key `undefined`).
- be/src/database/redis/redis.module.ts:L49: yagni: `standaloneInProductionWarning` export ra để test đúng một chuỗi log. Có thể viết inline `if (nodeEnv === 'production' && !database.redisSentinel) logger.warn(...)` trong factory. Giữ nguyên cũng chấp nhận được vì có unit test.
net: -8 lines possible.
