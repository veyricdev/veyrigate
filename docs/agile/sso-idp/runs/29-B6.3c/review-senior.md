# Senior Review — 2026-10-16 (run 29 B6.3c)

## Kết luận: PASS

Không có 🔴. Có 1 🟡 mới (DEBT-163, đã ghi vào backlog) và 2 💭. Đã tự chạy: `pnpm -C be typecheck` sạch; `pnpm -C be test` 254/254; `pnpm -C be test:int -- admin-keys admin-api ui-auth indexes` 77/77 (vg-test-*). Không chạy E2E, không đụng `be/keys`, không compose/FLUSH.

## Tổng quan (ấn tượng chung + điểm tốt)

- Task 1 xử lý đúng gốc của DEBT-145:
  - Mutex promise-chain có `chain = run.catch(() => undefined)`, nên một rotate lỗi không làm kẹt các rotate sau.
  - `getPublicKeys`/`listKeys` giờ chỉ đọc; prune chuyển vào `rotateExclusive`, chạy trong mutex. Sau fix chỉ còn `init`/`rotate` gọi `writeState`.
  - Vẫn giữ thứ tự ghi state trước, xoá PEM sau (DEBT-007).
- Test race tất định qua seam `atomicRename` (`GatedKeyProvider`), không dựa vào timing. Có đủ các ca: normal∥emergency, normal∥normal (token ký bằng F1 vẫn verify), chain không kẹt, read không ghi (spy + so từng byte của file), retry ENOENT.
- Int `admin-keys`:
  - Kiểm đúng tập field của response; dùng regex dò key material trên body và audit.
  - Emergency ⇒ 401 ở cả 3 endpoint, và refresh cũ vẫn 200 (Q-29.2).
  - Ca quyền / step-up / 400 đều so JWKS trước và sau.
- Task 3 và 4 bám sát fold:
  - Revoke đi qua `revokeWhere` (stamp-first, cửa duy nhất); `buildRevokeScope` fail closed khi `clientId` rỗng.
  - DEBT-132 tránh đúng bẫy `$min` (null < Date) và bẫy pipeline.
  - Login dùng filter atomic `lockedUntil: {$not: {$gt: now}}` và cùng một `GENERIC_LOGIN_ERROR`.

## 🔴 Blocker

(không có)

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| rotate ∥ rotate không mất key đang ký | OK | Mutex trên singleton DI. Test normal∥normal: A retiring, F1 retiring, F2 active; token F1 vẫn verify |
| Key cũ (đã lộ) không bao giờ quay lại active | OK | Read path không còn `writeState`. Test normal∥emergency: JWKS = {E}, trên đĩa chỉ còn `E.pem` |
| rotate ∥ getSigningKey | OK | ENOENT ⇒ đọc lại state 1 lần, lần 2 lỗi thì ném. PEM mới ghi trước state (`createKey` trước `writeState`) |
| rotate ∥ verify/JWKS | OK | Verify chỉ đọc; `keys.json` thay bằng rename atomic, nên reader thấy state cũ hoặc mới, không bao giờ file dở |
| Crash giữa chừng | OK, còn 1 lỗ nhỏ | Crash trước rename: state cũ nguyên vẹn, PEM mới mồ côi (vô hại). Crash sau rename, trước `rm`: state đúng, nhưng PEM cũ/đã lộ nằm lại mà không có log (xem 🟡 DEBT-163) |
| Emergency thực sự vô hiệu AT cũ | OK | `TokenVerifier` gọi `getPublicKeys()` ở mỗi lần verify. Int: 401 ở `/userinfo`, `/demo/me`, `/admin/me`. RP ngoài có cache JWKS là DEBT-157 |
| super_admin không bypass được | OK | Role đọc từ DB mỗi request (`memberships.activeRoles` trong `AdminTokenGuard`), không lấy từ claim. Một hàm `assertSuperAdmin` gác cả GET lẫn POST. POST cần thêm `admin.write` + `RequireRecentAuth(5)`. Bị 403 thì state không đổi |
| Không lộ key material | OK | Controller tự allowlist field (phòng provider KMS sau này). Log chỉ ghi kid. Audit metadata chỉ `{mode, oldKid}`. Lỗi fs ra 5xx qua filter chung, không kèm message/path |
| Tenants | OK | tenant_admin chỉ thấy `ctx.tenantId`. Cursor kiểm bằng `Matches`/`MaxLength` (400). Mapper allowlist `{id,name}` |
| Revoke khi disable: stamp-first, fail-closed, retry | OK | Thứ tự update ⇒ revoke ⇒ audit. Revoke lỗi ⇒ client vẫn disabled, có audit failure, 5xx. Disable lần 2 vẫn chạy revoke. Cross-tenant 404 trước khi revoke. Có index `{clientId:1}` |
| Race `disabledAt` | Chấp nhận | `updateOne` có điều kiện `disabledAt:null` chạy sau update chính. Việc không kiểm `matchedCount` đã có DEBT-161. Hai lần disable song song: DB giữ mốc của bên thắng, response bên thua lệch vài ms (💭) |
| Login vs admin/brute-force lock | OK | `findOneAndUpdate` atomic. Kết quả `null` ⇒ audit `AUTH_LOGIN_FAILED` + 401 trùng từng byte với sai mật khẩu; không tăng bộ đếm, không tạo session. Int dùng seam chèn lock xen giữa, cho cả 2 loại lock. Cửa sổ giữa reset và `establish` là DEBT-141, ngoài phạm vi |

## 🟡 Nên sửa

- [ ] [BE] `be/src/modules/keys/local-key-provider.ts:127-136` — **Emergency: PEM đã lộ có thể nằm lại trên đĩa mà không ai biết.**
  - Vấn đề: nếu process chết sau `writeState(next)` nhưng trước `removePem`, `keys.json` đã bỏ key cũ nhưng `<oldKid>.pem` vẫn còn. Không đường nào xoá nó về sau, vì không có GC orphan (cố ý, xem chú thích DEBT-007). Cũng không có log ERROR, vì log chỉ ghi khi `rm` lỗi.
  - Vì sao: không còn ký được bằng key đó, nhưng private key đã lộ vẫn nằm trong `KEY_LOCAL_DIR`, trong khi người vận hành tin là nó đã bị huỷ.
  - Đề xuất: cân nhắc cho `init()` (lúc boot) log WARN liệt kê các `*.pem` không có trong state. Chỉ log kid, không xoá, nên vẫn an toàn khi nhiều process dùng chung thư mục. Hoặc thêm bước "kiểm thư mục" vào runbook emergency.
  - Dev-only nên không chặn → **DEBT-163**.

## 💭 Nit

- `be/test/admin-keys.int-spec.ts:362-365`: `afterAll` gọi `redis.quit()` rồi mới `app.close()`. Sau đó `RedisService.onApplicationShutdown` quit lại chính client đó, nên in ra stack "Connection is closed". Test vẫn PASS nhưng output nhiễu. Cân nhắc đóng app trước, hoặc bỏ quit thủ công nếu client thuộc về app.
- `be/src/modules/clients/client.service.ts:274`: khi hai lần disable chạy song song, response của bên thua trả `disabledAt = now` của chính nó, thay vì mốc trong DB (lệch vài ms). Vô hại; sẽ hết luôn nếu sửa DEBT-161 (đọc lại khi `matchedCount=0`).

## ✂️ Ponytail

Lean already. Ship.

(`AdminKeysController.list`/`rotate` destructure lại field dù provider đã trả đúng shape. Đây là allowlist có chủ đích ở trust boundary, phòng provider KMS sau này trả thêm field lúc runtime, nên KHÔNG tính là thừa.)
