# Senior Review — 2026-11-06

## Kết luận: PASS (BE: PASS, FE: PASS)

## Tổng quan (ấn tượng chung + điểm tốt)

Diff khớp § Fold tech-lead từng điểm, nhỏ, chỉ test-infra + test. `git diff --quiet HEAD -- be/src fe-admin/src` = sạch (production = HEAD). Điểm tốt:

- `be/scripts/sentinel-test-env.sh`: `ip()` định nghĩa MỘT lần, ngay sau `docker run … redis-a` và trước lần dùng đầu tiên (redis-b); `HOSTS` của sentinel dùng lại. `--add-host` chỉ thêm cho replica (không cho redis-a — đúng YAGNI của fold). Quoting giữ nguyên kiểu cũ (`"vg-b73c-redis-a:$(ip vg-b73c-redis-a)"`), `set -euo pipefail` vẫn ở đầu; nếu `docker inspect` lỗi thì chuỗi add-host thành `vg-b73c-redis-a:` ⇒ `docker run` lỗi ⇒ script dừng (fail closed, giống sentinel trước đây). Comment giải thích gốc (lookup đồng bộ của redis-server ⇒ `+sdown slave` ⇒ `no-good-slave`). `bash -n` OK. CI `ci.yml:153-161` gọi `up`/`test:sentinel`/`down` không đổi tham số ⇒ vẫn chạy đúng.
- Mọi chỗ bỏ `eyJ` đều GIỮ tên trường (`access_token|refresh_token|id_token|"kty"|hvs\.`) và thêm so token đã phát hành (4 dạng: thô, chữ ký, base64, base64url). Mọi đường ký trong `be/src` đi qua `KeyProvider.signJwt` (`token-signer.ts:44`), nên `recordIssued` bắt được mọi JWT thật ⇒ không yếu hơn `eyJ`, và hết đỏ giả với cursor.
- `recordIssued` gắn ngay sau `bootFullApp` (trước `seedFlowClient` / mọi request) ở b73c, redis-down, run54, run55, run56; ở `token-code-recheck` gắn trước cả `provider.init()` và `useValue`.
- DEBT-388 chống rỗng nghĩa: `expect(issued.length).toBeGreaterThan(n)` quanh cả 3 request bị từ chối/lỗi (`refused`, `failed`, `revokeFamily` throw). Tự chạy: `pnpm -C be test:int token-code-recheck` 52/52 xanh.
- `run55-tester.vault-spec.ts:279`: `/hvs\./` + hằng `JWT` 3 phần (`eyJ…\.…\.`) — cùng regex với các file khác, bắt mọi JWT thật, không khớp cursor (không có `.`).
- FE `log-canary`: `JWT_CANARY` + header/payload + `idp.issued.flatMap(leakForms)` (FE `leakForms` đủ 4 dạng, lọc phần rỗng); ca refresh có `idp.issued.length > 0`. Giữ `CANARY`, `"Bearer "`, `secrets`. Tự chạy: `pnpm -C fe-admin test log-canary` 4/4 xanh.

## 🔴 Blocker

Không có.

## Security invariants / trust boundaries đã kiểm

- Exposure (body/log/audit không lộ token): giữ hoặc mạnh hơn — thêm dạng chữ ký/base64/base64url của token thật; field-name regex giữ nguyên; chỗ không có token phát hành dùng hình dạng JWT 3 phần (BE vault audit) hoặc canary JWT (FE callback).
- Không còn `eyJ` trần trong assertion của `be/test`/`fe-admin/test` ngoài regex hình dạng 3 phần (giữ có chủ đích) và fixture/comment.
- Không chạm production, auth, authz, state — không có trust boundary production nào đổi.

## 🟡 Nên sửa

Không có.

## 💭 Nit

- `be/test/token-code-recheck.int-spec.ts:62` — `let issued` (state có thể đổi) chen giữa các hằng `TENANT`/`VERIFIER`; cân nhắc đặt cạnh `let` khác của `describe` hoặc sau khối hằng cho dễ đọc. Không ảnh hưởng hành vi.
- `b73c`/`redis-down`: `issued` gán lại trong mỗi `boot()`; hiện chỉ gọi một lần trong `beforeAll` nên không sao — nếu sau này boot lại app, token của app cũ sẽ rơi khỏi danh sách so.

## ✂️ Ponytail

`hasIssued` là 1 dòng do fold yêu cầu cho 2 hàm gom `problems` (không throw); `expectNoIssued` giữ vì cho thông báo lỗi `toContain` rõ hơn. Không có abstraction thừa.

Lean already. Ship.
