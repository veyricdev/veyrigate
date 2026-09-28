# Tech Lead Review — 2026-09-28 (R1–R2)

## Kết luận: **PASS**

`tasks.md` (R1–R2) khớp plan §1 (kiến trúc repo/hạ tầng) và §4 (bảng Phase R), phạm vi đúng, tiêu chí nghiệm thu phần lớn kiểm chứng được. Cho phép chuyển sang **backend-dev** (cả R1 và R2 gắn nhãn `[BE]`).

## Kiến trúc đề xuất
Không cần điều chỉnh. Monorepo pnpm workspace 3 package (`be/`, `fe-admin/`, `fe-sso-test/`) + docker-compose dev là lựa chọn hợp lý cho M0; không có over-engineering. Đúng nguyên tắc "chỉ dựng khung, scaffold thật ở B1.1/A1/T1".

## Điểm mạnh
- **Khớp nguồn sự thật**: tên thư mục theo §1.1; script gốc (`dev:all`/`lint`/`typecheck`/`test`) đúng §4; image `mongo:7`/`redis:7`/`axllent/mailpit` + healthcheck (`mongosh ping`, `redis-cli ping`) + volume `mongo_data`/`redis_data` + port đúng §1.2/§1.3.
- **`.nvmrc = v22.23.2`** khớp `.node-version` thực tế trong repo (đã kiểm).
- **Phạm vi kỷ luật**: R1 ghi rõ KHÔNG scaffold NestJS/TanStack/React; R2 khai profile `full` dạng khung, KHÔNG cần `be/Dockerfile` (đúng — Dockerfile thuộc B7.3). Không lấn R3–R5/B*/A*/T*.
- **Bảo mật cơ bản**: `.gitignore` loại `.env`; ghi chú "không commit secret" (nhất quán §1.4).
- **Phụ thuộc đúng**: R2 phụ thuộc R1.

## Vấn đề (bắt buộc sửa)
Không có vấn đề chặn việc code. **PASS**.

## Đề xuất (không bắt buộc — dev/tester xử lý khi thực thi, KHÔNG cần sửa tasks.md)
- **[R2 — nghiệm thu, ràng buộc môi trường Windows]** Máy chạy là Windows và Docker CÓ THỂ không sẵn. Tiêu chí "`docker compose up -d` → 3 service healthy" không kiểm chứng được nếu Docker off. Khi thực thi:
  - Nếu Docker sẵn → chạy `docker compose up -d` + `docker compose ps` xác nhận `healthy` (như hiện tại).
  - Nếu Docker KHÔNG sẵn → nghiệm thu tối thiểu = `docker compose config` (validate YAML/compose spec, không lỗi cú pháp) + ghi hướng dẫn trong README để người có Docker xác nhận `healthy`. Đánh dấu phần "healthy" là *pending verify on a Docker host* trong handoff, không coi là fail.
- **[R1 — `dev:all` khi chưa có app thật]** Acceptance "`pnpm dev:all` chạy song song 3 app" chỉ kiểm chứng được với placeholder `dev` script (task đã lường trước). Dùng `pnpm -r --parallel run dev` với script `dev` in thông báo ở mỗi package con để chạy không lỗi. Cân nhắc thêm `--if-present`/`--no-bail` để lint/typecheck/test fan-out không fail khi package con chưa có script tương ứng — tránh false-negative ở giai đoạn khung.
- **[R1 — `pnpm i` với package con tối thiểu]** Đảm bảo mỗi thư mục placeholder có `package.json` tối thiểu (name + private) để workspace nhận diện; nếu không, `pnpm-workspace.yaml` glob sẽ không match và `pnpm i` không kiểm chứng được như acceptance mô tả.

## Bàn giao
- Cổng: **tech-lead** → Kết quả: **PASS**
- Tiếp theo: **backend-dev** hiện thực R1 rồi R2 theo `tasks.md`; **tester** áp nghiệm thu với fallback Docker ở trên.
