# Tasks — R1–R2

Nguồn: `plan.md` §4 (Phase R) + §5.B1 (Backend foundation) + §1 (kiến trúc). Gồm **R1–R5** và **B1.1–B1.5**.
spec.md & plan.md đã có sẵn — KHÔNG ghi đè.

Trạng thái: `todo → in-progress → in-review → testing → done`.

---
## R1 — Khởi tạo monorepo pnpm workspace + script gốc `[BE]`

**Phụ thuộc**: —  ·  **Size**: S  ·  **Trạng thái**: done

### Việc cần làm
- [x] `git init` (nếu chưa) + `.gitignore` (node_modules, dist, .env, build outputs, coverage)
- [x] `.editorconfig` (utf-8, lf, indent 2 space, trim trailing whitespace)
- [x] `.nvmrc` khớp `.node-version` hiện có (`v22.23.2`)
- [x] `pnpm-workspace.yaml` gộp 3 package: `be/`, `fe-admin/`, `fe-sso-test/`
- [x] `package.json` gốc (private, packageManager pnpm) với script gốc:
  - `dev:all` — chạy song song 3 app (dùng `pnpm -r --parallel run dev` hoặc tương đương)
  - `lint` — `pnpm -r run lint`
  - `typecheck` — `pnpm -r run typecheck`
  - `test` — `pnpm -r run test`
- [x] Tạo thư mục placeholder `be/`, `fe-admin/`, `fe-sso-test/` (đủ để workspace nhận diện; scaffold thực ở B1.1/A1/T1)
- [x] `README.md` khung (mô tả monorepo + link docs/agile/sso-idp)

### Nghiệm thu (plan §4)
- `pnpm i` ở gốc chạy được với 3 package (kể cả khi package con mới có `package.json` tối thiểu)
- `pnpm dev:all` chạy song song 3 app (khi các app đã có script `dev`); ở giai đoạn này chấp nhận placeholder script `dev` in ra thông báo
- `lint`/`typecheck`/`test` gốc fan-out xuống package con không lỗi cấu hình

### Ghi chú
- Tên thư mục `be/`, `fe-admin/`, `fe-sso-test/` theo đề xuất plan §1.1.
- KHÔNG scaffold NestJS/TanStack/React ở task này (đó là B1.1/A1/T1). Chỉ dựng khung workspace + script gốc.

---

## R2 — `docker-compose.yml` (mongo, redis, mailpit) + healthcheck `[BE]`

**Phụ thuộc**: R1  ·  **Size**: S  ·  **Trạng thái**: done (case "3 service healthy" PENDING — cần Docker host)

### Việc cần làm
- [x] `docker-compose.yml` với 3 service (pin version image theo plan §1.3):
  - `mongo` (mongo:7): port `27017:27017`, volume `mongo_data:/data/db`, healthcheck `mongosh ping`
  - `redis` (redis:7): `--appendonly yes`, port `6379:6379`, volume `redis_data:/data`, healthcheck `redis-cli ping`
  - `mailpit` (axllent/mailpit:v1.21): port SMTP `1025:1025`, UI `8025:8025`
- [x] `volumes: { mongo_data, redis_data }`
- [x] Profile `full` để (sau này) chạy `be` từ `be/Dockerfile`, depends_on mongo+redis healthy — khai báo khung, không cần Dockerfile ở task này
- [x] Ghi chú trong README: URL/port dev theo plan §1.2 (mongo `27017`, redis `6379`, mailpit UI `8025`)

### Nghiệm thu (plan §4)
- `docker compose up -d` → 3 service `mongo`/`redis`/`mailpit` đạt trạng thái healthy
- `docker compose ps` cho thấy healthcheck pass
- (BE kết nối được — sẽ kiểm chứng khi có B1.4; ở task này chỉ cần service healthy)

### Ghi chú
- Spec chỉ dùng `findOneAndUpdate` trên 1 document → KHÔNG cần replica set/transaction (plan §1.3).
- Không commit secret; compose dev không chứa credential thật.


## Definition of Done (áp cho R1–R5, rút gọn từ plan §10)
- Lint/cấu hình xanh; không TODO lơ lửng.
- `pnpm i` + `docker compose up -d` chạy được trên máy sạch (đã cài Docker + pnpm/Node theo `.nvmrc`).
- CI YAML hợp lệ; `.env.example` đủ biến theo §1.4; secret scan cấu hình đúng.
- Cập nhật `_progress.md` + `_handoff.md`.
