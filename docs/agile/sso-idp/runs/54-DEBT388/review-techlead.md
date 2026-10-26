# Tech Lead Review — 2026-10-26 (run 54, DEBT-388 / DEBT-401 / DEBT-398)

## Kết luận: PASS (có fold, không tách run)

Ràng buộc cụ thể đã fold vào cuối `tasks.md`, mục "Fold tech-lead (2026-10-26)". Fold ưu tiên hơn text gốc khi mâu thuẫn. Thứ tự giao **backend-dev**: Task 2 → Task 1 → Task 3 (Task 3 là [ops], cùng dev). Không có [FE].

Đối chiếu code thật ở HEAD `9c02a11` (CodeGraph 1.6.2, `sync` OK):

- `be/src/modules/oauth/token/token.controller.ts`: `handleAuthorizationCodeGrant` hiện chạy `codes.consume` (Lua GET+binding+DEL) → body resource → sessionRef → `sessions.exists` → `tokens.issueForAuthorizationCode` (**ký AT/ID ở đây**, rồi insert family) → session re-check → `recheckCodeGrant` → `recordIssued` → reply. Lỗi ký ⇒ code đã mất.
- `be/src/modules/oauth/token/refresh-token.service.ts`: `issueForRefresh` = pre-check `original` (chỉ đọc) → `rotate` (findOneAndUpdate swap + insert successor + re-read `familyRevokedAt`) → `recheckAfterRotate` → **`signTokensForRefresh`** → audit. Lỗi ký ⇒ RT đã `revokedAt + replacedBy` ⇒ client retry rơi vào `classifyMiss` ⇒ `TOKEN_REUSE_DETECTED` ⇒ revoke family. Đúng như DEBT-388 mô tả.
- `RefreshTokenSchema.index({ tokenHash: 1 }, { unique: true })`; không đường nào gỡ `revokedAt` (chỉ `$set revokedAt` và `unlinkSuccessor` gỡ `replacedBy`).
- `be/src/modules/keys/vault-transit-key-provider.ts`: `call` retry 1 lần với `VaultNetworkError`/5xx; `signJwt` có nhánh refresh-một-lần (DEBT-395) dựa trên `instanceof VaultStatusError`. Không có chỗ nào ném `KeyProviderUnavailableError` trên đường ký/JWKS. `TokenVerifier.jwksFor` bọc mọi lỗi (DEBT-394).
- `renderError` ở `/token` và `OAuthExceptionFilter` toàn cục đã map `isDependencyUnavailable` ⇒ 503 + `Retry-After` + `no-store`. **Lỗi phát hiện**: nhánh 503 của `/token` dùng `descriptionFor('temporarily_unavailable')` = "Too many failed client authentications…" (câu của rate limit), sai cho Redis outage từ run 53c và sẽ sai cho Vault. Fold vào Task 2.
- `be/Dockerfile`, `fe-admin/Dockerfile` + `Dockerfile.dockerignore` (allowlist); file tracked có tên giống mẫu cấm: chỉ `be/.env.example`, `fe-admin/.env.example` (đã bị ignore), và **thư mục `be/src/modules/keys/`, `fe-admin/src/routes/keys/`**, nên mẫu `*/keys/*` sẽ báo nhầm.

## Kiến trúc đề xuất

### Q-54.1: thứ tự ký/commit

Nguyên tắc: **ký trên bản đọc → commit bằng đúng primitive nguyên tử đang có → token chỉ rời server khi commit thắng và mọi re-check sau commit đạt**. JWT ký xong mà chưa trả thì vô hại (không lưu, không jti store, không log), nên ký "thừa" ở bên thua race không mở double-issue. Không có trạng thái nào bị ghi trước khi ký, nên lỗi ký không cần hoàn tác.

Code grant: `peek` (GET + so binding, không DEL) → cổng thuần (body resource, sessionRef, resource, admin-capable) → **ký** → `consume` (Lua cũ) → chuỗi kiểm cũ giữ nguyên thứ tự → mint family → re-check → audit → reply. Refusal thuần không ký nhưng vẫn đi qua `consume` để giữ ngữ nghĩa "đốt code" như hôm nay.

Refresh grant: pre-check `original` → **ký từ trường bất biến của `original`** → `rotate` (không sửa) → bất biến `rotatedFromId == original._id` → `recheckAfterRotate` → audit → reply.

### Q-54.2: không đổi cấu trúc dữ liệu

Không cần trạng thái "pending" (Redis/Mongo), không cần grace window (spec §9.5 cấm), không cần bù trừ. Bù trừ (khôi phục code, gỡ revoke RT) bị loại vì: (a) phải giữ đúng TTL gốc, (b) restore có thể lỗi đúng lúc hạ tầng chập chờn, (c) với RT, gỡ `revokedAt` phá giả định "`revokedAt` không bao giờ bị gỡ" mà reasoning INV-11 và lập luận "pre-check null ⇒ rotate chắc chắn miss" dựa vào. Chỉ thêm một thao tác đọc Redis (`peek`) cho mỗi code grant.

### Phân tích interleaving

Code grant (A, B cùng code; binding đúng):

| # | Lịch | Kết quả | Bất biến |
|---|---|---|---|
| 1 | A, B peek → cùng ký → cùng consume | Lua nguyên tử: đúng 1 thắng; bên thua `invalid_grant`, bỏ token đã ký | I1 |
| 2 | A ký lỗi (Vault), B thành công | A 503 không consume; B 200; A retry ⇒ peek null ⇒ `invalid_grant` | I1, I4 |
| 3 | A ký chậm, code hết TTL trước consume | consume null ⇒ `invalid_grant`, không family | I3 |
| 4 | Logout giữa peek và consume / giữa consume và insert | `sessions.exists` sau consume + re-check sau insert (INV-29) giữ nguyên | I3 |
| 5 | Binding sai (attacker có code, không có verifier) | peek null, không ký, không DEL | INV-13 |
| 6 | Redis lỗi ở peek | 503, không gì thay đổi | I4 |
| 7 | Redis lỗi/timeout ở consume sau khi ký | 503/500, không token; DEL có thể đã chạy (mơ hồ) ⇒ mất code, chấp nhận (fail-closed) | I3 |
| 8 | Refusal thuần (resource body sai, admin-forbidden…) | không ký, consume, refusal như hôm nay | giữ ngữ nghĩa cũ |

Refresh grant (RT0; A, B đồng thời hoặc nối tiếp):

| # | Lịch | Kết quả | Bất biến |
|---|---|---|---|
| 1 | Ký lỗi | không rotate; RT0 nguyên; retry 200; 0 reuse | I4 |
| 2 | A, B cùng ký → A rotate thắng → B rotate miss | B `classifyMiss` ⇒ reuse ⇒ revoke family (như hôm nay); nếu reuse stamp trước khi A re-read `familyRevokedAt` thì A tự revoke successor và thua luôn. Không bộ token nào của bên thua rời server | I2, I5 |
| 3 | A ký xong, rồi RT0 bị `/revoke`/logout sweep trước rotate | rotate miss, `replacedBy` null ⇒ `invalid_grant` thường, 0 reuse | I3 |
| 4 | A ký xong, rotate thắng, rồi khoá user/disable client | `recheckAfterRotate` như hôm nay ⇒ revoke family, `invalid_grant` | I3 |
| 5 | Ký lỗi ở A, B (request khác cùng RT0) đã thắng rotate | A 503; A retry ⇒ reuse ⇒ revoke. Đây là double-submit thật, hành vi như hôm nay, không phải DEBT-388 | I5 |
| 6 | Mongo lỗi sau swap (insert successor / audit success) | RT đã đốt ⇒ retry = reuse: rủi ro cũ DEBT-032, không đổi | — |
| 7 | `original` null | gọi `rotate` như cũ (chắc chắn miss) để phân loại reuse; không ký | I5 |

### DEBT-401

Phân loại ở biên `VaultTransitKeyProvider.signJwt/getPublicKeys`, không ở `TokenSigner`. Bọc ở `TokenSigner` sẽ biến lỗi bug/crypto của `LocalKeyProvider` thành 503, khiến lỗi thật trông như sự cố hạ tầng. Chỉ lỗi "không tới được / Vault quá tải" (mạng, timeout, 5xx, 429) mới là 503. Lỗi toàn vẹn (chữ ký không verify, định dạng lạ) và lỗi cấu hình giữ 500 để báo động.

Ngân sách thời gian (ghi nhận): một chữ ký khi Vault hố đen tốn tối đa khoảng 4 × `VAULT_TIMEOUT_MS` (sign + retry, rồi refresh metadata + retry). Mặc định 2 s ⇒ ~8 s; trần config 10 s ⇒ ~40 s; code grant ký AT rồi ID tuần tự, nhưng lỗi ở AT thì dừng. Vẫn trong TTL code 60 s. Deadline tổng cho `/token` để DEBT-409.

### DEBT-398

Đặt guard bằng `RUN --mount=type=bind` làm bước đầu stage build thay vì `RUN ! find` sau `COPY be/ be/` (đề xuất trong backlog). Lý do: (1) secret không bao giờ vào layer/cache, kể cả cache cục bộ; (2) quét đúng build context, không quét `node_modules` vừa cài (gói npm có thể chứa `.pem`/`.npmrc` fixture ⇒ báo nhầm); (3) không cần `-prune`.

## Điểm mạnh

- Tasks đúng vấn đề, đúng phạm vi, nêu rõ cả 3 bảo đảm phải giữ (single-use, reuse detection, race).
- Hạ tầng đã có đủ mảnh: 503 mapping (`renderError`, global filter), `KeyProviderUnavailableError`, proxy cắt Vault (T5), harness race (`afterInsert`, `afterRotate`), nên chi phí test thấp.
- Không cần thay schema/index/khoá Redis: thay đổi nhỏ, chỉ đổi thứ tự.

## Vấn đề (đã fold, dev bắt buộc theo fold)

- [x] Task 1 thiếu thứ tự thao tác cụ thể, bất biến phòng thủ và cách giữ ngữ nghĩa đốt code của refusal ⇒ F1.
- [x] Task 1 chưa nhận ra pin `tester exposure: … never signs a token` sẽ đỏ theo thiết kế (ký trước re-check). Đây là đổi pin có chủ đích sang "never returns" ⇒ F1/R5.
- [x] Task 2 chưa chỉ chỗ phân loại và ranh giới lỗi nào là 503 ⇒ F2; mô tả 503 sai ở `/token` ⇒ F2.2.
- [x] Task 3: guard đề xuất trong backlog đặt sai chỗ (layer đã có secret, `node_modules` báo nhầm) và mẫu `*/keys/*` trúng mã nguồn ⇒ F3; mutation phải dùng canary, không dùng `be/.env` thật.
- [x] Thiếu danh sách mutation và test race cụ thể ⇒ F1/F2/F3.

## Đề xuất (không bắt buộc, đã đưa vào backlog)

- DEBT-409: deadline tổng cho một request `/token` khi Vault chậm (hiện tối đa ~4 × `VAULT_TIMEOUT_MS` cho mỗi chữ ký).
- DEBT-410: `listKeys`/`rotate` của admin keys API vẫn 500 khi Vault down (không bọc trong run này), cần quyết định 503 hay giữ.
- DEBT-032 (đã có) vẫn là rủi ro còn lại của refresh khi Mongo lỗi sau swap. Sau run 54 nên nâng ưu tiên khi xác nhận prod Mongo là replica set (transaction).
