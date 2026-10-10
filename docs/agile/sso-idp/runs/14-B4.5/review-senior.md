# Senior Review — 2026-10-10 (run 14 — B4.5 refresh grant + rotation + reuse + `/revoke`)

# Lượt 3 (cuối)

## Kết luận: PASS

🔴 lượt 2 (race rotate↔`/revoke`) **đã đóng**. Dev chọn phương án (a): tổng quát hoá mark-then-check cho **mọi** đường revoke family. Kết quả là bất biến "không hậu duệ nào sống sót sau khi family bị revoke" nay đúng với mọi interleaving đã xét. Không phát sinh 🔴 mới. Còn 3 🟡 → ghi DEBT-034..036. → chuyển **tester**.

## Tổng quan (lượt 3)

- Fix gọn: +1 field schema, `revokeFamily` (`refresh-token.service.ts:342-344`) **luôn** stamp `familyRevokedAt` trước `updateMany` revoke (`:356`). `rotate` re-read `familyRevokedAt` của cha (`:272-281`). Nhờ vậy cả reuse lẫn `/revoke` dùng **chung một cơ chế**, không còn đường nào chỉ dựa vào `reuseDetectedAt`.
- Ngoài `revokeFamily`, không còn chỗ nào ghi `revokedAt` cho RefreshToken. Đã grep `be/src`: `revokeByToken` và `classifyMiss` đều đi qua `revokeFamily`.
- Test race cũ đã bỏ `setTimeout`, thay bằng promise `inserted` và assert chặt A=400 (`refresh-token.int-spec.ts:454-508`). Có thêm test gate cho `/revoke` (`:510-559`), đúng yêu cầu lượt 2.
- Pre-check (`:96-105`) đã lọc `resource ∈ allowedResources`. Comment `readPreference` đã thêm (`:269-271`). Như vậy 💭 lượt 2 đã xử lý.
- Tự verify: `typecheck` EXIT=0, `lint` sạch, `test:int -- refresh-token` **27/27**, full `test:int` **257/257** (Mongo rs0 thật).

## Kiểm chứng fix race rotate↔`/revoke` (🔴 lượt 2) — ✅ ĐÓNG

Ký hiệu. Rotate A trên cha P: swap (a) `:228` → insert X (b) `:251` → re-read `P.familyRevokedAt` (c) `:272` → nếu có dấu thì tự revoke X (d) `:277`. Revoker B (reuse **hoặc** `/revoke`): stamp-pass `updateMany({familyId, familyRevokedAt:null})` (T) `:342` → revoke-pass `updateMany({familyId, revokedAt:null})` (U) `:356`. Ở B, T hoàn tất trước khi U bắt đầu (cùng một chuỗi `await`).

Bổ đề: P có trước (a), cùng `familyId`, và key index `familyId` không đổi. Vì vậy mọi stamp-pass T chạy xong đều đã chạm P: hoặc stamp P, hoặc bỏ qua P vì P **đã** có dấu. Gọi t_P là thời điểm P mang dấu.

- **(c) sau t_P** → A thấy dấu → (d) revoke X + `invalid_grant`. Giá trị X không bao giờ ra ngoài. ✅
- **(c) trước t_P** → U > T-xong ≥ t_P > (c) > (b). Như vậy X đã tồn tại với `revokedAt:null` khi U quét, nên U revoke X. ✅
- **`/revoke` ‖ rotate** (🔴 cũ): `revokeByToken` → `revokeFamily` không có `reuse` nhưng **vẫn stamp**. Hai nhánh trên áp dụng nguyên vẹn. Test `:510` ép đúng nhánh (c) sau t_P. ✅
- **`/revoke` bằng member bất kỳ** (cha đã rotate, con đang active, tổ tiên xa): `findOne` chỉ lấy `familyId`, còn stamp phủ cả family, nên bổ đề không phụ thuộc token nào được gửi lên. ✅
- **reuse ‖ `/revoke` đồng thời**: cả hai cùng stamp-pass. Filter `familyRevokedAt:null` khiến pass thứ hai bỏ qua các doc đã có dấu. Pass nào hoàn tất trước đều đảm bảo mọi doc có trước đã mang dấu, và U của pass đó chạy sau. Hai U chồng nhau thì vô hại vì `$set revokedAt` idempotent. Audit `TOKEN_REVOKED` chỉ ghi khi `modified>0`, nên có thể chỉ một bên ghi audit; như vậy là đúng ngữ nghĩa. ✅
- **Rotate lồng nhau (R→S→T)**: S chỉ ra ngoài khi A(R) đã qua (c) mà không thấy dấu. Nếu stamp của B được ghi trước khi S được insert thì R đã có dấu khi A đọc ở (c), nên A tự revoke S và S không bao giờ lộ. Nếu S đã tồn tại khi stamp chạy thì S cũng được stamp. Khi đó A2(S→T) áp dụng lại bổ đề với P=S: hoặc A2 thấy dấu ở (c) của mình, hoặc U của B chạy sau (c) của A2 và bắt được T. Quy nạp theo độ sâu thì kết luận đúng cho mọi chuỗi. ✅
- **Đa revoker + đa rotate xen kẽ**: mỗi cặp (X, P) chỉ cần **một** revoker hoàn tất T rồi U sau (c). Điều này luôn đúng cho revoker có stamp-pass chạm P sau (c). ✅
- **Thất bại giữa chừng**: (c) hoặc (d) lỗi DB → 500, X không trả ra. B lỗi sau T trước U → 500 (`/revoke` fail-closed). Khi đó family có dấu nhưng chưa revoke: mọi rotate tiếp theo của family đều tự huỷ hậu duệ ở (c), còn client retry `/revoke` sẽ hoàn tất U. Fail closed. ✅
- **Cha bị TTL xoá trước (c)**: `parent` null → bỏ qua. Vô hại vì X có cùng `expiresAt` với cha, nên X cũng đã hết hạn (xem 💭).
- **Điều kiện ngầm**: đọc/ghi trên primary, đã có comment. `w:1` có thể bị rollback khi failover, đã thuộc DEBT-032/B7.

## 🔴 Blocker (lượt 3)

Không có.

## Security invariants / trust boundaries đã kiểm (lượt 3)

| Invariant | Kết quả | Ghi chú |
|---|---|---|
| INV-10 hash-only | ✅ | không đổi |
| INV-11 single-use + revoke toàn family | ✅ reuse · ✅ `/revoke` · ✅ reuse‖`/revoke` · ✅ lồng nhau | lập luận ở trên + test `:430`, `:454`, `:510` |
| INV-11 replay kèm scope sai | ✅ | pre-check lọc active + allowedResources |
| INV-12 / INV-14 | ✅ | không đổi; pre-check nay khớp filter rotate |
| AuthZ / IDOR / confused-deputy | ✅ | stamp-pass cũng bind `clientId` (`:343`), nên không stamp chéo được family của client khác |
| Failure fail-closed | ✅ | xem mục "Thất bại giữa chừng" |
| Exposure | ✅ | audit vẫn `{familyId,count}`; X tự huỷ không bao giờ trả ra |
| Logout/revoke ở request kế tiếp | ✅ | `/revoke` 200 thì mọi hậu duệ đều chết, kể cả X mint trong cửa sổ |
| Enumeration | ✅ | `/revoke` vẫn 200 đồng nhất; stamp không đổi response |

## 🟡 Nên sửa (lượt 3) → backlog

1. **Bất biến "mọi revoke family phải stamp trước" mới chỉ được giữ bằng quy ước** (`refresh-token.service.ts:328-358`). Hiện đúng vì `revokeFamily` là cửa duy nhất. Tuy nhiên B4.7 (global logout `updateMany({userId})`) và B6.3 (admin revoke family) rất dễ viết `updateMany revokedAt` trực tiếp, và như vậy sẽ **mở lại race** mà không test nào hiện có bắt được. Cân nhắc: tách `revokeWhere(filter)` (stamp → revoke) làm API duy nhất để revoke RefreshToken, và thêm test gate cho từng đường revoke mới. → DEBT-034.
2. **Nhánh "(c) trước t_P" (U bắt X) chưa có test tất định**. Đây là 🟡-L2-3 còn mở. Hai test gate hiện tại đều ép nhánh (c) sau t_P. Nhánh kia chỉ được phủ ngẫu nhiên qua `CONCURRENT`. Ngoài ra chưa có biến thể `/revoke` **bằng con đang active** chạy trong cửa sổ. Gợi ý: gate tại `findOne` re-read (hoặc giữa T và U) để ép thứ tự. → DEBT-035.
3. **Docs lệch code**: JSDoc `revokeFamily` (`:323-324`) vẫn nói reuse stamp `reuseDetectedAt` "so a concurrent rotate … can self-revoke", trong khi `rotate` nay đọc `familyRevokedAt`. `spec.md:415` (data model RefreshToken) chưa có `familyRevokedAt`. → DEBT-036.

## 💭 Nit (lượt 3)

- `rotate:276`: khi `parent` null (cha bị TTL xoá), code đang bỏ qua guard. Lập luận cho thấy an toàn, nhưng `if (!parent || parent.familyRevokedAt)` fail-closed rõ ý hơn và không tốn gì.
- Test `:503`/`:554` dùng `toBeGreaterThanOrEqual(2)`. Trong kịch bản này số lượng là tất định (cha + S), nên `toBe(2)` sẽ chặt hơn.
- Stamp-pass ghi lên mọi doc của family, kể cả doc đã revoked từ lâu. Family dài nhất khoảng 30d/15' ≈ 2.9k doc và chỉ ghi một lần nhờ filter `null`, nên chấp nhận được.

## ✂️ Ponytail (lượt 3)

- refresh-token.service.ts:L210: shrink: lập luận mark-then-check được viết 3 lần (`:210-215`, `:265-271`, `:334-340`). Giữ bản đầy đủ ở `revokeFamily`, còn hai chỗ kia chỉ cần một dòng "see revokeFamily".
- refresh-token.int-spec.ts:L510: shrink: hai test gate trùng khoảng 30 dòng setup (spy, gate, inserted). Có thể tách helper `gateInsert()` trả `{inserted, release, restore}`.
net: -35 lines possible.

## Chuyển tiếp (lượt 3)

PASS → **tester**. Ghi DEBT-034..036 vào `backlog.md`. Ngoài phạm vi, không tính: `.vscode/mcp.json`, `.mcp.json`, `=1`, `=110`.

---

# Lượt 2

## Kết luận: REJECT

🔴 lượt 1 (race rotate↔**reuse**) **đã đóng thật**: lập luận bất biến đúng với mọi interleaving, và test phát hiện được khi bỏ guard. Tuy vậy còn **1 🔴 mới cùng lớp lỗi**: race rotate↔**`/revoke`**. `revokeByToken` không ghi dấu nào để `rotate` đọc lại, nên hậu duệ S mint trong cửa sổ swap→insert sẽ sống sót sau khi `/revoke` đã trả 200. → chuyển lại **backend-dev**.

## Tổng quan (lượt 2)

- Fix mark-then-check gọn (≈15 dòng), không cần transaction. Comment giải thích đúng lý do của thứ tự.
- 🟡-1/2/3/5 + nit `descriptionFor`/`actorType` + toàn bộ ponytail lượt 1 đều đã xử lý (grep: không còn `deviceId`, `RotationFailure`, `issuedAt` trong `RefreshDoc`).
- Tự verify: `typecheck` EXIT=0. `pnpm test:int -- refresh-token` **26/26** pass trên Mongo thật.

## Kiểm chứng fix race rotate↔reuse (🔴 lượt 1) — ✅ ĐÓNG

Ký hiệu. A = rotate thắng: (a) swap R tại `refresh-token.service.ts:218`, (b) insert S tại `:241`, (c) đọc lại `R.reuseDetectedAt` tại `:258`, (d) tự revoke S tại `:263`. B = reuse: `classifyMiss` findOne tại `:292` (chỉ thấy `replacedBy` khi đã sau (a)), B1 stamp tại `:324`, B2 `updateMany` revoke tại `:332`.
- **(c) đọc trước B1** → B1 > (c) > (b) → B2 (sau B1) chắc chắn thấy S → S bị revoke. ✅
- **(c) đọc sau B1** → thấy stamp → (d) tự revoke S + `invalid_grant`. ✅
- **Reuse tổ tiên xa hơn (G → R → S)**: B1 stamp **cả family**, kể cả R (cha của S), nên cả hai nhánh trên vẫn đúng. ✅
- **Family đã stamp từ trước** (filter `reuseDetectedAt:null` bỏ qua R) → R đã có dấu, nên (c) vẫn thấy. ✅
- **(d) lỗi DB** → 500, giá trị S không bao giờ trả ra ngoài. Không có exposure. ✅
- **Parent bị TTL xoá trước (c)** → S có cùng `expiresAt` nên S cũng đã hết hạn. ✅
- Điều kiện ngầm: đọc/ghi trên primary (mặc định, không cấu hình `readPreference`). Xem 💭.
- Test `DETERMINISTIC race` (`refresh-token.int-spec.ts:454`): nếu bỏ guard thì S sống, và assert `all.every(revokedAt)` sẽ fail. Như vậy test **bắt được regression**. ✅ (có điểm yếu nhỏ, xem 🟡-L2-2)

## 🔴 Blocker (lượt 2)

- [ ] **Race rotate↔`/revoke`: hậu duệ sống sót sau khi revoke đã trả 200 (Task 4 state transition, INV-11)**
  `refresh-token.service.ts:165-176` (`revokeByToken` → `revokeFamily` không có `reuse`) ↔ `:218-267` (rotate).
  Trình tự lỗi: A swap R (a) → C `/revoke` (bằng R hoặc bất kỳ member nào của family): `findOne` → `updateMany({familyId, revokedAt:null})`. Lúc này S chưa tồn tại, R đã revoked, nên `modified=0` và không có audit → 200 → A insert S (b) → (c) không thấy `reuseDetectedAt` (vì `/revoke` không stamp) → A trả 200 + S **sống** tới absolute expiry.
  Vì sao là 🔴: (1) acceptance Task 4 yêu cầu "family → mọi member revoked; `/token` kế tiếp với token đã revoke → `invalid_grant`", nhưng client nhận 200 trong khi family vẫn còn sống, tức logout/revoke bị bypass. (2) Kẻ giữ refresh bị rò có thể **chủ động nới cửa sổ**: chỉ cần rotate liên tục chuỗi của mình. Mỗi chu kỳ có một khoảng swap→insert mà family không có member active, và tỉ lệ thời gian này so với cả chu kỳ khá lớn, nên `/revoke` của owner/app có xác suất đáng kể rơi vào khoảng đó. (3) `revokeFamily` sẽ được dùng lại cho B4.7 global logout và B6.3 admin revoke family, nên lỗi này sẽ lan sang các tính năng đó.
  Đề xuất (chọn 1):
  - **(a) Tổng quát hoá mark-then-check cho mọi lần revoke family**: `revokeFamily` **luôn** stamp một marker trước `updateMany`. Tech-lead cấm set `reuseDetectedAt` cho `/revoke`, nên cần thêm field mới, ví dụ `familyRevokedAt`. Với reuse thì set thêm `reuseDetectedAt`. `rotate` (c) đọc lại cha và tự revoke S nếu cha có **một trong hai** dấu. Lập luận bất biến giống hệt lượt 2 ở trên.
  - **(b) Insert-trước-swap** (phương án (b) của lượt 1): pre-read R → insert S → swap R. Swap thua thì revoke S. Mọi `updateMany` của reuse/`/revoke`/logout xảy ra sau swap đều thấy S. Cách này đóng **cả hai** race chỉ bằng một cơ chế và có thể bỏ được bước re-read.
  **Test bắt buộc**: dùng cùng gate trong `insertRefreshToken`, chạy `POST /revoke` (bằng R) trong lúc A đang bị giữ ở gate. Sau đó assert: mọi doc của family có `revokedAt`, A ≠ 200 **hoặc** S dùng ở `/token` ra `invalid_grant`. Nên có thêm một biến thể revoke bằng member khác (con đang active trước đó).

## Security invariants / trust boundaries đã kiểm (lượt 2)

| Invariant | Kết quả | Ghi chú |
|---|---|---|
| INV-10 hash-only | ✅ | không đổi |
| INV-11 single-use + reuse → revoke toàn family | ✅ với reuse (mọi interleaving ở trên) · ❌ với `/revoke` song song (🔴) | |
| INV-11 replay kèm scope sai | ✅ | pre-check lọc active (`:93`) + test `:301` |
| INV-12 / INV-14 | ✅ | dedupe/empty scope (`:105-111`) + test `:287`, `:294` |
| AuthZ / IDOR / confused-deputy | ✅ | bind `clientId` ở mọi query, kể cả stamp `:326` |
| Failure fail-closed + retry | ✅ | test `:528-537` (retry → `invalid_grant` + family revoked) |
| Exposure | ✅ | audit metadata `{familyId,count}`; S không bao giờ trả ra khi self-revoke |
| Logout/revoke ở request kế tiếp | ❌ | 🔴 lượt 2 |

## 🟡 Nên sửa (lượt 2)

1. **`.vscode/mcp.json` / `.mcp.json`**: orchestrator đã xác nhận là thay đổi riêng của người dùng và không commit, nên **đóng** (không tính).
2. **Test "DETERMINISTIC" vẫn phụ thuộc thời gian**: `refresh-token.int-spec.ts:481` dùng `setTimeout(150)` để chờ A insert xong. Trên CI chậm, B có thể chạy trước (a), khi đó test không còn kiểm đúng interleaving đã định. Cân nhắc resolve một promise `inserted` ngay sau `await real(input)` trong mock rồi `await inserted`. Ngoài ra, với thứ tự đã ép thì A **phải** là 400 `invalid_grant`. Nên assert chặt như vậy thay vì nhánh `if 200 … else [400,500]` (`:497-505`), để chứng minh đúng nhánh self-revoke đã chạy.
3. Nhánh "(c) đọc trước B1" (S bị B2 bắt) chưa có test tất định riêng, hiện chỉ được phủ ngẫu nhiên bởi test `CONCURRENT`. Có thể thêm bằng cách gate ở `findOne` re-read. Không bắt buộc nếu chọn phương án (b) của 🔴.

## 💭 Nit (lượt 2)

- Pre-check (`:93`) chưa lọc `resource ∈ allowedResources`. Token có resource đã bị gỡ mà gửi kèm scope sai thì ra `invalid_scope` thay vì `invalid_grant`. Chỉ client sở hữu mới thấy và không mất state, nên vô hại; thêm vào filter cho nhất quán.
- Mark-then-check giả định đọc/ghi linearizable trên primary. Nên ghi một dòng comment "không đổi `readPreference`/`writeConcern` cho model này". Lưu ý thêm: khi failover, ghi `w:1` có thể bị rollback (liên quan DEBT-032/B7).

## ✂️ Ponytail (lượt 2)

Lean already. Ship. (Toàn bộ 5 mục lượt 1 đã cắt. Nếu chọn phương án (b) cho 🔴 thì có thể bỏ khối re-read `:255-267`.)

## Chuyển tiếp (lượt 2)

REJECT → **backend-dev**: sửa 🔴 race `/revoke`↔rotate, kèm test tất định. Nên xử lý luôn 🟡-L2-2 (gate bằng promise + assert chặt). Sau đó → senior-reviewer lượt 3. Không ghi DEBT vì kết luận là REJECT.

---

# Lượt 1 (lưu lại)

## Kết luận lượt 1: REJECT

Có 1 🔴: race giữa nhánh reuse và việc mint hậu duệ có thể để lại **1 refresh token còn sống** trong family đã bị "revoke toàn bộ". Như vậy INV-11 và acceptance Task 1 ("sau cuộc đua, family bị revoke toàn bộ, kể cả hậu duệ vừa mint") **không được bảo đảm bằng code**. Test concurrent hiện đang xanh là nhờ timing. → chuyển lại **backend-dev**.

## Tổng quan (ấn tượng chung + điểm tốt)

- Cấu trúc gọn, đúng hướng của tech-lead: một `findOneAndUpdate` atomic, filter bind `tokenHash + clientId + revokedAt:null + expiresAt>now + resource∈allowedResources` (INV-10/12/14). `replacedBy` là ObjectId sinh trước, mint dùng chung `insertRefreshToken`, `expiresAt` kế thừa (absolute, Q6).
- `classifyMiss` phân loại đúng thứ tự: khác client → không đổi state; `revokedAt && replacedBy` → reuse; đã `/revoke`, hết hạn, mất resource → invalid, không báo động giả. Chống confused-deputy tốt.
- Dispatch grant giữ hành vi B4.4. Client auth chạy trước mọi ghi. `unauthorized_client` và `invalid_scope` đúng RFC. Scope được kiểm **trước** rotate nên token hợp lệ không bị đốt mất.
- `/revoke` dùng chung parse/auth, bind `clientId` ở cả `findOne` lẫn `updateMany`, luôn 200 (trừ 401/500), chỉ audit khi `modifiedCount>0`. Audit metadata không có hash/token.
- Token phát từ refresh không có `nonce`/`auth_time` (không bịa `now`). Step-up vẫn fail-closed.
- Verify lại: `typecheck` EXIT=0; `pnpm test:int -- refresh-token` → **22/22** pass trên Mongo thật.

## 🔴 Blocker

- [ ] **Race: hậu duệ mint SAU khi nhánh reuse đã revoke family → còn sống (INV-11)**
  `refresh-token.service.ts:205-240` (rotate) ↔ `:275` + `:300-302` (classifyMiss → revokeFamily).
  Trình tự lỗi khi 2 request cùng refresh value R chạy song song (ví dụ attacker giữ R bị rò và owner cùng gọi):
  1. A: `findOneAndUpdate` thắng (R → revoked, `replacedBy=S`).
  2. B: `findOneAndUpdate` → null → `findOne` thấy `revokedAt && replacedBy` → `updateMany({familyId, revokedAt:null})`. Lúc này S **chưa tồn tại**, nên không bị revoke.
  3. A: `insertRefreshToken(S)` với `revokedAt` chưa set → trả 200 + S.
  Kết quả: audit `TOKEN_REUSE_DETECTED` báo family đã bị revoke, nhưng S vẫn rotate được vô thời hạn (tới absolute expiry). Bên thắng có thể chính là attacker.
  Vì sao là 🔴: đây đúng là kịch bản strict rotation phải chặn (spec §9.5 dòng 332, INV-11). Tasks.md acceptance Task 1 yêu cầu rõ "mọi doc của family có `revokedAt != null` sau cuộc đua". Test `CONCURRENT…` (`refresh-token.int-spec.ts:389`) chỉ xanh vì bước 3 của A thường xong trước bước 2 của B. Code không bảo đảm thứ tự này, và dưới tải thì cửa sổ race nới rộng.
  Đề xuất (chọn 1, không cần transaction):
  - **(a) Đánh dấu trước, kiểm sau (write-then-check hai phía)**: ở nhánh reuse, **trước tiên** stamp `reuseDetectedAt` (ít nhất lên doc R), **sau đó** mới `updateMany` revoke family. Ở `rotate`, **sau** khi insert S thì đọc lại `findOne({ _id: old._id }, { reuseDetectedAt: 1 })`. Nếu đã có dấu thì revoke S và ném `RefreshRotationError('reuse')`. Vì sao đúng: nếu A đọc chưa thấy dấu thì dấu của B được ghi sau lần đọc đó, nên `updateMany` của B (chạy sau dấu) chắc chắn chạy sau insert S và sẽ bắt được S. Yêu cầu đọc/ghi trên primary (mặc định đã vậy).
  - **(b) Insert hậu duệ trước khi swap**: insert S (familyId lấy từ pre-read), rồi mới `findOneAndUpdate` R. Nếu swap thua thì revoke/xoá S. Mọi `updateMany` của nhánh reuse đều xảy ra sau swap thắng, nên luôn thấy S.
  **Test bắt buộc kèm theo**: làm race deterministic thay vì trông vào timing. Ví dụ `jest.spyOn(tokenService, 'insertRefreshToken')` giữ lại (await một promise) cho tới khi request reuse thứ hai chạy xong. Sau đó assert: (1) mọi doc của family có `revokedAt`; (2) refresh value S trả về (nếu có) dùng tiếp ở `/token` phải ra `invalid_grant`.

## Security invariants / trust boundaries đã kiểm

| Invariant | Kết quả | Bằng chứng |
|---|---|---|
| INV-10 tra cứu theo hash, không plaintext | ✅ | `sha256(value)` ở mọi query; `insertRefreshToken` chỉ lưu hash |
| INV-11 single-use + reuse → revoke family | ❌ race (🔴); ⚠️ reuse kèm scope sai không bị phát hiện (🟡-1) | `rotate`/`classifyMiss` |
| INV-12 không mở rộng scope/resource | ✅ | filter giữ resource; hậu duệ copy `old.scope/resource`; scope chỉ thu hẹp; test escalation/target |
| INV-14 resource ∈ allowedResources | ✅ | filter `$in: client.allowedResources` + test |
| AuthZ / IDOR / confused-deputy | ✅ | bind `clientId` ở rotate, classifyMiss, revokeFamily, revokeByToken; test cross-client `/token` + `/revoke` |
| Client auth trước state change | ✅ | `authenticateClient` trước nhánh grant và trước revoke |
| Failure fail-closed | ✅ | lỗi sign/audit → 500 `server_error` + no-store; `/revoke` DB lỗi → 500 |
| Exposure (log/audit/response) | ✅ | metadata `{familyId, count}`/`{resource, scope, familyId}`; `descriptionFor` tĩnh; `renderError` chỉ log stack của lỗi hạ tầng |
| Enumeration | ✅ (`invalid_grant` đồng nhất; `/revoke` 200). `invalid_scope`/`invalid_target` chỉ trả cho đúng client sở hữu token nên chấp nhận được |
| Concurrency | ❌ xem 🔴 | — |

## 🟡 Nên sửa

1. **Replay token đã rotate kèm `scope`/`resource` sai sẽ né được reuse detection** — `refresh-token.service.ts:88-106`.
   Pre-check `findOne({tokenHash, clientId})` không lọc theo trạng thái. Token R đã rotate + `scope=admin` → ném `invalid_scope` ngay, không gọi `rotate`, nên **không** revoke family và **không** có `TOKEN_REUSE_DETECTED`. Attacker giữ R bị rò có thể dò mà không kích hoạt báo động (INV-11 nói token đã revoke bị dùng lại *phải* revoke family).
   Vì sao chỉ là 🟡: attacker không nhận được token nào. Cái mất là tín hiệu phát hiện.
   Đề xuất: thêm `revokedAt: null, expiresAt: { $gt: now }` vào filter pre-check. Doc không active thì bỏ qua kiểm scope và để `rotate` → `classifyMiss` phân loại. Thêm 1 int test: replay R đã rotate kèm `scope` ngoài phạm vi → `invalid_grant` + family revoked + 1 alert.
2. **`scope` rỗng/lặp** — `refresh-token.service.ts:98-105`. `scope=` (chuỗi rỗng) cho ra `effectiveScope=[]` → access token có `scope:""`. `scope=profile profile` → scope bị lặp.
   Đề xuất: dedupe (`[...new Set(...)]`); nếu sau khi lọc ra rỗng thì coi như không gửi (dùng scope gốc) hoặc trả `invalid_scope`, chốt 1 cách.
3. **Thiếu test cho hệ quả fail-closed khi client retry** (acceptance Task 5, tech-lead fold) — `refresh-token.int-spec.ts:408-424` mới assert 500. Cần thêm bước: retry cùng R → `invalid_grant` + family revoked (strict rotation, phải login lại), kèm comment "đây là hành vi đúng".
4. **Thay đổi ngoài phạm vi**: `.vscode/mcp.json` (-34 dòng) và `.mcp.json` mới (untracked) không thuộc B4.5. Đề xuất tách ra hoặc revert trước khi commit run này.
5. **Hỏng encoding**: entry `backend-dev` trong `runs/14-B4.5/log.md` bị mất toàn bộ dấu tiếng Việt (`?`). Comment trong `refresh-token.service.ts` (L12, L49, L54, L190, L227, L254, L256) cũng có `?` thay cho `—`/`§`. Đề xuất ghi lại log bằng UTF-8 (công cụ ghi file của PowerShell 5 mặc định ANSI).

## 💭 Nit

- `token.controller.ts:337-338` `descriptionFor('invalid_grant')` nói "authorization code" nhưng giờ dùng chung cho refresh grant. Cân nhắc đổi thành "The provided grant is invalid, expired, or revoked.".
- `refresh-token.service.ts:122-124` audit `TOKEN_REFRESHED` dùng `actorType:'user'`, còn `TOKEN_REUSE_DETECTED`/`TOKEN_REVOKED` dùng `'client'`. Nên ghi chú lý do trong comment để người điều tra không thắc mắc.

## ✂️ Ponytail

- be/src/modules/oauth/token/refresh-token.service.ts:L15: yagni: `RotationFailure` + field `failure` không chỗ nào đọc (controller chỉ dùng `instanceof`). Thay bằng `class RefreshRotationError extends Error {}`.
- be/src/modules/oauth/token/refresh-token.service.ts:L277: delete: `userId` truyền vào `revokeFamily` nhưng không dùng (L296). Xoá cả tham số lẫn chỗ truyền.
- be/src/modules/oauth/token/refresh-token.service.ts:L82: shrink: kiểu `{ ip?; userAgent?; requestId? }` lặp 4 lần (L82, L158, L197, L263, L297). Thay bằng 1 `type AuditCtx`.
- be/src/modules/oauth/token/refresh-token.service.ts:L43: delete: `issuedAt` trong `RefreshDoc` không dùng.
- be/src/modules/oauth/token/token.service.ts:L251: yagni: `deviceId?` + spread L268 chưa có caller (DEBT-031 hoãn). Thêm khi làm B4.7/B6.3.
net: -12 lines possible.

## Chuyển tiếp

REJECT → **backend-dev**: sửa 🔴 (kèm test race deterministic), nên xử lý luôn 🟡-1..5 trong cùng lượt. Sau đó → senior-reviewer lượt 2. Không ghi DEBT vào backlog vì kết luận là REJECT. 🟡 nào chưa sửa sẽ chuyển thành DEBT khi PASS.