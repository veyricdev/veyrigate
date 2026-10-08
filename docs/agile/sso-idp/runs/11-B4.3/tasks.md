# Tasks — run 11 — B4.3 (AuthorizationCode store)

> Nguồn: `plan.md` §B4 (B4.3), `spec.md` §9.1 bước 3, §9.5 (consume-with-binding), §10 (AuthorizationCode), §4 mục 3 (một grant bind một resource). Mốc **M3**.
> Phụ thuộc đã xong: B1.4 (Redis module + Lua loader `defineCommand`). Không phụ thuộc Q1/Q4.
> Chỉ B4.3. KHÔNG wire vào `/authorize` (cần consent B4.2) và KHÔNG làm `/token` (B4.4). Run này chỉ xây store + primitive atomic, có test thật trên Redis.

## Task

- [x] **B4.3** [BE] **AuthorizationCode store + Lua consume-with-binding**
  - Lưu ở Redis, TTL **60s**, single-use. Payload đủ ngữ cảnh: `clientId`, `redirectUri`, `codeChallenge`, `resource`, `scope`, `nonce`, `userId` (+ trường cần cho B4.4 như `authTime` nếu có sẵn — không bịa trường ngoài spec).
  - Giá trị `code` sinh bằng CSPRNG (tái dùng crypto utils B1.5); key Redis không được chứa plaintext dễ đoán (cân nhắc lưu theo hash của code như các token khác).
  - **Consume atomic bằng Lua đúng §9.5**: chỉ `DEL` khi `clientId` **và** `redirectUri` khớp; sai định danh ⇒ trả null và **KHÔNG xoá**. Đăng ký script qua loader Lua hiện có (B1.4).
  - Nghiệm thu (INV-1, 2, 13): request sai `client_id`/`redirect_uri` **không** làm mất code; 2 consume đồng thời chỉ 1 thành công; code hết hạn sau 60s; consume lần 2 trả null.
  - Không log giá trị `code` (INV-20 redact).

## Ghi chú

- PKCE verify `code_verifier` thuộc B4.4 (sau khi consume trả data) — không làm ở đây.
- DEBT-013 (Redis Cluster CROSSSLOT) ngoài phạm vi; Lua của B4.3 chỉ dùng **1 key** nên an toàn với Cluster — giữ như vậy.