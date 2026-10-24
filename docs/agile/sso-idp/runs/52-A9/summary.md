# Summary — run 52 A9 (M7, lane ADMIN) — ✅ PASS 3/3 task

- **Phạm vi**: T1 [FE] DEBT-370 giới hạn body ghi (400/411/413, 64 KiB, trước router), DEBT-374 cờ signing-out tự hết hạn 10 s, DEBT-368 catch trong `security-headers.ts`. T2 [FE/ops] `/healthz` (không chạm dependency), `serve.mjs` (API srvx, không CLI/không `.env`, chỉ `/assets/*` immutable + nosniff, self-check exit 1), `/assets/*` lọt vào app ⇒ 404 có header, `fe-admin/Dockerfile` multi-stage (base pin digest, `pnpm deploy --prod`, `USER 1000:1000`, HEALTHCHECK) + `Dockerfile.dockerignore` allowlist (DEBT-362/264). T3 `scripts/docker-smoke.sh` 13 check, CI job `fe-admin-image` (không push), runbook-deploy §7.
- **Verify**: fe-admin 1415/1415, be 416, fe-sso-test 269, E2E 35/35 (×1 dev, ×1 tester), smoke image 13/13 (×2), build stage không `.env`, audit high 0 (1 ignored); mutation RED (code + Docker); image/container tạm đã dọn đúng tên; grep secret 0.
- **Commit**: (điền sau).
- **Vòng lặp**: tech-lead=1, FE dev=1, senior=1 (PASS), tester=1 (PASS).
- **Debt**: đóng DEBT-264/362/368/370(phần body)/374; mở 375 (E2E trên build prod — cần TLS), 376 (CSRF sau proxy), 377, 378 (`/ready`), 379 (Node 22.23.3), 380, 381, 382, 383 (Redis quit), **384 🟡** (listen lỗi thoát 0), **385 🟡** (dockerignore rộng hơn), 386 (ponytail), **387 🟡** (`GET //a` ⇒ 308 theo Host).
- **Lane ADMIN**: A1–A9 xong trừ A6.3b (chờ DEBT-149/142). Tiếp: sweep 🟡 deploy (384/385/387/376) hoặc B7.3 (Dockerfile BE + Vault Transit + Redis Sentinel).
