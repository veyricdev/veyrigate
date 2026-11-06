# Tech Lead Review — 2026-11-06

## Kết luận: PASS

Run không qua analyst; nguồn task = `tasks.md` + `plan.md` §12 "Chốt bổ sung 2026-11-06". PASS **kèm fold bắt buộc** (`tasks.md` § Fold tech-lead: số đo A, điểm sửa B, cách chứng minh C). Chuyển **backend-dev** (lane ops: compose, Dockerfile, `.github/dependabot.yml`, runbook).

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi topology. Hai điều chỉnh nhỏ do đo được:
- `prod.example.yml` đã chạy được non-root như đang viết ⇒ Task 1 chỉ còn tài liệu + xoá `SKIP_SETCAP`/`SKIP_CHOWN` (vô dụng khi non-root).
- Dependabot không đọc `ARG` trong `FROM` (dependabot-core#2057) ⇒ Task 2 phải đổi 2 Dockerfile sang `FROM` literal (cùng digest), nếu không DEBT-466 không đạt cho image.

## Điểm mạnh

- Smoke thật bằng `docker run` cùng cờ (không `compose up`): 6 container redis + vault-agent đều uid ≠ 0, `CapEff 0`, `NoNewPrivs 1`; replication 2/2, Sentinel quorum 3/2, failover 6 s, master cũ quay lại làm replica; vault-agent ghi sink 0440 100:1000, app uid 1000 đọc được, uid khác bị từ chối; Vault không tới được ⇒ không token ⇒ `be` không khởi động (fail-closed).
- Thiết kế compose sẵn đúng least privilege: `internal` network, secret qua file (không trên command line), token sink tmpfs `:ro` cho app.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không REJECT. Các điểm bắt buộc trong run (đã ghi trong fold):
- [ ] Dockerfile `FROM` literal (be, fe-admin) + comment/runbook §7/§9 khớp.
- [ ] Runbook/compose ghi lệnh quyền file host cụ thể (`999:999 0400` redis/sentinel; `100:1000 0400` approle) — Docker Desktop không đo được quyền này.
- [ ] Ghi rõ giới hạn "security không chờ": docker không có security update; npm không có alert/security update vì lockfile pnpm 12 hai document ⇒ chặn bằng CI `pnpm audit` fail-closed + ngoại lệ tay. Không được viết là Dependabot lo security cho npm/docker.
- [ ] Đóng DEBT-405, DEBT-466 trong `backlog.md` với số đo thật.

Cổng security design: trust boundary = secret files host → container (uid cụ thể), token sink vault-agent → app (gid 1000, ro); abuse case đã đo: uid lạ đọc token bị từ chối, app ghi sink bị từ chối; failure semantics: Vault down ⇒ fail-closed, master down ⇒ failover, ex-master không nhận ghi (`NOREPLICAS`). Dependabot: không secret, không quyền ghi mới ngoài PR của GitHub.

## Đề xuất (không bắt buộc)

- DEBT-500: npm security blind spot do pnpm 12 lockfile 2 document.
- DEBT-501: digest không thuộc Dependabot (`prod.example.yml` redis/vault, `ci.yml` vault, `be/scripts/docker-smoke.sh`, image `redis:7`/`mongo:7` trôi tag trong CI).
- DEBT-502: CI guard version Node Dockerfile == `.nvmrc`/`.node-version`/`engines` để PR Dependabot không lệch.
