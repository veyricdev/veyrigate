# Log — Run 09 — B3.1–B3.4

## [2026-10-06 08:30] orchestrator
- Đã làm: mở run 09, sinh tasks.md từ plan §B3 (không gọi analyst vì đã có spec/plan).
- File đổi: runs/09-B3.1-B3.4/tasks.md, STATUS.md
- Kết quả: DONE — mở cổng tech-lead.
- Bàn giao: tech-lead — review plan B3.1–B3.4.

## [2026-10-06 08:40] tech-lead
- Đã làm: review plan B3.1–B3.4 so với spec §7/§9.3/§9.7/§15 và code hiện có (clients/resources schema, crypto.util,
  TenantScopedRepository, rate-limit, keys.controller).
- File đổi: runs/09-B3.1-B3.4/review-techlead.md
- Kết quả: PASS có điều kiện C1–C6 — khả thi, không over-engineering; cần sửa validator env-aware (C1), chốt grace
  TTL tạm (C2), mapping resourceId↔identifier đúng (C3), chống timing oracle client auth (C4), CORS theo đúng
  client/endpoint không global tĩnh (C5), dùng lại hashPassword cho secret (C6).
- Bàn giao: backend-dev — triển khai B3.1–B3.4 theo điều kiện C1–C6.
## [2026-10-06 10:30] backend-dev (hoàn tất sau khi agent bị huỷ — orchestrator tiếp)
- Đã làm: B3.1 Client/ClientCredential + redirect_uri validator (C1 env-aware); B3.2 Resource + resolveForClient (C3 identifier→resourceId); B3.3 client auth basic/post/none (C4 dummy-hash anti-enum, C6 Argon2id); B3.4 ClientCorsService (per-client + union allowlist, C5). C2 grace TTL=604800s (tạm, spec §17 mở).
- File đổi: be/src/modules/clients/* (client/credential/auth/cors service, redirect-uri validator+spec, schemas), be/src/modules/resources/* (resource service+validator+schema), clients/resources module, config (configuration/validation.schema+spec), .env.example, be/test/clients.int-spec.ts.
- Kết quả: DONE — typecheck OK, lint OK, 67 unit + 138 int PASS (205 total).
- Bàn giao: senior-reviewer — review B3.1–B3.4 so với C1–C6.

## [2026-10-06 11:10] senior-reviewer
- Đã làm: đọc toàn bộ diff (clients/resources service+validator+schema, config, .env.example, int-spec), đối chiếu C1–C6 với
  code thật; chạy lại `pnpm typecheck`/`lint`/`test`/`test:int` (67 unit + 138 int PASS) để verify độc lập, không chỉ tin log dev.
- File đổi: runs/09-B3.1-B3.4/review-senior.md, backlog.md (DEBT-019/020/021).
- Kết quả: PASS — C1–C6 đều đạt, không có blocker. 3 🟡 (fastify/cors chưa wire, thiếu index allowedCorsOrigins, rotateSecret
  không atomic dưới concurrent) ghi vào backlog, không chặn. Ponytail: gộp dummy-hash vào DUMMY_HASH sẵn có, net -6 dòng.
- Bàn giao: tester — test B3.1–B3.4 theo tasks.md nghiệm thu.

## [2026-10-06 11:50] tester
- Đã làm: đối chiếu tasks.md/C1–C6/review-senior với code thật (client/credential/auth/cors/resource service+validator).
  Chạy lại độc lập `pnpm typecheck`, `pnpm test` (12/12 suites, 67/67 test), `pnpm test:int` (Mongo/Redis thật port
  27117/6479). Tìm 1 gap risk-matrix (State: concurrent rotation, liên quan DEBT-021) chưa có test thực chạy →
  bổ sung test concurrency vào `clients.int-spec.ts` (không sửa code sản phẩm).
- File đổi: be/test/clients.int-spec.ts (+1 test), runs/09-B3.1-B3.4/test-report.md.
- Kết quả: PASS — 206/206 test (67 unit + 139 int). Không có case nghiệm thu nào thiếu bằng chứng; DEBT-019/020/021
  xác nhận không phải security bypass.
- Bàn giao: orchestrator — đóng run 09.