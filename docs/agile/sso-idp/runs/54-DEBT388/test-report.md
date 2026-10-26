# Test Report — 2026-10-26 (run 54: DEBT-388 / DEBT-401 / DEBT-398)

## Kết quả: PASS

- be unit 558/558, int **1267/1267** (49 suites; 1256 của dev + 11 test tester mới), vault **26/26** (4 suites; 23 + 3 tester mới), smoke BE 11/11, fe-admin 14/14, root `pnpm test` 2/2 lần xanh, E2E 35/35.
- Test tester mới: `be/test/run54-tester.int-spec.ts` (T1–T11), `be/test/run54-tester.vault-spec.ts` (V1–V3).
- Mutation trên test tester: MT1 và MT2 đều RED, sau đó khôi phục byte-identical (sha256 khớp).
- Không sửa code sản phẩm/config. Debt mới: DEBT-412 (độ ổn định hạ tầng test).

Preflight: `codegraph --version` 1.6.2, `status` up to date, `sync` Done. Diff chưa commit so với `9c02a11`.

## Lệnh đã chạy + output thực tế

Tất cả lệnh chạy foreground trong Git Bash, thư mục `E:\projects\self\veyrigate`. Riêng case 3 bị tool đẩy sang nền vì quá 600 s; tôi chờ notification rồi đọc output.

1. `pnpm -C be test:int -- --testPathPatterns "run54-tester|debt388"`: `Test Suites: 2 passed`, `Tests: 22 passed` (dev 11 + tester 11). Dòng ghi nhận của T8: `[run54-T8] ok=0 reuse=5 live=0 docs=2`.
2. Mutation trên test tester. Backup sha256 trước khi sửa: `token.controller.ts` 6018315686b2…fd05, `refresh-token.service.ts` 29f5d83eb4d2…97d0.
   - **MT1**: `consume(...) ?? p`, tức thua race hoặc code hết hạn vẫn đi tiếp bằng dữ liệu đã peek. Kết quả `3 failed, 8 passed`: **T1, T2, T3 RED**.
   - **MT2**: code grant ký SAU `consume`, refresh ký SAU `rotate` (thứ tự cũ). Kết quả `9 failed, 2 passed`: **T6 và T7 RED** (lỗi ký ID token sau khi đã ký AT làm đốt code/RT); T1–T3, T8–T11 RED vì barrier không còn đứng trước commit; T4 và T5 xanh (đúng, vì không phụ thuộc thứ tự).
   - Khôi phục từ backup: `sha256sum -c` cho cả 2 file **OK**.
3. `pnpm -C be test:int` (full; lock `vg:int-lock` lấy rồi nhả, sau đó `EXISTS=0`): `Test Suites: 49 passed, 49 total`, `Tests: 1267 passed, 1267 total`.
4. `pnpm -C be test:vault` với Vault tạm `vg-b73-vault`@127.0.0.1:18200, image `hashicorp/vault:2.1.2@sha256:c2f666…bb55`. Root token sinh bằng `openssl rand` và chỉ truyền qua env, không ghi file, không in ra.
   - **Lần 1**: `Tests: 5 failed, 21 passed, 26 total`. Năm test fail là `b73-tester` T1–T5, cùng lỗi timeout 60 s ở `bootFullApp`; V14 cũng mất 48,6 s. Lần này cache transform của ts-jest đang lạnh vì vừa chạy mutation sửa/khôi phục `token.controller.ts`/`refresh-token.service.ts`.
   - Chạy riêng `--testPathPatterns b73-tester`: 8/8 (T1 2,6 s … T5 2,5 s).
   - **Lần 2, full**: `Test Suites: 4 passed`, `Tests: 26 passed, 26 total`. Mở DEBT-412.
   - Dọn: `docker rm -f vg-b73-vault`.
5. `pnpm -C be typecheck` OK; `pnpm -C be lint` OK (không lỗi); `pnpm -C be build` exit 0; `pnpm -C be test`: `Test Suites: 37 passed`, `Tests: 558 passed`.
6. Image và smoke:
   - `docker build -f be/Dockerfile --target build -t veyrigate-be:smoke-run54t-build .` rồi `docker build -f be/Dockerfile -t veyrigate-be:smoke-run54t .`: cả hai exit 0. Context thật có `be/.env` và `be/keys` trên máy, ignore đã loại chúng nên guard không báo; đây là đối chứng không false positive.
   - `bash be/scripts/docker-smoke.sh veyrigate-be:smoke-run54t veyrigate-be:smoke-run54t-build`: `docker-smoke: 11/11 passed`.
   - `docker build -f fe-admin/Dockerfile -t veyrigate-fe-admin:smoke-run54t .` rồi smoke: `docker-smoke: 14/14 passed`.
7. Canary Docker độc lập (DEBT-398). Context tạm dựng trong scratchpad từ `git ls-files` của working tree (Dockerfile có guard), bỏ `.env.example`, ignore bản sao bị bỏ đúng dòng tương ứng. Cả 3 lần: lỗi ở bước `[build 2/10]`, chỉ in tên file, không in nội dung, không tạo image.
   - `be/src/.env.local` (bỏ `**/.env*`): exit 1, in `./be/src/.env.local`.
   - `be/test-canary.pem` (bỏ thêm `**/*.pem`): exit 1, in `./be/test-canary.pem`.
   - `fe-admin/src/.npmrc` (bỏ `**/.npmrc`): exit 1, in `./fe-admin/src/.npmrc`.
8. Root:
   - `pnpm lint`: exit 0 (be/fe-admin/fe-sso-test Done).
   - `pnpm -r run typecheck`: exit 0 (be/fe-admin/e2e Done).
   - `pnpm test` lần 1: exit 0. be `Tests: 558 passed`, fe-admin `Test Files 64 passed`, `Tests 1416 passed`, fe-sso-test `Test Files 31 passed`, `Tests 269 passed`.
   - `pnpm test` lần 2: exit 0, số liệu giống hệt lần 1. **Không tái hiện DEBT-400** (không có tên test fail để ghi).
9. `pnpm audit --audit-level high`: exit 0, `13 vulnerabilities found`, `6 low | 7 moderate`, `1 ignored: 1 high` (đã ignore sẵn).
10. E2E full 1 lần (trước khi chạy: :4000/:5173/:3000 trống, `E2E_REUSE` không đặt): `pnpm -C e2e e2e` exit 0, `35 passed (4.2m)`. Sau khi chạy, cả 3 cổng trống lại.

## Test FAIL (nếu có)

Không có test FAIL ở trạng thái cuối.

Lần 1 của `test:vault` có 5 test timeout. Nguyên nhân là hạ tầng (cache ts-jest lạnh, boot app > 60 s). Không phải hành vi sản phẩm: chạy lại riêng 8/8, chạy lại full 26/26. Ghi vào DEBT-412.

## Coverage acceptance criteria

- [x] **Task 1, DEBT-388**: ký lỗi thì code/RT còn nguyên và retry thành công, 0 `TOKEN_REUSE_DETECTED`.
  - Dev: C1, R1.
  - Tester: T6 (ID token lỗi sau khi đã ký AT, code grant, 3 lần lỗi rồi 200, 1 family, 1 audit success); T7 (tương tự cho refresh, 2 lần 503, RT không có stamp, rồi 200, reuse 0).
  - Vault thật: `b73-tester` T5 và `run54-tester` V1 (mỗi lần lỗi 400/403/429/502/503/network, ngay sau đó cùng code và cùng RT đều 200, reuse 0).
- [x] **Task 1, race**:
  - Code: T2 (8 request song song, giữ cả 8 sau khi ký rồi thả cùng lúc: đúng 1×200, 7×`invalid_grant`, 1 family, 1 audit success). T3 (6 request, thả lần lượt theo thứ tự ngược: `[200,400,400,400,400,400]`).
  - RT: T8 (6 request thả cùng lúc: ≤ 1×200, thực tế 0; bên thua không token; ≤ 1 doc sống, thực tế 0; đúng 1 doc con). T9 (A thả trước 200, 5 request còn lại `invalid_grant`, reuse được phát hiện, family chết, RT1 cũng chết).
- [x] **Task 1, reuse thật sau rotate vẫn revoke family**: R2 của dev, T9 của tester.
- [x] **Task 1, `/revoke` hoặc logout trong lúc ký thì token đã ký không được trả**:
  - R4 (dev, `/revoke`).
  - T4 (logout trong cửa sổ ký của code grant: `invalid_grant`, code đã đốt, không family sống, không audit success).
  - T10 (logout + `revokeForSession` trong cửa sổ ký refresh: `invalid_grant`, 0 reuse, không `TOKEN_REFRESHED success`).
- [x] **Task 1, code hết hạn trong lúc ký**: T1. TTL hết giữa peek và consume, đã chắc chắn `sign` được gọi, kết quả `invalid_grant`, không family, không audit success, không token. Đây là 💭-3 của senior.
- [x] **Task 1, RT hết hạn trong lúc ký**: T11 (`invalid_grant`, không successor, 0 reuse).
- [x] **Task 1, PKCE sai / redirect_uri sai / client khác không ký và code còn nguyên**: C6 của dev; T5 của tester (thêm client khác cùng tenant cầm verifier đúng, `sign` không được gọi, code `EXISTS=1`, sau đó chủ sở hữu vẫn đổi được 200).
- [x] **Task 2, DEBT-401**:
  - Vault down: `/token` cả 2 grant và `/jwks.json` trả 503 + `Retry-After: 5` + `no-store` + body đúng câu outage (T5 Vault thật).
  - V1 (lỗi tiêm ở đường sign, Vault thật cho mọi call khác): 429/502/503/network ⇒ 503; 400/403 ⇒ 500 `server_error` không `Retry-After`, cho cả code grant và refresh grant.
  - V2 (`/jwks.json`, cache metadata đã hết hạn): 400/403 ⇒ 500; 429/503/network ⇒ 503 + `Retry-After` + `no-store`; sau đó phục hồi 200.
  - V3: **403 thật** (child token bị revoke, đọc lại token file vẫn ra token cũ) ⇒ `/token` 500 hai lần liên tiếp, code không bị tiêu.
- [x] **Task 3, DEBT-398**: canary độc lập 3/3 build FAIL chỉ in tên file; context thật build qua (không false positive); smoke BE 11/11, fe-admin 14/14.

## Coverage security invariants / risk matrix

| Chiều | Đã kiểm | Test |
|---|---|---|
| Identity / Authorization | client khác cùng tenant replay code với verifier đúng | T5 |
| Credential | verifier sai, redirect sai, code hết hạn, RT hết hạn, RT bị revoke, RT replay sau rotate | T5, T1, T11, R4/T10, T9/R2 |
| State | fresh; already consumed; retry sau lỗi ký (×3); concurrent N=6/8 | T6/T7, T2/T3/T8/T9 |
| Dependency | signer lỗi ở chữ ký thứ hai (ID token); Vault 400/403/429/502/503/network/403 thật | T6/T7, V1–V3, T5 (b73) |
| Request chain | logout/sweep chen giữa ký và commit; request kế tiếp sau thua race / sau khi family chết | T4, T10, T9 (RT1 chết) |
| Exposure | body bên thua (`eyJ`/`access_token`/`refresh_token`/`id_token`); Nest log mọi case (`afterEach`); **mọi document audit** (afterAll quét toàn bộ collection, không `eyJ`); log pino/Nest không chứa Vault token, root token, đường dẫn token hay JWT | T1–T11, V1–V3 |

Đối chiếu bất biến fold:

- **I1** (mỗi code tối đa 1 bộ token): T2, T3.
- **I2** (mỗi RT tối đa 1 successor dùng được): T8, T9.
- **I3** (token chỉ rời server khi commit thắng và mọi re-check đạt): T1, T4, T10, T11.
- **I4** (lỗi ký ⇒ 0 thay đổi trạng thái): T6, T7, V1, V3.
- **I5** (reuse sau rotate đã commit vẫn revoke family + alert): T9.

### Ghi nhận, không phải lỗi

- **T8, refresh race thả đồng thời**: kết quả 0×200, reuse = 5, family bị revoke. Fold cho phép "≤ 1×200" và đây là ngữ nghĩa reuse detection stamp-first sẵn có (spec §9.5 cấm grace). Hành vi giống trước run 54. Nếu cần "đúng 1 thành công" thì phải thả tuần tự (T9). Client gửi refresh song song cùng một RT sẽ mất family; điều này đã được thiết kế như vậy.
- Mỗi request thua trong T9 ghi một `TOKEN_REUSE_DETECTED` riêng (≥ 1; R3 của dev với 2 request thì đúng 1).

## Dọn dẹp

- Container `vg-b73-vault`: `docker rm -f`.
- Image `veyrigate-be:smoke-run54t`, `veyrigate-be:smoke-run54t-build`, `veyrigate-fe-admin:smoke-run54t`: `docker rmi` (3 Untagged). Image canary không bao giờ được tạo vì build fail.
- Không còn container/network `vg-b73b-*`, `vg-be-smoke-*`, `vg-fea-smoke-*`. Context canary trong scratchpad đã xoá.
- `vg-test-mongo`/`vg-test-redis` vẫn chạy như trước (không start/stop). `vg:int-lock` `EXISTS=0`.
- Không đụng `aegate-*`, `funny_pascal`, mailpit, `be/keys`, `be/.env`, `.vscode/mcp.json`, `.mcp.json`, `.claude/`, `.github/agents`.
- Không kill/stop process nào.
