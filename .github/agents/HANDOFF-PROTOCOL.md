# Giao thức bàn giao giữa các Agent (Handoff Protocol)

Các custom agent trong VS Code **không chia sẻ bộ nhớ**. Mỗi subagent chạy trong ngữ cảnh
riêng. Vì vậy chúng giao tiếp qua **file chung** trong thư mục tính năng.

## Cấu trúc thư mục mỗi tính năng

```
docs/agile/<slug>/
  _handoff.md          # Trạng thái hiện tại (ai đang giữ việc, cổng nào)
  _progress.md         # Nhật ký giao ca (mọi agent APPEND vào)
  spec.md              # analyst
  plan.md              # analyst
  tasks.md             # analyst → dev đánh dấu [x]
  review-techlead.md   # tech-lead
  review-senior.md     # senior-reviewer
  test-report.md       # tester
```

## Quy tắc BẮT BUỘC cho MỌI agent

1. **Khi bắt đầu**: đọc `_handoff.md` và `_progress.md` để biết bối cảnh + agent trước đã làm gì.
2. **Khi kết thúc**: APPEND một mục vào `_progress.md` và cập nhật `_handoff.md`.
3. Không xóa nội dung cũ của `_progress.md` — chỉ thêm vào cuối.

## Mẫu `_handoff.md` (ghi đè mỗi lần)

```markdown
# Handoff — <slug>
- Trạng thái: <IN_PROGRESS | BLOCKED | DONE>
- Agent hiện tại: <tên agent>
- Cổng gần nhất: <analyst | tech-lead | dev | senior | tester>
- Kết quả cổng: <PENDING | PASS | REJECT | FAIL>
- Việc tiếp theo: <mô tả ngắn cho agent kế>
- Vòng lặp: analyst=<n>, dev/senior=<n>, dev/tester=<n>
```

## Mẫu một mục trong `_progress.md` (append)

```markdown
## [<ngày giờ>] <tên agent>
- Đã làm: <tóm tắt 1-3 gạch đầu dòng>
- File đổi: <danh sách file>
- Kết quả: <PASS/REJECT/FAIL/DONE + lý do ngắn>
- Bàn giao cho: <agent kế> — <việc cần làm>
```

## Ví dụ `_progress.md` sau vài bước

```markdown
## [2026-09-22 10:00] analyst
- Đã làm: viết spec/plan/tasks cho tính năng login JWT
- File đổi: spec.md, plan.md, tasks.md
- Kết quả: DONE
- Bàn giao cho: tech-lead — review kiến trúc & tính khả thi

## [2026-09-22 10:15] tech-lead
- Đã làm: review plan, chỉ ra thiếu refresh token rotation
- File đổi: review-techlead.md
- Kết quả: REJECT — plan thiếu xử lý token hết hạn
- Bàn giao cho: analyst — bổ sung refresh token flow
```
