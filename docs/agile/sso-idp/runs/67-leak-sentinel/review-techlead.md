# Tech Lead Review — 2026-11-06

## Kết luận: PASS

Plan (= `tasks.md` + § Fold tech-lead) đủ để triển khai. Chi tiết điểm sửa, cách chứng minh và nhãn nằm ở § Fold của `tasks.md` (bắt buộc).

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc. Chỉ test-infra (script shell) và test spec; không chạm code production.

## Điểm mạnh

- DEBT-478 có gốc quan sát cụ thể; tech-lead tái hiện được bằng chạy thật (HEAD 3/4 đỏ, log `+sdown slave` → `-failover-abort-no-good-slave`, stall 3,3 s ở replica) và chứng minh sửa trên bản sao script (4/4 xanh, `no-good-slave` = 0).
- DEBT-477 dùng lại helper run 65 (`recordIssued`/`leakForms`), không thêm abstraction mới ngoài `hasIssued` 1 dòng cho 2 hàm gom lỗi.
- Ràng buộc an toàn (container `vg-b73c-*`, không FLUSH/drop `aegate-*`, mutation có backup + `git diff`) rõ.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có vấn đề chặn. Các điểm đã fold (dev phải làm đúng):
- [x] Chọn `--add-host` cho replica thay vì tăng `down-after-milliseconds` (lý do trong fold).
- [x] Chỗ không có token phát hành: `run55-tester.vault-spec.ts:279` dùng regex hình dạng JWT 3 phần; `log-canary` dùng `JWT_CANARY` + đoạn header/payload, cộng `idp.issued`.
- [x] Chống pass rỗng nghĩa: `issued` tăng trong 2 ca DEBT-388 của `token-code-recheck` (`:929`, `:957`); `idp.issued.length > 0` ở ca refresh FE.
- [x] Mutation: mỗi điểm RED khi nối dạng rò của token đã phát hành, GREEN khi nối cursor giả `eyJ0IjoxfQ`.

## Security design gate

Không chạm trust boundary production. Tính chất bảo mật được bảo vệ (không rò JWT qua body/log/audit) GIỮ hoặc MẠNH HƠN: thêm dạng signature-only/base64/base64url của token thật; regex field-name `access_token|refresh_token|id_token` giữ nguyên; chỗ không có token phát hành dùng hình dạng JWT đầy đủ (bắt mọi JWT thật).

## Đề xuất (không bắt buộc)

- Không có debt mới. Regex hình dạng JWT 3 phần ở `run54/55/56/57` giữ nguyên có chủ đích (không đỏ giả với cursor).

→ Chuyển **backend-dev** (Task 1, Task 2) và **frontend-dev** (Task 3); hai lane độc lập, có thể song song.
