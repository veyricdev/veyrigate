# Tech Lead Review — 2026-11-09 (run 79, sweep 🟡 BE đợt 3)

## Kết luận: PASS

Lô 6 task [BE] (fold chi tiết: `tasks.md` mục "Fold tech-lead"): T1 DEBT-521, T2 DEBT-182 (+ đóng DEBT-188), T3 DEBT-483, T4 DEBT-180 (+ DEBT-119), T5 DEBT-179, T6 DEBT-168. Chuyển **backend-dev**.

## Kiến trúc đề xuất

Không đổi kiến trúc. Một quyết định mới do tech-lead chốt (ủy quyền theo tiêu chí production, `plan.md` §12):

- **DEBT-483**: production + Mongo không hỗ trợ transaction (không phải replica set/mongos) ⇒ BE **không khởi động**; development/test ⇒ WARN. Lý do: từ run 69 (DEBT-142) và run này (T2) các thao tác quản trị và provisioning cần transaction; lỗi cấu hình phải lộ lúc deploy, không phải 5xx lúc admin thao tác. Khác Redis standalone (chỉ WARN) vì Redis standalone vẫn đúng chức năng, Mongo standalone thì không. `/ready` giữ nguyên.
- **DEBT-182**: provisioning federated (User + UserTenant + FederatedIdentity) gói trong 1 transaction theo mẫu `SuperAdminGuard.runGuarded`, bỏ bù trừ thủ công. Không thêm abstraction transaction dùng chung (mới 2 chỗ dùng).

## Kiểm từng ứng viên trên code hiện tại (develop `3a9e012`)

Không ứng viên nào đã được sửa gián tiếp. DEBT-188 đóng kèm T2: khi 3 insert commit nguyên tử, bên thua race luôn thấy FI của bên thắng ⇒ đăng nhập vào user đó (hết 503 / `/auth/link` lệch) — AC (3) của T2 kiểm điều này.

| Debt | Trạng thái code | Quyết định |
|---|---|---|
| 521 | `ui.controller.ts:359-362` gọi `revokeAllUserCredentials` không có `onFailure`; test `ui.int-spec.ts:1056,1079` khẳng định 0 audit | **Chọn T1** — sự kiện bảo mật (đăng xuất mọi nơi thất bại một phần) không để lại dấu vết audit; sửa 1 chỗ, cùng hình admin lock/reset |
| 182 | `federation.service.ts:371-401` 3 insert rời + bù trừ; tiến trình chết giữa chừng ⇒ user mồ côi vĩnh viễn bị coi là "email trùng local" | **Chọn T2** — toàn vẹn dữ liệu ở production; replica set đã là điều kiện prod |
| 188 | Còn (bên thua nhận 503 hoặc `/auth/link`) | **Đóng kèm T2** |
| 483 | Không có kiểm nào (`mongo.service.ts` chỉ `ping`); standalone chỉ lộ khi giáng/khoá super_admin (5xx) | **Chọn T3** — vận hành: cấu hình sai phát hiện lúc deploy |
| 180 | `seed.ts:122-133` mọi lỗi `createIndexes` ⇒ "remove duplicated documents", nuốt lỗi gốc | **Chọn T4** — chẩn đoán sai khi seed production (NotWritablePrimary, thiếu quyền) |
| 119 | Còn (`seed-dev.ts:130` `assertNotProduction` là allowlist) | **Gộp T4** — chạm cùng file seed, chỉ đổi tên |
| 179 | Còn (`client.service.ts:250,311` + `assertAdminCapableType` :475) | **Chọn T5** — rẻ; gộp về một định nghĩa với mọi chốt runtime, tránh cấu hình chết |
| 168 | Còn (`local-key-provider.ts:72`, nhánh lỗi không có test) | **Chọn T6** — rẻ, đóng debt test; provider dev-only nên đặt cuối lô |
| 129 | Còn (`admin-clients.controller.ts:347-363`: audit lỗi sau rotate ⇒ 5xx, version mới không ai biết plaintext, version cũ vào grace) | Hoãn. Chốt: fail-closed đã đúng (không trả plaintext khi chưa audit); cửa sổ = Mongo lỗi đúng giữa insert và audit; khôi phục = admin rotate lại trong thời gian grace. Rollback grace an toàn với rotate đồng thời phức tạp hơn lợi ích. Đưa "5xx khi tạo/rotate secret ⇒ rotate lại" vào X6 release checklist/runbook |
| 134 | Còn (`client.service.ts:383` `after = {...before, ...set}`) | Hoãn: chỉ hiển thị `updatedAt` cũ trong response PATCH; sửa đúng cần đọc lại sau ghi |
| 120 | Còn (3 peek trên `GET /login`) | Hoãn: chỉ hiệu năng (1–2 GET Redis) |
| 121 | Còn (`reauthAfter` từ `Date.now()` khác node) | Hoãn: fail-closed UX khi lệch đồng hồ; NTP đủ |
| 192 | Còn (`authTime = now` cho GitHub/Google) | Hoãn: giới hạn đã biết, chưa có RP cần |

## Điểm mạnh

- Gom theo module: ui (T1), clients (T5), seed (T4), keys (T6), mongo (T3), federation/identity (T2) — diff không chồng chéo.
- T1/T5 tái dùng hàm đã kiểm chứng (`revokeAllUserCredentials(onFailure)`, `isAdminCapableClient`) thay vì thêm logic song song.
- T2 xoá code bù trừ (nhỏ hơn sau khi sửa) và đóng luôn một debt UX.
- Mỗi task có ca RED đo được + mutation chỉ rõ test nào phải đỏ.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có. Lưu ý thực thi (bắt buộc làm đúng):
- [ ] T1 không đổi thứ tự/hình audit success và nhánh `scope=session`.
- [ ] T2: mọi insert trong `fn` phải đi qua `session`; `afterLostRace` và mọi đọc khác chạy NGOÀI transaction; INV-22 (không link theo email) không đổi.
- [ ] T3: thông điệp khởi động cố định, không URI/credential; dev/test không bị chặn khởi động.
- [ ] T4: không echo `err.message` của lỗi index (PII từ E11000).
- [ ] Không chạy CLI vào DB dev `sso-idp`.

## Đề xuất (không bắt buộc)

- DEBT-526 (mới, backlog): logout `scope=session` lỗi một phần (token đã revoke, session revoke lỗi) cũng không có audit failure.
- X6: thêm mục runbook cho DEBT-129 (5xx khi rotate secret ⇒ rotate lại trước khi hết grace).
