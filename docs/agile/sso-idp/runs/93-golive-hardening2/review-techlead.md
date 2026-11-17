# Tech Lead Review — 2026-11-17 (run 93 `93-golive-hardening2`, fold không qua analyst)

## Kết luận: PASS (có điều kiện: thi hành D93.1–D93.12 ở cuối `tasks.md`)

T1–T5 khả thi, đúng vấn đề, phạm vi nhỏ, không đổi kiến trúc sản phẩm. Plan có 5 chỗ chưa thi hành được nguyên văn hoặc sai số liệu. Đã vá bằng quyết định thay vì REJECT:

1. **T4 — harness chưa có cách bỏ nhóm thời gian.** `pentest.mjs` chỉ có `--only <GROUP>`, không có `--skip`. Các check `AUTHN-ENUM-TIME-*` (tier `must`) nằm chung nhóm `AUTHN` với `AUTHN-THROTTLE-XFF`, `AUTHN-PREHIJACK-VERIFY`, MFA replay/brute force. Bỏ nguyên nhóm `AUTHN` sẽ mất các check bảo mật quan trọng nhất. Cần cờ riêng (D93.4).
2. **T4 — evidence cố định** `runs/90-X6-pentest-signoff/evidence` (`pentest.mjs:22`). Trong CI, ghi vào repo checkout là vô nghĩa và không được commit. Cần `--evidence <dir>` (D93.5).
3. **T4 — ràng buộc "harness chỉ chạy SAU E2E" (DEBT-664)** mâu thuẫn với việc dev lô C tự chạy harness để verify. Lô C không chạy harness cục bộ. Cả hai chế độ (`--timing off` và đầy đủ) chạy ở gate E, theo thứ tự cố định (D93.6/D93.10).
4. **T2 — tiêu chí "3 dòng `Terminated the WebServer`" sai cho X3.** `playwright.x3.config.ts` có **4** webServer: BE, vite alpha, vite beta, tls-proxy. Tiêu chí đúng là 3 cho `playwright.config.ts` và 4 cho X3 (D93.2).
5. **T5 — DEBT-676 chuyển khoá vào homedir làm `be/test/drills-lock.spec.ts` chạm khoá thật của người dùng.** Spec đang tạo/xoá `LOCK_FILE` thật. Nếu dev đang chạy drill, spec làm hỏng khoá. Spec phải chạy child với `HOME`/`USERPROFILE` trỏ vào thư mục tạm (D93.8).

## Kiến trúc đề xuất

Không đổi kiến trúc. CI thêm **một job độc lập `pentest`** trong `ci.yml`, cùng trigger với CI (push + pull_request `develop`/`main`). Lý do chọn mỗi push thay vì chỉ `workflow_dispatch` + lịch:

- **Thời lượng.** Lượt `pentest-20261117T021931Z` mất 181 s: boot 15 s, AUTHN 99 s (gần hết là 4×440 request đo thời gian), INJ 58 s. Bỏ phần đo ⇒ harness ước tính ~1,5 phút. Cộng install, build, Mongo rs0 ⇒ job khoảng 5–6 phút, chạy song song với `e2e` (~13 phút, đường găng). **Wall-clock CI không tăng.**
- **Độ ổn định.** Phần đo thời gian là nguồn nhiễu duy nhất đã biết (DEBT-658). Phần còn lại là assert xác định: status, header, cookie, IDOR, JWT giả. Lượt 254/254 và 261/261 ở run 90/91 lặp lại ổn định. `SHOULD-PERF-ARGON` có thể lật trên runner 2 vCPU, nhưng tier `should` không đổi exit code (`evidence.ok` chỉ xét `must.fail`), nên không làm đỏ job.
- **Giá trị production.** Hồi quy black-box (CSRF theo route, IDOR chéo tenant, JWT giả, cookie flags) phải chặn được ở PR. Chạy theo lịch chỉ phát hiện sau khi đã merge. Job này đủ điều kiện làm required status check.

Hạ tầng của job dùng **đúng mẫu job `e2e`**: Mongo `docker run --replSet rs0 -p 27017:27017` cùng digest, service Redis 6379 và Mailpit 1025/8025 cùng digest. Khớp nguyên các hằng của harness (`127.0.0.1:27017/6379/1025/8025`) ⇒ không phải sửa host/port trong harness.

## Điểm mạnh

- Run nhỏ, chọn đúng việc làm được trong repo; go-live (1)/DEBT-670 được loại ra có lý do.
- Ràng buộc hạ tầng và secret rõ ràng, kế thừa bài học run 92 (gitleaks D92.8, DEBT-664 Mailpit).
- T1 có tiêu chí xanh ngay từ đầu (ghi bằng chứng rồi đóng), không ép sửa khi không đỏ.
- Phần lớn T3 đã xong từ run 87: `ops/backup/mongo-{backup,restore}.sh` nhận URI qua `--config` 0600 và từ chối `MONGO_URI` có `@`; §4c đưa URI qua stdin. Phần còn lại chỉ là runbook.
- Harness đã có sẵn bộ lọc exposure (D90.17) ⇒ upload evidence lên artifact không làm lộ secret theo lượt.

## Vấn đề (đã chuyển thành quyết định bắt buộc, không REJECT)

- [x] Không có cách bỏ `AUTHN-ENUM-TIME-*` mà giữ phần còn lại của AUTHN ⇒ D93.4 (cờ `--timing off`; thay bằng check hình dạng response `AUTHN-ENUM-SHAPE-*`, không mất kiểm dò email theo nội dung).
- [x] Evidence path cố định ⇒ D93.5 (`--evidence <dir>`, CI ghi vào `$RUNNER_TEMP`, upload artifact).
- [x] Harness cục bộ trước E2E vi phạm ràng buộc ⇒ D93.6 + D93.10.
- [x] Tiêu chí X3 "3 dòng" sai ⇒ D93.2 (4 dòng).
- [x] Spec khoá chạm `~/.vg-drill.lock` thật ⇒ D93.8.
- [x] T3 chưa liệt kê chỗ cụ thể, có cả `ADMIN_SEED_PASSWORD='<tạm>'` gõ tay ở §3c ⇒ D93.3 (danh sách dòng + grep nghiệm thu).
- [x] T1 chỉ nêu ca "app tự sinh stream". Đường thật của BFF là body `fetch()` upstream (undici) đi thẳng qua srvx, và upstream có thể reset giữa body ⇒ D93.1 (3 ca).

### Cổng security design (T1, T4, T5 chạm trust boundary)

- **T1 (DoS BFF).** Tài sản: tính sẵn sàng của BFF admin. Actor: client không xác thực, chỉ cần mở rồi đóng socket. Invariant: client huỷ hoặc upstream lỗi giữa body ⇒ chỉ request đó hỏng, process sống, request kế tiếp 200. Failure semantics:
  - lỗi stream của **một** response được cô lập;
  - mọi lỗi khác **vẫn** làm process chết (fail-closed, orchestrator restart).

  Test âm bắt buộc nếu dùng `process.on`: xem D93.1.
- **T4 (CI).** Không thêm secret GitHub. `permissions: contents: read`. PR từ fork chạy không có secret, giống các job khác. Evidence qua bộ lọc exposure D90.17. Ghi evidence thất bại ⇒ không ghi file, exit 1. Artifact giữ 14 ngày. Không upload `be` log thô.
- **T5 (khoá).** `~/.vg-drill.lock` nằm trong home của chính user, người khác không ghi được. `wx` = O_EXCL nên từ chối cả symlink đặt sẵn. Mode 0600. Không quay lại `tmpdir` (CodeQL #36).

## Trả lời câu hỏi orchestrator

- **T4 mỗi push hay dispatch + lịch?** Mỗi push và PR, job riêng, `timeout-minutes: 15`. Lý do ở mục Kiến trúc. Không thêm `schedule`/`workflow_dispatch` (YAGNI). Bản đầy đủ có đo thời gian vẫn chạy tay theo runbook-deploy §4 bước 0.
- **Mutation m1–m4 trong CI?** **Không** ở run này. Mutation kiểm "test của test" (harness có bắt được hồi quy không), chỉ cần chạy lại khi `be/scripts/pentest/**` đổi. Mỗi mutant boot một BE (~7 lượt × 15–60 s). Mở DEBT-682: job mutation chạy khi PR đổi `be/scripts/pentest/**`.
- **T3 phạm vi chính xác:** D93.3.
- **T5 DEBT-676 homedir trên host production?** Drill và pentest **không chạy trên host production**:
  - hằng `127.0.0.1:27017/6379` của hạ tầng dev;
  - từ chối DB không phải `vg-*`, Redis ngoài db 7/8;
  - runbook-deploy §4 ghi "không phải production".

  Drill restore hằng quý chạy trên máy vận hành có hạ tầng dev, không chạm DB production. Homedir hợp lệ, ngữ nghĩa là "một khoá cho mỗi OS user trên host, mọi checkout". Hai OS user khác nhau trên cùng host vẫn còn lớp chặn thứ hai `assertNamespace` (TOCTOU chấp nhận). Không chạy drill qua `sudo` (HOME đổi). Comment `lib.mjs` ghi đúng như vậy. Khoá theo cổng TCP (tự nhả khi crash) đã cân nhắc nhưng **không chọn**: Windows bind semantics khác, và đổi cơ chế vượt phạm vi DEBT.
- **Chia lô/agent:** D93.9.
- **DEBT mới:** DEBT-682 (mutation harness trong CI khi `be/scripts/pentest/**` đổi). Không mở thêm: SMTP 220 precheck đã nằm trong DEBT-664; required status check `pentest` là việc của người dùng trên GitHub (ghi vào STATUS "Việc tiếp theo").

## Đề xuất (không bắt buộc)

- Có thể in `::warning::` cho mỗi check `should` fail trong CI để dễ thấy. Không bắt buộc: dòng `FAIL should …` đã có trong log job.
- DEBT-658 giữ mở cho phần bootstrap khoảng tin cậy của check thời gian. Phần "fail giả SHOULD làm đỏ job" đã được giải quyết bằng thiết kế exit code hiện có. Ghi chú vào DEBT-658 khi đóng run.
