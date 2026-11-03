# Tech Lead Review — 2026-11-03

## Kết luận: PASS

Fold bắt buộc ở `tasks.md` § Fold tech-lead (gốc đã xác minh, quyết định, điểm sửa, cách chứng minh).

## Kiến trúc đề xuất (nếu cần điều chỉnh)

Không đổi kiến trúc. Hạ tầng test: mỗi lệnh jest đặc thù (`test:int`, `test:vault`, `test:sentinel`) có file config riêng; CLI chỉ còn cờ boolean (`--runInBand`, `--forceExit`) ⇒ đối số vị trí và `--testTimeout=N` tới jest nguyên vẹn. An toàn DB: một chốt duy nhất ở globalSetup (`int-preflight.mjs`, dùng chung cho `test:vault`).

## Điểm mạnh

- Phạm vi nhỏ, đúng lane test-infra; cả 4 debt có gốc khớp code thật.
- DEBT-470 tái hiện được và tệ hơn backlog ghi: `test:vault run54` kéo cả `run54-tester.int-spec.ts` vào chạy dưới preflight Vault (6 file thay vì 1).
- Ràng buộc ops (không FLUSH/drop DB chung, không `--yes`) rõ ràng.

## Vấn đề (bắt buộc sửa nếu REJECT)

Không có (PASS). Những điểm task gốc để ngỏ đã chốt trong fold:
- [x] DEBT-471 chọn (b) + gỡ 2 điều kiện `!TEST_MONGO_URI` ở `full-app.ts` (một ngữ nghĩa). Lý do: (a)/(c) chạm ~45 chỗ drop trong 33 file; (b) chặn trước mọi kết nối, ~10 dòng.
- [x] Security: trust boundary = biến môi trường do người chạy đặt → spec drop DB. Invariant: không spec int nào drop DB có tên khác `vg-int-*`. Fail-closed với URI rỗng/hỏng/không path. Exposure: lỗi chỉ in tên DB, không in URI (có thể chứa user:pass). Test âm: drill DB `vg-drill471-*` còn nguyên + mutation chứng minh guard là thứ chặn.
- [x] DEBT-203 không đóng, chỉ cập nhật (override vẫn dùng chung một DB cho mọi spec).
- [x] Sentinel config không có globalTeardown (giữ hành vi hiện tại).

## Đề xuất (không bắt buộc)

- DEBT-203 (đã có): coi override là base URI + hậu tố mỗi spec; khi làm, các `.replace('vg-int-…-', …)` suy DB phụ (vd. `admin-target-risk.int-spec.ts:334`) cũng phải tách đúng.
- Gỡ `--forceExit` cho `test:vault`/`test:sentinel` (như DEBT-054 đã làm cho int) → DEBT-475.
