# Senior Review — 2026-10-12 — Lượt 2

## Kết luận: PASS → tester

## Tổng quan

Đủ 5 🔴 của lượt 1 đã đóng thật, senior tự xác minh bằng mutation (bảng dưới). `revokeFamilyForEndedSession` chỉ gọi `revokeFamily` → `revokeWhere({familyId, clientId})`, nên cửa revoke vẫn là một (INV-11). Grep `updateMany`/`revokedAt` ngoài `revokeWhere` chỉ còn rotate (`updateOne` L254/L300) như trước. Re-check giờ chạy cho **mọi** code grant. Nhánh Redis lỗi: best-effort revoke có `.catch(() => undefined)` rồi `throw err` gốc, nên vẫn là 500 và không trả token (M11 bị bắt). Script so khớp: `spec.md` chứa **nguyên văn** 7/7 đoạn trích dẫn của fold (§8, §9.8 ×3, §14, §15 inv. 28/29), không BOM. Đã làm thêm 🟡#4 (`tokenCount +=`) kèm test race P=0/S=1.

Baseline senior chạy lại: int **397/397**, unit **131/131**, `tsc --noEmit` OK, `eslint src test` OK.

**Mutation do senior tự chạy.** Script Python áp mutation → chạy test → khôi phục trong `finally`. SHA-256 của cả 5 file nguồn khớp bản gốc trước và sau (`token.controller` E3A15F2B…, `consent.service` EADB79C4…, `refresh-token.service` BAC6BDE7…, `ui.controller` 8419F737…, `authentication.service` 381F956F…).

| # | Mutation | Kết quả |
|---|---|---|
| M1b | `if (!live)` → `if (!live && familyId)` (guard cũ) | ✅ int 1 fail (test non-refresh) |
| M2 | bỏ SWEEP logout (`ui.controller.ts`) | ✅ int 5 fail (ui.int-spec: thứ tự, đếm, race P=0/S=1) |
| M3 | bỏ SWEEP reset (`authentication.service.ts:193`) | ✅ unit 1 fail; ⚠️ int 397/397 xanh (🟡#2) |
| M4 | bỏ pre-revoke reset (L191) | ✅ unit 3 fail; ⚠️ int 397/397 xanh (SWEEP che, đúng thiết kế) |
| M6 | bỏ `$literal` quanh `allowedScopes` | ✅ int 1 fail (lượt 1: 0 fail) |
| M7 | thêm `revokeForSession` vào nhánh re-check | ✅ int 2 fail (F1 bị revoke) |
| M10 | bỏ best-effort revoke khi Redis lỗi | ⚠️ 397/397 xanh, chưa có test (🟡#3) |
| M11 | nuốt lỗi Redis ở re-check (`live = true`) | ✅ int 1 fail |

## 🔴 Blocker

Không còn. Trạng thái 5 🔴 của lượt 1:

- [x] Audit `TOKEN_REVOKED {reason:'session_ended', count}`: `refresh-token.service.ts:360` không có familyId/sessionRef/token. Test TOCTOU assert đúng 1 event và metadata sạch.
- [x] Re-check cho mọi code grant: `token.controller.ts` đã bỏ guard `familyId &&`. Test non-refresh assert `calls==2` và không có `access_token`/`id_token`. M1b bị bắt.
- [x] Idle-expire giữ family cũ: test `refresh-token.int-spec.ts:1538` kiểm F1 `revokedAt/familyRevokedAt == null` và F1 vẫn rotate. M7 bị bắt.
- [x] `$literal` có test phân biệt được: `consent.int-spec.ts:121`. M6 bị bắt.
- [x] spec.md đã áp nguyên văn (kiểm bằng script so chuỗi).

## Security invariants / trust boundaries đã kiểm

- **INV-11 (một cửa revoke)**: method mới chỉ là wrapper `revokeFamily` + audit, scope `{familyId, clientId}` do server quyết định (familyId lấy từ `issueForAuthorizationCode`, không lấy từ input của client). Không có `updateMany` mới.
- **INV-29 / interleaving**: phân tích ở lượt 1 vẫn đúng, giờ đóng cả nhánh không refresh. Logout có SWEEP + cộng dồn count, nên trường hợp P=0/S>0 vẫn có audit.
- **§8 giới hạn 1**: re-check chỉ revoke family vừa mint. Idle-expire/re-login không chạm family cũ (có test + M7).
- **Fail-closed**: Redis lỗi ở re-check ⇒ 500, không body token (M11). Best-effort revoke lỗi bị nuốt **chỉ** cho chính nó, lỗi gốc vẫn được ném ra. Revoke/audit lỗi ở nhánh `!live` ⇒ propagate 5xx, không trả token.
- **Exposure**: `familyId` không vào response/audit. Body 400/500 không chứa token (có test).
- **Consent**: `$literal` có cho requested/allowed/versions, test chặn hồi quy đã chạy được.

## 🟡 Nên sửa (không chặn, đã ghi backlog DEBT-056…062)

1. `refresh-token.int-spec.ts:1346`: vẫn chưa chứng minh AT/refresh cũ vô hiệu **sau khi tombstone hết TTL** (`redis.del('sess_end:'+ref)` rồi rotate refresh cũ ⇒ `invalid_grant`). Đây chính là điều DEBT-050 cần đóng. → DEBT-056.
2. Chưa có int race SWEEP thật cho reset: M3/M4 để int 397/397 xanh, chỉ unit `invocationCallOrder` bắt được. Logout race hiện cũng dùng mock (`ui.int-spec`). Cân nhắc 1 int test: gate `sessions.revokeAllForUser`, chạy `/token` trọn trong cửa sổ, sau đó assert family bị revoke. → DEBT-057.
3. `token.controller.ts` (catch của re-check): nhánh best-effort revoke chưa có test (M10 xanh). Test Redis-lỗi hiện có nên assert thêm `familyRevokedAt != null` cho family vừa mint. → DEBT-058.
4. `token.service.ts:139`: `TOKEN_ISSUED` được audit **trước** re-check. Khi re-check từ chối, audit trail vẫn ghi "issued" dù RP không nhận token, và nhánh non-refresh không ghi thêm event nào. Điều tra sự cố sẽ bị nhầm. Cân nhắc dời audit issued về controller sau re-check, hoặc ghi `TOKEN_REVOKED session_ended` cả khi không có family. → DEBT-059.
5. (giữ từ lượt 1 #5) `consent.service.ts`: chưa retry 1 lần khi `11000`. → DEBT-060.
6. (giữ từ lượt 1 #6) `runbook-deploy.md` §2b: chưa ghi trạng thái sau khi `syncIndexes` drop index cũ rồi build mới thất bại (không còn unique nào), cũng chưa có cách phục hồi. → DEBT-061.

## 💭 Nit

- `token.controller.ts`: comment re-check dài 10 dòng, kể lại spec. Nên giữ 3 dòng (vì sao check sau insert, chỉ revoke family vừa mint, fail-closed).
- `ui.controller.ts`: hai comment SWEEP chồng nhau (8 dòng). Nên gộp thành 2 dòng.

## ✂️ Ponytail

- be/src/modules/oauth/token/token.service.ts:L160: shrink: `...(familyId ? { familyId } : {})`. Dùng `familyId` (field optional).
- be/src/modules/ui/ui.controller.ts:L252: shrink: ternary global/local lặp 2 lần. Dùng `const revokeFamilies = () => global ? … : …;` rồi `let tokenCount = await revokeFamilies(); … tokenCount += await revokeFamilies();`.
- be/src/modules/oauth/token/token.controller.ts:L184: shrink: comment 10 dòng. Rút còn 3.
- be/src/modules/ui/ui.controller.ts:L263: shrink: 8 dòng comment SWEEP. Rút còn 2.
- be/src/modules/oauth/consent/consent.service.ts:L112: shrink: comment lặp JSDoc. Giữ 2 dòng.
- be/test/refresh-token.int-spec.ts:L1476: shrink: spy `exists` chọc vào `redis` private. Dùng `.mockImplementationOnce(real).mockRejectedValueOnce(new Error('redis down'))`.

net: -28 lines possible. (→ DEBT-062)

---

# Lượt 1 (lưu trữ)

## Kết luận: REJECT (5 🔴) → backend-dev

## Tổng quan

Hướng đi đúng và gọn: không thêm module/abstraction, `revokeWhere` vẫn là cửa revoke duy nhất, `revokeRef(…, tombstone=true)` mặc định an toàn, pipeline consent đúng mẫu fold. Thứ tự `resetPassword` đúng (setPassword → family → session MARK → family SWEEP → audit, không rollback), unit test fail-closed tốt. Phân tích interleaving (dưới) cho thấy **logic** pre-revoke + MARK + re-check + SWEEP đóng mọi thứ tự với code grant có refresh.

Nhưng có 3 acceptance trong fold bị bỏ sót (audit `session_ended`, re-check khi không mint refresh, test idle-expire), 1 test bảo mật rỗng (`$literal` — mutation không bị bắt), và văn bản `spec.md` chưa áp.

**Mutation do senior tự chạy** (khôi phục xong, SHA-256 cả 5 file nguồn khớp bản gốc; baseline int 393/393 xanh):

| # | Mutation | Kết quả |
|---|---|---|
| M1 | bỏ re-check sau insert (`token.controller.ts:193`) | ✅ bị bắt — 2 fail (TOCTOU + Redis lỗi) |
| M2 | bỏ SWEEP logout (`ui.controller.ts:268-272`) | ⚠️ chỉ bị bắt bởi test thứ tự gọi mock (`ui.int-spec.ts`), không có int race thật |
| M3 | bỏ SWEEP reset (`authentication.service.ts:193`) | ⚠️ chỉ bị bắt bởi unit test `invocationCallOrder` |
| M4 | bỏ pre-revoke reset (L191) | ✅ 3 unit fail |
| M5a/b/c | tombstone ở `establish` / `get()` absolute / đổi default sang `false` | ✅ đều bị bắt |
| M6 | bỏ `$literal` ở requested **hoặc** allowed (`consent.service.ts:131,133`) | ❌ **17/17 xanh — KHÔNG bị bắt** |
| M7 | `revokeFamily(familyId)` → `revokeForSession(sessionRef)` (`token.controller.ts:194`) | ❌ **85/85 xanh — KHÔNG bị bắt** |
| M8 | nuốt lỗi Redis ở re-check (`.catch(() => true)`) | ✅ bị bắt |

## 🔴 Blocker

- [ ] 🔴 **Acceptance: thiếu audit `TOKEN_REVOKED` khi re-check thấy phiên chết**
  `token.controller.ts:193-196` — revoke family rồi ném `invalid_grant`, không ghi audit nào.
  Vì sao: fold Task 2 bắt buộc `TOKEN_REVOKED metadata:{reason:'session_ended', count}` và acceptance bổ sung (1) yêu cầu "`TOKEN_REVOKED` 1 lần". Đây là sự kiện an ninh (code bị đổi trong lúc logout), nếu không audit thì không điều tra được.
  Đề xuất: `const count = await this.refresh.revokeFamily(...)` → `audit.record({ action: TOKEN_REVOKED, actorType:'client', actorId: client.clientId, clientId, result:'success', metadata:{ reason:'session_ended', count } })` (không familyId/ref/token) → throw. Test race ở `refresh-token.int-spec.ts:1404` assert đúng 1 event, metadata không chứa `familyId`/`sessionRef`.

- [ ] 🔴 **Acceptance/INV-29: re-check bị bỏ qua khi không mint refresh**
  `token.controller.ts:193` — `if (familyId && …)` ⇒ code grant không có `offline_access` sẽ không re-check và vẫn trả AT + id_token cho phiên đã bị logout trong cửa sổ.
  Vì sao: fold ghi rõ "Re-check chạy cả khi không mint refresh (không trả AT cho phiên đã chết)"; văn bản INV-29 sắp áp nói "không trả token". Tombstone che bớt AT ở `/introspect` nhưng id_token vẫn tới RP (RP đăng nhập user vừa logout).
  Đề xuất: `if (!(await this.sessions.exists(data.sessionRef))) { if (familyId) {revoke+audit} throw invalid_grant; }`. Thêm int test: scope không có `offline_access`, park sau `issueForAuthorizationCode` (spy `signAccessToken`/`audit.record`), revoke phiên ⇒ `400 invalid_grant`.

- [ ] 🔴 **Thiếu test cho invariant §8(1): re-check KHÔNG được giết family `offline_access` cũ**
  M7 (đổi sang `revokeForSession`) để 85/85 test xanh. Đây là acceptance bổ sung (3) trong fold Task 2.
  Vì sao: không có test thì refactor sau "cho gọn" sang `revokeForSession` sẽ âm thầm revoke family hợp lệ của user (sai §8 giới hạn 1, mất `offline_access`).
  Đề xuất: test `refresh-token.int-spec.ts` — mint family F1 từ phiên S; mint code thứ 2 cùng S; gate insert của code thứ 2 → `redis.del('sess:'+ref)` (idle-expire, không tombstone) → release ⇒ `invalid_grant`, F2 revoked, **F1 `revokedAt == null`** và refresh F1 vẫn `200`.

- [ ] 🔴 **Bảo mật: test chống field-path injection rỗng**
  `consent.int-spec.ts:109` — M6 (bỏ `$literal`) vẫn 17/17 xanh. Có và không có `$literal`, `'$grantedScopes'` đều bị `$setIntersection` lọc ra ⇒ assert không phân biệt được.
  Vì sao: fold Task 4 bắt buộc `$literal` và có test chặn hồi quy. Hiện tại test không chặn gì, nên ai xoá `$literal` (ví dụ "cho gọn") sẽ không bị phát hiện. Nếu sau này `allowedScopes` chứa giá trị `$…` thì nó bị hiểu là path ⇒ intersection sai ⇒ grant lệch.
  Đề xuất: test phân biệt được: `grant(u, …, ['$policyVersion'], versions(), ['$policyVersion'])` ⇒ expect `grantedScopes` **đúng bằng** `['$policyVersion']` (khi bỏ `$literal`, chuỗi bị resolve thành path ⇒ ra giá trị khác hoặc null ⇒ fail). Chạy lại M6 để xác nhận test fail.

- [ ] 🔴 **Spec chưa cập nhật**
  `spec.md:218` (§8 giới hạn 1), §9.8, §14, `spec.md:589-590` (inv. 28/29 vẫn còn nhãn "(Task 3)", chỉ "check trước") — chưa áp.
  Vì sao: tasks.md "Cập nhật spec.md — dev áp nguyên văn trong cùng commit". Code giờ cố ý KHÔNG tombstone ở re-login/absolute, nhưng spec vẫn nói ngược lại ⇒ tester/RP đối chiếu spec sẽ coi hành vi đúng là bug. Đây là thay đổi contract nên phải đi cùng commit.
  Đề xuất: dev áp **nguyên văn** 5 đoạn ở cuối tasks.md (§8 L218, §9.8, §14, §15 inv. 28, inv. 29). Mục chép spec trong STATUS/log nói "senior áp" là sai vai trò (senior không sửa file), nên sửa lại.

## Security invariants / trust boundaries đã kiểm

- **Reset (DEBT-050)**: thứ tự đúng `authentication.service.ts:175-193`. Link không hợp lệ hoặc `setPassword` false ⇒ `BadRequestException`, không revoke gì (unit L150). Revoke lỗi ⇒ propagate, không audit, không rollback (unit L118/L134). Không lộ token/hash. Int: refresh cũ ⇒ `invalid_grant`, `familyRevokedAt != null`, audit 1 lần ✅. 🟡: chưa chứng minh "AT vẫn inactive **sau khi tombstone hết**" (xem 🟡#1).
- **Interleaving logout/reset ↔ `/token` (DEBT-051)**: gọi P = pre-revoke, M = MARK, S = SWEEP; I = insert, C = re-check.
  - I < P ⇒ P bắt.
  - P < I < M ⇒ hoặc C < M (sống, gửi token) thì S bắt (`sessionRef`/`userId` khớp), hoặc C > M thì C tự revoke.
  - I > M ⇒ C thấy chết ⇒ tự revoke.
  - I chen giữa 2 `updateMany` của S ⇒ `revokedAt` vẫn được set, và C > M nên C cũng revoke.
  - Kết luận: đóng mọi thứ tự **cho nhánh có refresh**. Nhánh không refresh thì hở (🔴#2). `revokeByDevice` chưa có SWEEP, nhưng chưa có caller nên ngoài phạm vi.
- **Revoke đúng phạm vi**: `revokeFamily(familyId, client.clientId)` bị bound theo client ✅. Nhưng chưa có test (🔴#3).
- **Tombstone (DEBT-052)**: `false` chỉ ở `establish` (L157) và nhánh absolute của `get()` (L175). Logout/global/reset/device vẫn đi `revokeRef` default `true` hoặc `sessionRevokeAll` (Lua ghi tombstone) ✅, M5 bị bắt ✅. Guard `XX` không đổi.
- **Fail-closed**: Redis lỗi ở re-check ⇒ 500, không token (M8 bị bắt) ✅. Reset/logout lỗi ⇒ 5xx ✅.
- **Exposure**: `familyId` không vào body/log (`token.service.ts:160` chỉ trả nội bộ, controller chỉ `send(response)`) ✅.
- **Consent (DEBT-027)**: 1 round-trip, `updatePipeline:true`, filter cast ObjectId, `grantedAt` `$ifNull`, `$literal` có trong code ✅. Thiếu test chặn hồi quy (🔴#4). Race 20 vòng union đúng ✅. DEBT-026: test `authz_ctx:*` không tăng ✅.
- **Index (DEBT-028)**: test mô phỏng DB cũ ⇒ `dropped.Consent` chứa `userId_1_clientId_1`, chỉ còn key mới unique ✅. Trùng key ⇒ E11000, không xoá doc ✅. Runbook: backfill trước, kiểm duplicate bằng `$ifNull`, verify, `noeviction` ✅.

## 🟡 Nên sửa

1. `refresh-token.int-spec.ts:1346` — acceptance Task 1 yêu cầu AT "vẫn false **sau khi tombstone hết**". Test chỉ kiểm ngay sau reset. Cân nhắc `redis.del('sess_end:'+ref)` (giả lập hết TTL) rồi rotate refresh cũ ⇒ `invalid_grant`, tức không mint được AT mới active. Đây mới là điều DEBT-050 thực sự đóng.
2. Fold Task 2 acceptance (2): chưa có int race SWEEP thật (stub `sessions.revoke` để `/token` chạy trọn giữa P và M). M2/M3 hiện chỉ bị bắt bởi test thứ tự mock. Cân nhắc 1 test e2e trong `ui-auth.int-spec.ts` hoặc `refresh-token.int-spec.ts`.
3. `token.controller.ts:193` — fold yêu cầu khi Redis lỗi ở re-check thì revoke `familyId` best-effort rồi ném lỗi gốc. Hiện family để nguyên (vô hại vì giá trị refresh chưa rời server, nhưng thành doc rác sống 30d và lệch fold). Cân nhắc `try { exists } catch (e) { await revokeFamily(...).catch(() => {}); throw e; }`.
4. `ui.controller.ts:268-272` — số đếm của SWEEP bị bỏ, không cộng vào `tokenCount` (fold: "cộng dồn `tokenCount`"). Audit `TOKEN_REVOKED` sẽ đếm thiếu, hoặc bị bỏ qua khi P = 0 mà S > 0 (đúng case race). Đề xuất `tokenCount += await …`.
5. `consent.service.ts:122` — fold nhắc retry 1 lần khi upsert ném `11000`. Chưa làm và chưa test. Mongo ≥ 4.2 thường tự retry nhưng không đảm bảo. Nếu dính lỗi, user nhận 500 ở bước consent (fail-closed nhưng xấu UX).
6. `runbook-deploy.md` §2/§4 — `syncIndexes` **drop index cũ trước** rồi mới build index mới. Nếu build lỗi (E11000), collection không còn unique nào. Nên ghi rõ trạng thái sau lỗi + cách phục hồi (dọn duplicate rồi chạy lại sync; tạm thời upsert vẫn chạy nhưng có thể tạo trùng).

## 💭 Nit

- `session.service.ts:258-260` — comment `isEnded` xuống dòng lẻ ("the caller" / "(`isAccessTokenLive`)…"), nên reflow.
- `refresh-token.int-spec.ts:1474-1478` — comment test Redis-lỗi lủng củng ("if the body leaked…"), nên rút còn 1 câu.

## ✂️ Ponytail

- be/src/modules/oauth/token/token.service.ts:L160: shrink: `...(familyId ? { familyId } : {})`. Dùng `familyId` (field optional, `undefined` vô hại).
- be/src/modules/ui/ui.controller.ts:L268: shrink: lặp lại ternary global/local của L252-254. Dùng `const revokeFamilies = () => global ? …revokeAllForUser(…) : …revokeForSession(…);` gọi 2 lần (đồng thời sửa 🟡#4).
- be/src/modules/oauth/consent/consent.service.ts:L112: shrink: comment 10 dòng lặp JSDoc L93-100. Giữ 2 dòng (`$literal` chống field-path + `updatePipeline` bắt buộc).
- be/src/modules/authentication/authentication.service.ts:L181: shrink: comment 8 dòng kể lại tasks.md. Rút còn 3 dòng (thứ tự + không rollback).
- be/test/refresh-token.int-spec.ts:L1462: shrink: spy `exists` chọc vào `redis` private. Dùng `.mockImplementationOnce(real).mockRejectedValueOnce(new Error('redis down'))`.

net: -22 lines possible.
