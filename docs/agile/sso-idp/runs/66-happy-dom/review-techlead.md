# Tech Lead Review — 2026-11-06
## Kết luận: PASS

## Kiến trúc đề xuất (nếu cần điều chỉnh)
Không đổi kiến trúc. Bump dev-dep 1 bản patch + dọn cấu hình audit; chi tiết thực thi ở `tasks.md` § Fold tech-lead.

## Điểm mạnh
- Phạm vi hẹp, đúng hạn DEBT-369/371 (2026-11-04), cùng commit như đã hẹn.
- Đã probe trên bản sao (scratchpad): gỡ cả 2 ignore + bump 21.0.4 ⇒ `pnpm audit --audit-level high` exit 0; chưa bump ⇒ exit 1 (gate còn sống). Lockfile chỉ đổi 11 dòng, toàn happy-dom/chuỗi peer vitest; deps của happy-dom không đổi.
- Registry: 21.0.4 là `latest`, 17 ngày tuổi (≥ 14), không có bản mới hơn; GHSA-834v vá ở 21.0.4 (dải lỗi ≤ 21.0.3); braces GHSA-vfj7 vẫn withdraw.

## Vấn đề (bắt buộc sửa nếu REJECT)
- (không) — các điểm phải làm đã fold vào `tasks.md`:
  - [x] Giữ `auditConfig.ignoreGhsas: []` + comment chính sách (ci.yml:49 trỏ tới nó), không xoá cả khối.
  - [x] Comment override zod đổi `DEBT-369` → `DEBT-479` (DEBT-369 đóng, phần zod chưa xong).
  - [x] Thứ tự `--lockfile-only` → kiểm diff → `--frozen-lockfile`; EPERM/EBUSY ⇒ dừng và báo, không kill.

## Security design gate
Không chạm trust boundary runtime (happy-dom chỉ là môi trường vitest dev, không vào bundle/Docker). Supply chain: gỡ ignore làm gate CI chặt hơn (không còn nuốt im lặng nếu GHSA-vfj7 được khôi phục); bản chọn đủ tuổi, integrity mới ghi trong fold.

## Đề xuất (không bắt buộc)
- DEBT-479 (mới, backlog): gỡ override `zod: 4.6.6` khi bump zod kế tiếp và mọi bản transitive tự resolve ≥ 4.6.6.
