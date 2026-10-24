# Tasks — run 53c — B7.3 phần 3: Redis Sentinel + Redis-down 503 (M7, lane BE) + DEBT-394/395/397

> Kế hoạch đã được tech-lead fold ở run 53: `runs/53-B7.3/tasks.md` mục **"Kế hoạch 53c — Redis Sentinel + Redis-down"** — ĐỌC NGUYÊN VĂN, là ràng buộc của run này. Nghiệm thu plan B7.3: "kill Redis → endpoint cần state trả lỗi rõ, không im lặng sai". Gộp: DEBT-394 (Vault down ⇒ 401/`active:false` thay vì 5xx — chọn tín hiệu đúng nhưng vẫn fail-closed, giữ ma trận introspect #28), DEBT-395 (`signJwt` lỗi ⇒ `refresh(false)` single-flight + test đếm), DEBT-397 (`redis.quit()` treo khi Redis down ⇒ shutdown có timeout/`disconnect()`, `docker stop` ⇒ 0; smoke BE bỏ bước bật lại Redis trước check 8). Image Redis cho test Sentinel: bản ≥14 ngày ghim digest (run 53b dùng `redis:7.4.10-bookworm@sha256:e9b2e45e…4f73` vì 7.4.11 bị re-push).
>
> Hạ tầng: container tạm `vg-b73c-*` (mạng `vg-b73c-net`, cổng theo kế hoạch), dọn đúng tên; CẤM prune/wildcard/compose/push; không đụng `aegate-*`/`vg-test-*`/`funny_pascal`. `ops/compose/prod.example.yml` chỉ là file mẫu, KHÔNG chạy.

### [x] Task 1 [BE]: env/client Sentinel (`buildRedisOptions`), WARN standalone ở prod; Cluster N/A (DEBT-013/073).
### [x] Task 2 [BE]: `isRedisUnavailable` từ bảng lỗi quan sát thật ⇒ 503 `temporarily_unavailable` + `Retry-After: 5` + `no-store` ở OAuth/HTML filter và `token.controller`; test kill qua TCP proxy theo kế hoạch; DEBT-394 cùng cơ chế cho Vault.
### [x] Task 3 [BE]: DEBT-395, DEBT-397 (+ cập nhật smoke BE).
### [x] Task 4 [BE/ops]: `test:sentinel` (opt-in, fail khi thiếu hạ tầng), `ops/compose/prod.example.yml`, runbook-deploy/ops.
