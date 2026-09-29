# Senior Review — 2026-09-28 (R1–R2)

## Kết luận: **PASS**

Phạm vi R1 (monorepo pnpm workspace + script gốc) và R2 (docker-compose mongo/redis/mailpit + healthcheck + profile `full`) khớp `plan.md` §1 và §4, đối chiếu đủ tiêu chí. Không còn 🔴 blocker. Chuyển sang **tester** để xác nhận "3 service healthy" trên Docker host.

## Tổng quan
Diff gọn, kỷ luật, đúng "chỉ dựng khung — scaffold thật ở B1.1/A1/T1". Không lấn R3–R5 (không có CI/gitleaks/.env.example), không scaffold app thật. Placeholder tối giản, đủ để `pnpm-workspace` nhận diện. Config khớp nguồn sự thật gần như 1:1 với plan §1.3. Verify thật đã ghi trong handoff (`pnpm i` 4 project, `typecheck`/`lint` EXIT=0, `docker compose config` EXIT=0).

Điểm tốt cụ thể:
- `pnpm-workspace.yaml` liệt kê đủ 3 package (`be`, `fe-admin`, `fe-sso-test`) — khớp §1.1.
- Script gốc `dev:all`/`lint`/`typecheck`/`test` fan-out đúng; `--if-present --no-bail` xử lý đúng giai đoạn khung (theo đề xuất tech-lead), tránh false-negative.
- `.nvmrc` (`v22.23.2`) **khớp** `.node-version` (`v22.23.2`) — đã đọc cả hai file.
- docker-compose: image pin (`mongo:7`, `redis:7`, `axllent/mailpit:v1.21`); healthcheck `mongosh --quiet --eval db.adminCommand('ping')` và `redis-cli ping` đúng cú pháp và khớp §1.3; port `27017/6379/1025/8025` đúng §1.2/§1.3; volume `mongo_data`/`redis_data`.
- Profile `full` đặt trên service `be` → mặc định `docker compose up -d` KHÔNG chạy `be` (đúng yêu cầu). `depends_on ... service_healthy` khai báo khung hợp lý; `be/Dockerfile` để B7.3.
- Bảo mật: `.gitignore` loại `.env`/`.env.local`; không secret hardcode trong compose/package.json.

## 🔴 Blocker
- Không có.

## 🟡 Nên sửa
- Không có (trong phạm vi R1–R2). Các điểm dưới là 💭 nit, không chặn PASS.

## 💭 Nit
- `docker-compose.yml:9-13` — healthcheck mongo/redis đã có `interval`/`retries` khớp plan nhưng thiếu `start_period`. Mongo lần đầu init hơi lâu; thêm `start_period: 10s` sẽ giảm nguy cơ container bị đánh dấu `unhealthy` tạm thời lúc khởi động. Không bắt buộc vì `retries: 5 × interval 10s` đã đủ dung sai.
- `docker-compose.yml` — cân nhắc thêm healthcheck cho `mailpit` (vd. HTTP `/livez` hoặc `/readyz` cổng 8025) để tiêu chí "3 service healthy" của R2 áp được cho cả `mailpit`. Plan §1.3 không yêu cầu, nên đây chỉ là gợi ý; hiện `mailpit` không có healthcheck nên `docker compose ps` sẽ không hiện `healthy` cho nó. Tester lưu ý: acceptance "3 service healthy" thực chất chỉ mongo/redis báo `healthy`; mailpit chỉ `running` — vẫn coi là đạt.
- `package.json` (gốc) — `packageManager: pnpm@12.6.0` cố định là tốt cho reproducibility; nếu môi trường CI (R4 sau này) dùng bản pnpm khác sẽ cần đồng bộ. Ghi nhận để R4.

## Ghi chú môi trường
- Docker daemon tắt trên máy dev → tiêu chí R2 "3 service healthy" **PENDING verify on a Docker host**. `docker compose config` đã EXIT=0 (cú pháp/compose spec hợp lệ). Theo fallback tech-lead, KHÔNG coi là fail → không ảnh hưởng kết luận PASS.

## Bàn giao
- Cổng: **senior** → Kết quả: **PASS**
- Tiếp theo: **tester** — chạy `docker compose up -d` + `docker compose ps` trên Docker host xác nhận `mongo`/`redis` đạt `healthy`; chạy lại `pnpm i` + `pnpm dev:all`/`lint`/`typecheck`/`test` xác nhận fan-out không lỗi.

