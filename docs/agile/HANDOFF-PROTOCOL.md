# Giao thức bàn giao giữa các Agent

Agent **không chia sẻ bộ nhớ** → giao tiếp qua file. Mục tiêu: **mỗi agent chỉ đọc
một lượng file cố định**, dù dự án lớn tới đâu.

## Cấu trúc

```
docs/agile/<slug>/
  STATUS.md          # dashboard: run hiện tại, cổng, tiến độ, chặn. GHI ĐÈ, ≤ 40 dòng
  backlog.md         # việc còn mở (🟡, debt, hoãn) — nguồn DUY NHẤT cho việc tồn đọng
  spec.md, plan.md   # nguồn sự thật, ổn định. Agent KHÔNG ghi đè (trừ analyst khi tạo mới)
  _run-plan.md       # (tuỳ) lệnh chạy từng nhóm task
  runs/
    NN-<task-ids>/   # vd 04-B1.6-B1.10 — một lần chạy pipeline = một thư mục
      tasks.md             # analyst/orchestrator
      review-techlead.md   # tech-lead
      review-senior.md     # senior-reviewer
      test-report.md       # tester
      log.md               # nhật ký giao ca CỦA RUN NÀY (append)
      summary.md           # orchestrator viết khi đóng run, ≤ 15 dòng
```

## Preflight — CodeGraph (BẮT BUỘC, MỌI agent, trước mọi việc khác)

Chạy ở thư mục gốc repo:

1. `codegraph --version` — lỗi / không tìm thấy lệnh → `npm install -g @colbymchenry/codegraph`, rồi chạy lại `codegraph --version` để xác nhận.
2. `codegraph status` — output có `Not initialized` → `codegraph init` (tạo `.codegraph/` + build index lần đầu).
3. Đã init → `codegraph sync`.

Lỗi lock → `codegraph unlock` rồi chạy lại. Cài/init/sync vẫn lỗi → dừng, báo lỗi thật, không làm tiếp.

## Đọc gì khi bắt đầu (BẮT BUỘC, theo thứ tự)

1. `STATUS.md` → biết run hiện tại.
2. Toàn bộ file trong `runs/<run hiện tại>/`.
3. `backlog.md` — chỉ các mục liên quan phạm vi đang làm.
4. `spec.md` / `plan.md` — **chỉ các § được tasks.md trỏ tới**, không đọc cả file.

**KHÔNG** đọc các run cũ. Cần tra cứu lịch sử → đọc `runs/*/summary.md`; chỉ mở file chi tiết khi thật sự cần.

## Ghi gì khi kết thúc (BẮT BUỘC)

1. File đầu ra của vai trò mình trong thư mục run (review/report). Chạy lại vòng mới → **ghi đè** file đó; lịch sử đã nằm trong `log.md` + git. **Không** dùng `<details>` để giữ bản cũ.
2. APPEND một mục vào `runs/<run>/log.md` (mẫu dưới, **≤ 8 dòng**).
3. Cập nhật dòng "Cổng / Kết quả / Việc tiếp theo / Vòng lặp" trong `STATUS.md`.
4. Có 🟡/debt/việc hoãn chưa xử lý → thêm dòng vào `backlog.md` (ID `DEBT-NNN` tăng dần).

## Mỗi thông tin chỉ ở MỘT nơi

| Thông tin | Nơi duy nhất | Chỗ khác |
|---|---|---|
| Output lệnh, bằng chứng test | `test-report.md` | chỉ ghi "xem test-report case N" |
| Chi tiết bug + fix | `log.md` (mục của dev) | chỉ ghi 1 dòng + trỏ tới |
| Nhận xét review | `review-*.md` | — |
| Việc còn mở | `backlog.md` | chỉ ghi ID `DEBT-NNN` |
| Trạng thái hiện tại | `STATUS.md` | — |

## Mẫu mục `log.md`

```markdown
## [YYYY-MM-DD HH:mm] <agent>
- Đã làm: <1–3 ý>
- File đổi: <danh sách>
- Kết quả: <PASS | REJECT | FAIL | DONE> — <lý do ngắn>
- Bàn giao: <agent kế> — <việc cần làm>
```

## Mở / đóng run (orchestrator)

**Mở run**: tạo `runs/NN-<ids>/` (NN = số tiếp theo, 2 chữ số) + `tasks.md` + `log.md`; cập nhật `STATUS.md`.

**Đóng run** (khi tester PASS):
1. Viết `summary.md`: phạm vi, kết quả x/y, commit, quyết định quan trọng, DEBT để lại (≤ 15 dòng).
2. `STATUS.md`: thêm dòng vào bảng Tiến độ, đặt "Run hiện tại" = run kế.
3. Mọi 🟡 chưa xử lý đã có trong `backlog.md`; debt nào run này sửa → chuyển sang "Đã đóng".

## Giới hạn kích thước

| File | Giới hạn | Vượt thì |
|---|---|---|
| `STATUS.md` | 40 dòng | Bảng Tiến độ > 20 run → gộp các run cũ thành 1 dòng mỗi milestone |
| `summary.md` | 15 dòng | cắt bớt, chi tiết đã có trong run |
| mục `log.md` | 8 dòng | chi tiết đưa vào review/report |
| run | ~5 task | orchestrator tách nhỏ hơn |
