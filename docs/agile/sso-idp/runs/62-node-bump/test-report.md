# Test Report — 2026-11-03

## Kết quả: PASS (AC1–AC6; A/B/C 15/15 lượt be unit xanh + 3 warm-up; fe-admin 1533/1533)

Không đổi code sản phẩm, không viết test mới (run chỉ đổi pin Node). Việc của tester là kiểm lại AC độc lập và đo A/B flake be unit theo `review-senior.md`.

## Lệnh đã chạy + output thực tế

Chạy trong Git Bash tại `E:/projects/self/veyrigate`. Container và network do tester đặt tên `vg-n62t-*` và đã xoá theo đúng tên.

### Case 1: AC1/AC2/V4 (git)
- `git grep -nE "22\.23\.2|48e4b67d" -- ':!docs/agile/sso-idp/runs' ':!docs/agile/sso-idp/backlog.md'`:
  - Lúc tester bắt đầu có **1 dòng**: `docs/agile/sso-idp/STATUS.md:5`, là chữ "đo A/B … 22.23.2 vs 22.23.4" trong mô tả cổng tester, không phải pin.
  - Khi tester ghi đè `STATUS.md` (bỏ chuỗi này), chạy lại ra **0 dòng** (xem case 8).
- `git grep -n "22.23.4"` (cùng loại trừ) cho đúng 6 chỗ pin: `.node-version:1`, `.nvmrc:1`, `README.md:30`, `be/Dockerfile:9`, `fe-admin/Dockerfile:7`, `package.json:7`. Ngoài ra chỉ có `STATUS.md` (docs).
- `git diff --stat`: 6 file pin, `docs/agile/sso-idp/{STATUS,backlog}.md` và `.vscode/mcp.json`. File cuối là thay đổi của người dùng, đã có trước run và không thuộc diff của run. Không có `pnpm-lock.yaml` hay `.github/**`.
- `git status --short`: không có `be/keys`, `be/.env`, `.github/`, `pnpm-lock.yaml`. Ngoài diff trên chỉ có `?? .mcp.json` (của người dùng) và `?? docs/agile/sso-idp/runs/62-node-bump/`.

### Case 2: AC3 (3 image có sẵn, không build lại)
```
for i in veyrigate-be:smoke-run62 veyrigate-be:smoke-run62-build veyrigate-fe-admin:smoke-run62; do docker run --rm --name vg-n62t-ver --entrypoint node "$i" -p 'process.version+" "+process.versions.openssl'; done
veyrigate-be:smoke-run62: v22.23.4 3.5.9
veyrigate-be:smoke-run62-build: v22.23.4 3.5.9
veyrigate-fe-admin:smoke-run62: v22.23.4 3.5.9
```

### Case 3: AC4 smoke (chạy 1 lần mỗi image)
- `bash be/scripts/docker-smoke.sh veyrigate-be:smoke-run62 veyrigate-be:smoke-run62-build`:
  - Exit 0, check 1–11 đều `ok`.
  - Output: `docker-smoke: 11/11 passed for veyrigate-be:smoke-run62`.
  - Check 10 không bị SIGPIPE, không cần chạy lại.
- `bash fe-admin/scripts/docker-smoke.sh veyrigate-fe-admin:smoke-run62`:
  - Exit 0, check 1–14 cùng 9b và 9c đều `ok`.
  - Output: `docker-smoke: 16/16 passed for veyrigate-fe-admin:smoke-run62`. Script hiện có 16 check; AC4 cho phép số khác 14.

### Case 4: harness A/B/C
- Harness là V3 đã sửa:
  - Repo mount `:ro`, tar sang `/w`, bỏ `node_modules`, `./.git`, `.env*` và `./be/keys`.
  - Copy lại 4 file `.env.example` tracked.
  - Assert `test ! -e /w/be/keys`, `/w/be/.env` và `/w/fe-admin/.env`.
  - Redis riêng `vg-n62t-redis` (`redis:7`, image có sẵn) chạy trên network `vg-n62t-net`, truyền `TEST_REDIS_URL=redis://vg-n62t-redis:6379`.
- Mỗi ô dùng 1 container và `pnpm install --frozen-lockfile` 1 lần. Sau đó chạy 1 lượt warm-up (không tính), rồi 5 lượt `pnpm -C be test --verbose [args]`.
- Mỗi lượt ghi `Tests:`, các dòng `✕` và dòng V10 `signJwt rejects within 2 × VAULT_TIMEOUT_MS + 500 ms`. Ngưỡng của V10 là 1100 ms.
- Script: `C:\Users\ADMIN\AppData\Local\Temp\claude\E--projects-self-veyrigate\f63d5d99-f16b-41dc-b700-1cd41f25d16e\scratchpad\cell.sh`. Log từng lượt: `…\scratchpad\out\{A,B,C,FE}\`.
- Image của các ô:
  - A = `node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`. Image này **không còn trên máy**: `docker image inspect` báo "No such image", và `docker images` chỉ có node `4b150b48…` cùng `20-alpine`. Tester đã `docker pull` đúng digest pin này, là 1 trong 2 digest được phép.
  - B = `node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`, có sẵn.
  - C = image của B, chạy với `--maxWorkers=50%`.

### Case 5: bảng A/B/C (be unit, 5 lượt mỗi ô, sau warm-up)

| Ô | Node / OpenSSL | nproc | Warm-up | Lượt đỏ / 5 | Test đỏ | V10 (ms), lượt 1–5 | V10 max (dư so với 1100) | Wall mỗi lượt |
|---|---|---|---|---|---|---|---|---|
| A | v22.23.2 / 3.5.7 | 28 | 630/630 | **0/5** (630/630 × 5) | — | 636, 751, 710, 669, 708 | 751 (349) | 31–34 s |
| B | v22.23.4 / 3.5.9 | 28 | 630/630 | **0/5** (630/630 × 5) | — | 660, 796, 657, 932, 716 | 932 (168) | 33–37 s |
| C | B + `--maxWorkers=50%` | 28 | 630/630 | **0/5** (630/630 × 5) | — | 673, 655, 660, 726, 689 | 726 (374) | 20–23 s |

- Tính cả warm-up, có 18 lượt be unit trong container và không lượt nào đỏ. Không lặp lại được 5 timeout keygen hay V10 1173 ms mà backend-dev gặp.
- Lần đỏ của backend-dev có cache ts-jest lạnh, harness thiếu Redis và `.env.example`, và bước `pnpm install` chạy cùng container.
- Median V10: A 708 ms, B 716 ms, C 673 ms.
- B có một lượt V10 = 932 ms, cao nhất trong 15 lượt, chỉ còn dư 168 ms. Ngưỡng 500 ms slack cố định là mỏng dưới tải 27 worker, nên DEBT-467 vẫn có giá trị.

### Case 6: microbench RSA-2048 keygen (lệnh của senior, 20 mẫu, đơn vị ms)

| Nguồn | A (22.23.2) p50 / p95 | B (22.23.4) p50 / p95 |
|---|---|---|
| Trong ô (trước `pnpm install`) | 65 / 142 | 84 / 158 (ô B); 87 / 189 (ô C); 65 / 120 (ô FE) |
| Lặp 5 cặp xen kẽ A,B (container `vg-n62t-kg`) | 63/131, 69/153, 62/139, 71/147, 71/179 ⇒ median p50 **69** | 68/162, 56/123, 48/126, 88/166, 76/170 ⇒ median p50 **68** |
| N=200 mẫu, 2 cặp xen kẽ | p50 64 / p95 187 / mean 77; p50 63 / p95 153 / mean 73 | p50 66 / p95 178 / mean 78; p50 67 / p95 179 / mean 75 |

- Ở mẫu đầu tiên trong ô, B chậm hơn A 29% (84 so với 65 ms), vượt ngưỡng 20%.
- Đo lặp cho thấy đó là nhiễu. Chỉ riêng B, p50 của mỗi lượt 20 mẫu đã dao động 48–88 ms (±30%), vì keygen tìm số nguyên tố ngẫu nhiên.
- Với số mẫu đủ lớn, chênh lệch nhỏ: median của 5 cặp là −1% (69 → 68 ms). Với N=200, p50 chênh +3% (64 → 66) và +6% (63 → 67), mean chênh +1% và +3%.

### Case 7: fe-admin unit trên B (Redis riêng `vg-n62t-redis`)
```
node v22.23.4 / OpenSSL 3.5.9 / nproc 28
pnpm -C fe-admin test → exit 0
Test Files 66 passed (66)
Tests 1533 passed (1533)
```

### Case 8: AC6 dọn dẹp
- `docker rm -f vg-n62t-redis` và `docker network rm vg-n62t-net` chạy theo đúng tên. Các container `vg-n62t-a/b/c/fe/kg/ver` đều chạy với `--rm`. Script smoke tự dọn bằng trap.
- Sau khi dọn, `docker ps -a` không còn tên nào chứa `n62`, `smoke`, `b73b` hay `fea`. Network chỉ còn `bridge`, `host`, `none`, `veyrigate_default`, `workspacetools_default`.
- Không đụng `vg-test-*`, `aegate-*` hay `veyrigate-*` của người dùng.
- Image: giữ 3 image `*:smoke-run62*`. Image `node:22.23.2-bookworm-slim@48e4b67d…` vừa pull vẫn ở lại máy, tester không xoá. Người dùng quyết định có xoá hay không.
- `git status`: không có `be/keys` hay `be/.env`.
- AC1 chạy lại sau khi ghi đè `STATUS.md`: grep `22\.23\.2|48e4b67d` (bỏ runs/backlog) ra 0 dòng.

## Quyết định (áp quy tắc trong `review-senior.md`)
- **Lượt đỏ:** A 0/5 và B 0/5, chênh 0, nằm trong ngưỡng ≤ 1/5.
- **Keygen p50:** dùng mẫu gộp ⇒ chênh < 20% (−1% đến +6%).
  - Một mẫu 20 lần đơn lẻ (+29%) không đủ lực thống kê, vì B tự dao động ±30% giữa các lượt.
  - Nếu áp chữ nguyên văn lên mẫu đầu tiên thì sẽ ra nhánh 2, nhưng hai lần đo lặp bác bỏ kết quả đó. Nhánh 2 cũng đòi B đỏ ≥ 2/5, trong khi B đỏ 0/5.
- **Kết luận: nhánh 1.** Flake là do tải hoặc môi trường có sẵn, không phải regression của 22.23.4.
  - **AC5 PASS.**
  - DEBT-467 giữ 💭, cập nhật bằng số đo ở trên.
- **Nhánh 3** (C xanh khi B đỏ) không áp dụng được vì B không đỏ. Contention chưa được xác nhận, cũng chưa bị loại trừ. Riêng C nhanh hơn rõ: 20–23 s so với 33–37 s.

## Test FAIL
Không có.

## Coverage acceptance criteria
- [x] AC1: case 1 và case 8. Grep cũ ra 0 dòng sau khi `STATUS.md` được ghi đè; lúc đầu có 1 dòng docs, không phải pin. `22.23.4` đúng 6 chỗ.
- [x] AC2: case 1. Diff gồm 6 file và docs; `.vscode/mcp.json` là của người dùng, có trước run. Lockfile và `.github` không đổi.
- [x] AC3: case 2. 3 image đều chạy v22.23.4, OpenSSL 3.5.9.
- [x] AC4: case 3. BE 11/11, fe-admin 16/16, không có fail.
- [x] AC5: case 5, 6, 7. be 630/630 × 18 lượt trên cả 22.23.2 và 22.23.4; fe-admin 1533/1533. Số test bằng run 61.
- [x] AC6: case 8.

## Coverage security invariants / risk matrix
Run không chạm trust boundary trong code. Chỉ kiểm các chiều có liên quan.
- [x] Supply chain: AC3 xác nhận image chạy đúng runtime theo digest index. Image A được pull theo digest, không theo tag.
- [x] Exposure (secret vào container): case 4 assert `be/keys`, `be/.env` và `fe-admin/.env` không có trong `/w`. Repo mount `:ro`. Smoke check 6 (BE) và 13 (fe-admin) xác nhận image không chứa `.env` hay khoá.
- [x] Dependency (TLS chặt hơn trong 22.23.4): smoke BE check 4–5 gọi Vault dev-tls qua hostname, kết quả ok.
- [x] Dependency down: smoke BE check 7–8, Redis down ⇒ `/ready` 503 và stop sạch (fail-closed).
