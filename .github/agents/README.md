# Đội ngũ AI tự động (AI Agent Team)

Pipeline: **Yêu cầu → Spec/Plan/Task → Tech Lead review → Code (FE/BE) → Senior review → Tester**.

Các agent là custom agents của VS Code Copilot trong `.github/agents/`. Một phần nội dung chuyên môn
được trích và tinh chỉnh từ [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (MIT).

## Các agent

| Agent | Vai trò | Sửa code? |
|-------|---------|-----------|
| `orchestrator` | Điều phối tự động cả pipeline | Không (chỉ gọi subagent) |
| `analyst` | Yêu cầu → `spec.md` / `plan.md` / `tasks.md` | Chỉ tài liệu |
| `tech-lead` | Review plan + kiến trúc → PASS/REJECT | Không |
| `backend-dev` | Code task `[BE]` — API, DB, service | Có |
| `frontend-dev` | Code task `[FE]` — UI, component, state | Có |
| `senior-reviewer` | Review code (🔴🟡💭) → PASS/REJECT | Không |
| `tester` | Viết & chạy test | Chỉ viết test |

## Các agent giao tiếp với nhau như thế nào?

Custom agent trong VS Code **không chia sẻ bộ nhớ** — mỗi subagent chạy ngữ cảnh riêng.
Chúng giao tiếp qua **2 kênh**:

1. **Prompt bàn tay** (ngắn hạn): `orchestrator` truyền ngữ cảnh + đường dẫn khi gọi subagent;
   subagent trả về tóm tắt.
2. **File chung** (dài hạn, bền vững): mọi agent đọc/ghi trong `docs/agile/<slug>/`.

### Làm sao agent sau biết agent trước đã làm gì?

Mỗi lần chạy pipeline là một **run** (thư mục `runs/NN-<task-ids>/`). Agent chỉ đọc:

- **`STATUS.md`** — dashboard ngắn: run hiện tại, cổng, tiến độ, chặn.
- **`runs/<run hiện tại>/`** — tasks, review, test-report, `log.md` (nhật ký giao ca của run).
- **`backlog.md`** — việc còn mở (🟡, debt).

Run cũ không bao giờ phải đọc lại → tài liệu không phình theo thời gian.
Chi tiết trong [HANDOFF-PROTOCOL.md](../../docs/agile/HANDOFF-PROTOCOL.md).

## Cách dùng

### Cách 1 — Tự động toàn bộ (khuyến nghị)

1. Mở Chat, chọn agent **orchestrator**.
2. Nhập yêu cầu, ví dụ: *"Thêm endpoint đăng nhập email/password trả JWT"*.
3. Orchestrator tạo `docs/agile/<slug>/` (hoặc mở run mới nếu slug đã có), rồi tự chạy:
   analyst → tech-lead → backend-dev/frontend-dev → senior-reviewer → tester, xử lý retry và báo cáo cuối.

### Cách 2 — Thủ công từng bước (Handoff)

1. Chọn **analyst**, nhập yêu cầu.
2. Bấm nút **Handoff** để sang bước tiếp theo. Nếu REJECT/FAIL, dùng handoff quay lại đúng dev (BE/FE).

## Sản phẩm đầu ra

```
docs/agile/<slug>/
  STATUS.md            # dashboard (mọi agent cập nhật, ≤ 40 dòng)
  backlog.md           # việc còn mở / debt
  spec.md, plan.md     # analyst (không ghi đè khi đã có)
  runs/NN-<task-ids>/
    tasks.md           # analyst/orchestrator → dev đánh dấu [x]
    review-techlead.md # tech-lead
    review-senior.md   # senior-reviewer
    test-report.md     # tester
    log.md             # nhật ký giao ca của run
    summary.md         # orchestrator, khi đóng run
```

## Cổng kiểm soát (quality gates)

- **Tech Lead**: chặn nếu plan sai / over-engineered / kiến trúc không hợp lý.
- **Senior**: chặn merge nếu còn 🔴 (bảo mật, đúng đắn, phá contract).
- **Tester**: chặn nếu test fail hoặc thiếu acceptance criteria.
- Mỗi cổng retry tối đa **2 lần** rồi hỏi người dùng.

## Tùy chỉnh

- **Đổi model**: sửa `model:` trong frontmatter mỗi file `.agent.md`.
- **Thêm/bớt quyền tool**: sửa `tools:`.
- **Đổi flow**: sửa `handoffs:` (thủ công) và `agents:` của orchestrator (tự động).
- **Thêm agent chuyên gia** (vd security, database): tạo `.agent.md` mới, thêm tên vào `agents:` của orchestrator.

## Tham khảo

- [Custom agents in VS Code](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [agency-agents (nguồn nội dung chuyên môn)](https://github.com/msitarzewski/agency-agents)
