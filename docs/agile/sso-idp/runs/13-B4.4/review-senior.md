# Senior Review — 2026-10-08 (run 13 — B4.4 `/token` authorization_code)

## Kết luận: REJECT

Lý do: còn 1 🔴 về acceptance và bằng chứng fail-closed. Phần code chính đã đúng hướng, nên vòng sửa nhỏ: thêm khoảng 3 integration test và sửa 2 dòng code.

## Tổng quan
Điểm tốt:
- **INV-13 làm đúng chỗ.** Lua `CONSUME_SCRIPT` (authorization-code.service.ts) so `clientId`, `redirectUri` và `codeChallenge` (ARGV[3]) **trước** `DEL`. Bất kỳ trường nào lệch đều trả nil và code vẫn còn. Script chỉ dùng 1 key nên an toàn với Cluster.
- **Thứ tự pipeline đúng.** Parse form → client auth → kiểm `grantTypes` → kiểm format verifier (chưa gọi Redis) → consume atomic → kiểm resource → issue. Client auth sai không làm mất code (int test L215).
- **`aud` lấy từ resource đã bind trong code**, không lấy từ body. Body `resource` chỉ được dùng để xác nhận (L109-113).
- **`no-store` + `Pragma` set ngay đầu**, nên áp cho cả response lỗi. `WWW-Authenticate` chỉ thêm khi client dùng Basic. `descriptionFor` là chuỗi tĩnh, không echo input.
- **D7 fail-closed**: refresh token chỉ lưu hash, `familyId` dùng uuid, có audit `TOKEN_ISSUED` với metadata an toàn. Audit ghi trước khi trả response.
- `grantTypes` được chuẩn hoá khi đọc lean, schema có enum. `adminResourceIdentifier` được khai báo ở một chỗ duy nhất. `amr`/`acr` là hằng, có ghi chú DEBT-030.

## 🔴 Blocker

- [ ] **Acceptance: thiếu test cho failure semantics fail-closed (Task 4 fold)**
  be/test/token.int-spec.ts — tasks.md Task 4 yêu cầu rõ: *Redis lỗi khi consume → 500 `server_error`; insert RefreshToken lỗi (mock throw) → 500, body **không** chứa `access_token`/`id_token`; KeyProvider lỗi → 500; message lỗi không chứa code/verifier/secret.* Hiện **không có** int test nào chạm nhánh `server_error` (grep `server_error` trong int-spec: 0 kết quả). Unit test duy nhất (token.service.spec.ts:235) chỉ kiểm audit lỗi ở tầng service, chưa đi qua `renderError`.
  Vì sao: nhánh này (token.controller.ts:198-206) là nơi duy nhất bảo đảm "lỗi hạ tầng không biến thành phát hành một phần, không rò chi tiết". Nhìn cấu trúc hiện tại thì đúng, nhưng không có test khoá lại. Chỉ cần refactor sau này (vd. B4.5 gửi response sớm hoặc thêm `catch` nuốt lỗi) là hỏng mà không ai thấy.
  Đề xuất: thêm 3 int test, dùng `jest.spyOn` trên provider lấy từ `app.get(...)`:
  1. `AuthorizationCodeService.consume` reject → 500 `{error:'server_error'}`, có `Cache-Control: no-store`.
  2. `refreshTokens.create` (model `RefreshToken`) reject với flow `offline_access` → 500, body không có `access_token`/`id_token`/`refresh_token`.
  3. `TokenSigner.sign` reject → 500.
  Mỗi test assert thêm: `JSON.stringify(body)` không chứa `code`/`code_verifier`/secret đã gửi.

## Security invariants / trust boundaries đã kiểm
| Invariant | Kết quả |
|---|---|
| INV-13 bind client_id + redirect_uri + PKCE trước DEL | ✅ Lua ARGV[3]; test L262/L307 (sai → code còn → đúng → 200) |
| INV-1/2 single-use, race | ✅ Lua atomic; test L506 (2 request song song → đúng 1 lần 200, 1 doc refresh) |
| Client auth trước consume, đồng nhất `invalid_client` | ✅ L76-86; timing đã cân bằng từ B3.3; test L215/L424/L456 |
| Nhiều phương thức auth / client_id lệch | ✅ L155-162; test L424/L440 |
| PKCE bắt buộc mọi client, format RFC 7636 | ✅ L97 (thiếu/sai format → invalid_grant, chưa gọi Redis); test L290 |
| `aud` = resource đã bind, `invalid_target` khi vắng | ✅ service L83; controller L111; test L349/L469 |
| D7 refresh: hash-only, chỉ khi có grant + `offline_access` | ✅ unit L177-L207; int L385 |
| INV-10 không lưu plaintext refresh | ✅ `tokenHash = sha256` |
| INV-20 không log secret | ✅ chỉ log `err.stack` của lỗi hạ tầng. Lỗi Mongo duplicate chỉ chứa hash. Không log body/header |
| INV-25 audit fail-closed | ✅ unit L235 (tầng service). Tầng HTTP **chưa** có bằng chứng → xem 🔴 |
| Exposure: no-store, mô tả lỗi tĩnh | ✅ L59, L225-242 |
| Failure: Redis/DB/Key lỗi → 500 không token | ⚠️ đúng theo cấu trúc, **thiếu test** → 🔴 |

## 🟡 Nên sửa

🟡 **Boundary input: Basic header có `%` sai định dạng gây 500**
token.controller.ts:193-194 — `decodeURIComponent` ném `URIError` khi gặp `%ZZ` hoặc `%` lẻ. Lỗi này không phải `TokenError` nên `renderError` trả **500 `server_error`** và ghi `logger.error` stack.
Vì sao: input sai từ client không nên thành 500. Nó làm nhiễu cảnh báo, và client có thể spam log error mà không cần credential hợp lệ. Contract cũng sai: lẽ ra phải là 401 `invalid_client`.
Đề xuất: bọc 2 lệnh decode trong `try { ... } catch { throw new TokenError('invalid_client', 401) }`, thay cho khối try/catch vô dụng ở L183-187 (xem Ponytail). Thêm 1 test: `Authorization: Basic base64("%ZZ:x")` → 401 + `WWW-Authenticate`.

## 💭 Nit
- token.controller.ts:123 — `includes('application/x-www-form-urlencoded')` vẫn khớp với `text/plain; x=application/x-www-form-urlencoded`. Hiện vô hại (Fastify không parse, sẽ ra `unsupported_grant_type`), nhưng nên so media type: `contentType.split(';')[0].trim().toLowerCase() === '...'`.
- token.controller.ts:109-113 — body `resource` lệch sẽ bị phát hiện **sau** consume, nên code bị đốt. Chấp nhận được: request đã qua client auth + PKCE, attacker không lợi dụng được. Có thể ghi chú lại để tránh ai đó dời check lên trước.
- token.controller.ts:1-2 — 2 dòng import riêng từ `@nestjs/common`; gộp lại.

## ✂️ Ponytail
- be/src/modules/oauth/token/token.controller.ts:L182-187: delete: `try/catch` quanh `Buffer.from(..., 'base64')` — Buffer.from không bao giờ ném lỗi với base64 sai. Dùng `const decoded = Buffer.from(...).toString('utf8')`, chuyển try/catch xuống quanh `decodeURIComponent` (gộp với 🟡).
- be/src/modules/oauth/token/token.controller.ts:L217-221: shrink: `hasBasicHeader` lặp lại phần đọc header của `parseBasic`. Có thể cho `renderError` nhận cờ `usedBasic` (đặt trong `handle`), hoặc tách `basicHeader(req)` dùng chung.
- be/src/modules/oauth/token/token.errors.ts:L26-28: yagni: tham số `description?` không có caller nào dùng (`descriptionFor` lo phần mô tả). Bỏ đi, dùng `super(code)`.
net: -8 lines possible.

## Bàn giao
REJECT → **backend-dev**: sửa 🔴 (3 int test failure semantics) + 🟡 decode Basic (kèm 1 test). Ponytail/nit tuỳ chọn; nếu chưa sửa thì đưa vào backlog ở lượt PASS.

---

# Senior Review — Vòng 2 — 2026-10-08 (re-review sau REJECT 1)

## Kết luận: PASS

Chỉ review delta (`token.controller.ts`, `token.errors.ts`, `test/token.int-spec.ts`) và các hồi quy liên quan.

## Đối chiếu từng điểm vòng 1
| Điểm vòng 1 | Trạng thái | Bằng chứng |
|---|---|---|
| 🔴 Int test: consume lỗi → 500 | ✅ | token.int-spec.ts:544. `spyOn(codes,'consume').mockRejectedValueOnce`. Assert 500, `server_error`, `no-store`, không có `access_token`/`id_token`, body không chứa code/verifier/`SECRET-detail`. Restore trong `finally` |
| 🔴 Int test: insert RefreshToken lỗi (offline_access) → 500, không token | ✅ | :574. `spyOn(refreshModel,'create')`. Assert thêm không có `refresh_token` |
| 🔴 Int test: `TokenSigner.sign` lỗi → 500 | ✅ | :605. `app.get(TokenSigner)` là cùng instance mà `TokenService` dùng (singleton), nên spy có tác dụng thật |
| 🟡 `%ZZ` trong Basic → 401 thay vì 500 | ✅ | controller `parseBasic`: try/catch quanh 2 `decodeURIComponent` → `TokenError('invalid_client',401)`. Test :525 assert 401 + `WWW-Authenticate: Basic…` + `no-store` |
| 💭 So media type chính xác | ✅ | `assertFormContentType`: `split(';')[0].trim().toLowerCase() === …` |
| 💭 Gộp import `@nestjs/common` | ✅ | L1 |
| ✂️ Bỏ try/catch quanh `Buffer.from` | ✅ | |
| ✂️ Dùng chung phần đọc header Basic | ✅ | `basicHeader(req)` dùng ở cả `resolveClientAuth` và `renderError` |
| ✂️ Bỏ tham số `description?` không dùng | ✅ | `super(code)` |
| 💭 Ghi chú vì sao check `resource` đặt sau consume | ➖ chưa làm | Đây là nit tuỳ chọn, không ảnh hưởng. Không đưa vào backlog |

## Hồi quy liên quan đã kiểm
- `WWW-Authenticate` vẫn chỉ gắn khi `invalid_client` **và** request có header Basic (kể cả khi Basic sai định dạng, đúng RFC 6749 §5.2). Client dùng post/none không bị gắn.
- Content type khớp chính xác vẫn nhận được `application/x-www-form-urlencoded; charset=UTF-8`, vì tham số sau `;` bị bỏ khi so sánh. Test happy path vẫn PASS.
- Lỗi decode không còn đi vào nhánh `logger.error`. Nhờ vậy client không thể spam log mức error bằng input rác.
- Fail-closed: không nhánh nào gửi response trước khi `issueForAuthorizationCode` hoàn tất. Nếu insert refresh lỗi thì code đã bị đốt và không có token nào được phát ra. Hành vi này chấp nhận được (fail closed, client phải chạy lại flow).

## Verify (chạy thật, vòng 2)
- `tsc --noEmit`: sạch. `eslint src/modules/oauth/token test/token.int-spec.ts`: sạch.
- Unit: **80/80** (13 suite). Int toàn bộ: **229/229** (14 suite), trong đó `token.int-spec` 23/23.

## 🔴 Blocker
Không có.

## 🟡 Nên sửa
Không có. Không phát sinh DEBT mới.

## ✂️ Ponytail (delta)
Lean already. Ship.

## Bàn giao
PASS → **tester**.