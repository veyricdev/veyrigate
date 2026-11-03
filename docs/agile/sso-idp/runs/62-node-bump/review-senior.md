# Senior Review — 2026-11-03

## Kết luận: PASS (có điều kiện: tester phải đo A/B flake be unit trước khi đóng run, xem "Kế hoạch đo cho tester")

## Tổng quan

Diff đúng phạm vi và tối thiểu: 6 dòng pin (`.nvmrc`, `.node-version`, `package.json` engines, `README.md:30`, `be/Dockerfile:9`, `fe-admin/Dockerfile:7`) cộng docs. Không chạm trust boundary nào trong code; rủi ro thực của run nằm ở hành vi runtime mới (undici, OpenSSL 3.5.9, ESM loader), và câu hỏi duy nhất còn mở là flake timing của be unit trong container 22.23.4.

Đã tự kiểm (chỉ đọc):
- `docker buildx imagetools inspect node:22.23.4-bookworm-slim`: `MediaType: application/vnd.oci.image.index.v1+json`, `Digest: sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`. Đây là digest **index** (manifest amd64 là `sha256:9f0dde62…`), khớp cả hai Dockerfile.
- AC1: `git grep -nE "22\.23\.2|48e4b67d"` (bỏ runs/backlog) = 0 dòng; `22.23.4` đúng 6 chỗ.
- AC2/V4: `git status` không có `pnpm-lock.yaml`, `.github/**`, `be/keys`, `be/.env`. Ngoài 6 file + docs chỉ có `.vscode/mcp.json`, `.mcp.json` (của người dùng, bỏ qua theo yêu cầu).
- Comment trong Dockerfile ("pinned by index digest … same version as .nvmrc / engines") vẫn đúng sau bump.

## 🔴 Blocker

Không có.

## Câu hỏi chính: flake be unit có phải regression của Node 22.23.4 không?

**Đọc test:**
- `be/src/modules/keys/vault-transit-key-provider.spec.ts:733` (V10): assert wall-clock `Date.now() - started <= 2 * 300 + 500` = 1100 ms. Chỉ có 500 ms slack cố định cho 2 lần abort + scheduling. Container đo 1173 ms (vượt 73 ms); assert hành vi (`KeyProviderUnavailableError`, cause `TimeoutError|AbortError`) không được báo là sai.
- `keys.spec.ts` / `vault-transit-key-provider.spec.ts`: dùng `generateKeyPairSync('rsa', { modulusLength: 2048 })` (sync, CPU-bound, thời gian ngẫu nhiên theo việc tìm số nguyên tố) trong hook và test, với timeout mặc định jest 5000 ms. Dưới 27 worker cạnh tranh CPU, keygen sync chặn event loop là ứng viên rõ nhất cho 5 test timeout ở lần 1.

**Lịch sử:** `git log --all --grep "flak|maxWorkers|V10"` và `backlog.md` không có flake nào trước đây của 2 file này. Run 61 báo be 630 xanh trên host.

**Đo trên host (Node v22.22.3, 28 CPU, jest mặc định 27 worker), 2026-11-03:**

| Lệnh | Kết quả |
|---|---|
| `pnpm -C be test --testPathPatterns "keys.spec\|vault-transit-key-provider.spec"` × 3 | 128/128 × 3 (67 s cache lạnh, 16.9 s, 16.8 s) |
| `pnpm -C be test` (full) × 2 | 630/630 × 2 (59 s, 35 s) |
| `pnpm -C be test --verbose` (full) × 1 | 630/630; V10 = **658 ms** (dư 442 ms so với 1100); test chậm nhất trong keys.spec 176 ms |

**Nhận định:**
- Bằng chứng nghiêng về **flake do tải/môi trường**, không phải regression: (a) chỉ assert wall-clock/timeout đỏ, assert hành vi đều đúng; (b) mỗi lần đỏ một test khác nhau; (c) lần 1 trong container chạy cache ts-jest lạnh, trong VM Docker Desktop, cùng lúc thiếu Redis/`.env.example` (harness lỗi, DEBT-468) ⇒ không phải môi trường sạch; (d) release notes 22.23.3/22.23.4 không đổi V8, chỉ vá OpenSSL patch 3.5.x, undici, ESM loader `fs` patch.
- Nhưng **chưa chứng minh**: so sánh hiện tại là host 22.22.3 với container 22.23.4, lệch cả Node lẫn môi trường (VM, cache lạnh, filesystem overlay). Không loại được việc RSA keygen hoặc khởi động vm-modules chậm hơn trên 22.23.4. Cần A/B **cùng harness, chỉ đổi Node**.
- Vì sao không REJECT: không có invariant bảo mật/dữ liệu nào phụ thuộc vào kết quả này; code sản phẩm không đổi; CI (`node-version-file: .nvmrc`) sẽ chạy 22.23.4 với ít worker hơn. Nhưng AC5 hiện mới "xanh 1/3", nên run chỉ được đóng khi tester có số đo A/B dưới đây.

## Kế hoạch đo cho tester (đóng câu hỏi flake)

Dùng đúng harness V3 đã sửa của backend-dev (copy lại `.env.example` tracked, Redis riêng `vg-n62-redis` trên `vg-n62-net`, `TEST_REDIS_URL`), chỉ chạy **be unit**, dọn theo tên như tasks.md.

1. **Một container, cài một lần, chạy nhiều lần** (loại nhiễu cache lạnh/`pnpm install`): trong `bash -ec`, sau `pnpm install --frozen-lockfile`, chạy 1 lượt warm-up (không tính), rồi `for i in 1 2 3 4 5; do pnpm -C be test --verbose > /tmp/be-$i.log 2>&1 || true; grep -E "^Tests:|✕|signJwt rejects within" /tmp/be-$i.log; done`.
2. **Ma trận A/B** (mỗi ô 5 lượt):
   - A: `node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9` (image đã có trên máy, không pull mới), worker mặc định.
   - B: `node:22.23.4-bookworm-slim@sha256:4b150b48…`, worker mặc định.
   - C: B với `pnpm -C be test --maxWorkers=50%`.
   Ghi: số lượt đỏ / 5, tên test đỏ, thời gian V10 (ms) mỗi lượt, `nproc` trong container.
3. **Microbench keygen** trong A và B (1 lệnh, không test): `node -e 'const {generateKeyPairSync}=require("crypto");const t=[];for(let i=0;i<20;i++){const s=performance.now();generateKeyPairSync("rsa",{modulusLength:2048});t.push(performance.now()-s)}t.sort((a,b)=>a-b);console.log(process.version,"p50",t[10].toFixed(0),"p95",t[18].toFixed(0))'`.
4. **Quyết định:**
   - A và B đỏ tương đương (chênh ≤ 1/5) và keygen p50 chênh < 20% ⇒ flake tải có sẵn ⇒ AC5 PASS, DEBT-467 giữ 💭 (sửa ngưỡng/maxWorkers sau). Cập nhật DEBT-467 + DEBT-379 bằng số đo.
   - A xanh 5/5 mà B đỏ ≥ 2/5, hoặc keygen B chậm hơn A > 20% ⇒ regression nghi do 22.23.4 ⇒ trả về backend-dev/tech-lead (cân nhắc ở lại 22.23.2 hay chấp nhận + sửa ngưỡng có lý do).
   - C xanh 5/5 trong khi B đỏ ⇒ xác nhận nguyên nhân là contention; ghi vào DEBT-467 làm cách sửa ưu tiên.

## Security invariants / trust boundaries đã kiểm

- Supply chain base image: pin theo index digest (multi-arch, bất biến), không dùng tag trôi; digest tự inspect lại khớp. Bookworm (glibc) giữ nguyên cho `@node-rs/argon2` gnu.
- Phạm vi: lockfile và workflow không đổi ⇒ không có dependency mới lọt vào; CI theo `.nvmrc`.
- Harness V3: repo mount read-only, loại `.env*`/`be/keys` khỏi container (không mang secret vào image tạm); backend-dev chỉ copy lại `.env.example` tracked — chấp nhận được.
- TLS chặt hơn (IP không chuẩn tắc, IPv6 SAN) đã được smoke BE (Vault dev-tls qua hostname) bao, 11/11.
- Code sản phẩm không đổi ⇒ authn/authz/state/exposure không bị chạm.

## 🟡 Nên sửa

- `backlog.md` dòng đóng DEBT-379 ghi "unit trong container 22.23.4: be 630/630" mà không nói đó là 1/3 lượt. Vì sao: người đọc sau sẽ tưởng AC5 sạch. Đề xuất: thêm "(1/3 lượt, 2 lượt đỏ timing ⇒ DEBT-467)" — tester sửa khi ghi số đo A/B. → DEBT-469.
- `backlog.md` DEBT-467 khẳng định "Không phải lỗi Node" trước khi có A/B. Vì sao: đó là giả thuyết, chưa đo cùng harness. Đề xuất: đổi thành "nghi do tải, chờ A/B run 62 tester" rồi cập nhật bằng số đo. → DEBT-469.

## 💭 Nit

- DEBT-468: thay vì `--exclude=".env*"` rồi copy lại, cân nhắc chỉ copy file tracked + untracked không bị ignore: `git ls-files -co --exclude-standard -z | tar --null -T - -cf -` (cần git trong container hoặc tạo danh sách trên host). Vì sao: một quy tắc thay cho hai (secret bị ignore tự rơi, `.env.example` tracked tự có), không phải nhớ danh sách exclude.
- DEBT-467: khi sửa V10, cân nhắc giữ assert hành vi và nới slack theo tỉ lệ (vd. `2 * timeoutMs + 1000`) hoặc dùng fake timer cho phần abort, thay vì nâng `--maxWorkers` cho cả suite.
- Ngoài phạm vi (có sẵn trước run): `be/jest.config.js` khai báo `collectCoverageFrom` hai lần (key trùng, dòng sau đè dòng trước, vô hại). Xoá một dòng khi chạm file.
- DEBT-465/466: hợp lý, đúng là quyết định của người dùng (cài Node host; cấu hình thường trực GitHub).

## ✂️ Ponytail

Diff là 6 dòng thay giá trị pin, không thêm code/abstraction.
Lean already. Ship.
