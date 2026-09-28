# Test Report — 2026-09-28 (R1–R2)

## Kết quả: **PASS** (8/8 case xanh)

Tất cả case R1 & R2 xanh. Case R2 "3 service healthy" ban đầu PENDING (Docker daemon off) đã được **verify lại ngày 2026-09-28 khi Docker chạy** → mongo/redis/mailpit đều `healthy`. Không có case nào FAIL.

## Bảng case → kết quả

| # | Case | Lệnh | Kỳ vọng | Kết quả |
|---|------|------|---------|---------|
| 1 | R1 `pnpm i` (3 package con) | `pnpm i` | "all 4 workspace projects", EXIT 0 | ✅ PASS |
| 2 | R1 typecheck | `pnpm -r run typecheck` | EXIT 0 (placeholder OK) | ✅ PASS |
| 3 | R1 lint | `pnpm lint` | EXIT 0 | ✅ PASS |
| 4 | R1 dev:all fan-out 3 app | `pnpm dev:all` | 3 script `dev` chạy song song, không treo | ✅ PASS |
| 5 | R1 `.nvmrc` == `.node-version` | đọc 2 file | cả hai = `v22.23.2` | ✅ PASS |
| 6 | R2 compose config | `docker compose config` | EXIT 0 (cú pháp hợp lệ) | ✅ PASS |
| 7 | R2 mongo/redis healthy | `docker compose up -d` + `ps` | mongo & redis `healthy` | ✅ PASS (verified 2026-09-28) |
| 8 | R2 `be` không chạy mặc định | `docker compose config --services` | default không có `be`; `--profile full` mới có | ✅ PASS |

## Lệnh đã chạy + output thực tế

### Case 1 — `pnpm i`
```
Scope: all 4 workspace projects
Already up to date
Done in 6ms using pnpm v12.6.0
EXIT=0
```

### Case 2 — `pnpm -r run typecheck`
```
Scope: 3 of 4 workspace projects
be typecheck$ echo "[be] TODO: typecheck at B1.1"
fe-admin typecheck$ echo "[fe-admin] TODO: typecheck at A1"
fe-sso-test typecheck$ echo "[fe-sso-test] TODO: typecheck at T1"
(3× Done)
EXIT=0
```

### Case 3 — `pnpm lint`
```
$ pnpm -r --no-bail run --if-present lint
Scope: 3 of 4 workspace projects
be lint$ echo "[be] TODO: lint at B1.1"      └─ Done
fe-sso-test lint$ echo "[fe-sso-test] TODO: lint at T1"   └─ Done
fe-admin lint$ echo "[fe-admin] TODO: lint at A1"   └─ Done
EXIT=0
```

### Case 4 — `pnpm dev:all` (timeout 30s safety net)
```
$ pnpm -r --parallel run dev
Scope: 3 of 4 workspace projects
fe-admin dev: "[fe-admin] TODO: scaffold TanStack Start at A1"    Done
fe-sso-test dev: "[fe-sso-test] TODO: scaffold Vite + React + React Router at T1"    Done
be dev: "[be] TODO: scaffold NestJS + Fastify at B1.1"    Done
EXIT=0
```
→ 3 script `dev` fan-out song song, tất cả `Done`, tiến trình tự kết thúc (placeholder là `echo` process ngắn — KHÔNG treo).

### Case 5 — `.nvmrc` vs `.node-version`
```
.nvmrc        = v22.23.2
.node-version = v22.23.2
```
→ Khớp.

### Case 6 — `docker compose config`
```
config EXIT=0
```

### Case 8 — services mặc định vs `--profile full`
```
--- services (default) ---
mailpit
mongo
redis
EXIT=0
--- services (--profile full) ---
mongo
redis
be
mailpit
EXIT=0
```
→ Mặc định KHÔNG có `be`; chỉ `--profile full` mới thêm `be`. Đúng yêu cầu.

### Case 7 — `docker compose up -d` + `ps` (verified 2026-09-28)
Lần đầu (Docker daemon off) → PENDING. **Verify lại khi Docker chạy:**
```
$ docker compose up -d   → EXIT=0
$ docker compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
SERVICE   STATUS                    PORTS
mailpit   Up 20 seconds (healthy)   0.0.0.0:1025->1025, 0.0.0.0:8025->8025
mongo     Up 20 seconds (healthy)   0.0.0.0:27017->27017
redis     Up 21 seconds (healthy)   0.0.0.0:6379->6379
```
⇒ **PASS** — cả 3 service `healthy` (mailpit image có sẵn healthcheck).

## Test FAIL (nếu có)
- Không có.

## Coverage acceptance criteria
- [x] AC-R1.1 `pnpm i` 3 package → case 1
- [x] AC-R1.2 typecheck EXIT 0 → case 2
- [x] AC-R1.3 lint EXIT 0 → case 3
- [x] AC-R1.4 dev:all fan-out 3 app → case 4
- [x] AC-R1.5 `.nvmrc` == `.node-version` → case 5
- [x] AC-R2.6 compose config valid → case 6
- [x] AC-R2.7 mongo/redis healthy → case 7 **(verified 2026-09-28)**
- [x] AC-R2.8 `be` không chạy mặc định → case 8

## Ghi chú
- Case 7 đã verify thật khi Docker chạy: mongo/redis/mailpit đều `healthy`.
- `mailpit` thực tế BÁO `healthy` (image `axllent/mailpit` có healthcheck sẵn) → nit của senior không còn áp dụng.
