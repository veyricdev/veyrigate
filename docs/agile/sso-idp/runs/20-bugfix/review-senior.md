# Senior Review — 2026-10-13 (Lượt 4, sau backend-dev retry 3)
## Kết luận: PASS   (🔴 lượt 3 + 🟡1–3 lượt 3 đã đóng; không còn 🔴; 1 🟡 tài liệu mới → backlog)

→ chuyển sang **tester**. Phạm vi lượt này: chỉ thay đổi trust-proxy (`trust-proxy.ts`, `trust-proxy.spec.ts`, `main.ts`, `configuration.ts`, `validation.schema.ts`, runbook §5, `.env.example`, AC `tasks.md`). Các phần khác đã đạt ở lượt 1–3.
Lịch sử: lượt 1 REJECT (race peek→hit, `0.0.0.0/0`); lượt 2 REJECT (mapped IPv6 viết khác); lượt 3 REJECT (hop count bị Fastify 5 bỏ qua).

## Tổng quan (ấn tượng chung + điểm tốt)
- Hướng sửa gọn và đúng: bỏ hẳn hop count thay vì cố tự cài. Type thu về `false | string[]`, `main.ts` không còn cast, comment sai đã bỏ. Chỗ Fastify fail-closed giờ thành lỗi khởi động có hướng dẫn, không còn "trông như đã cấu hình".
- Test giờ chạy qua runtime thật: `FastifyAdapter` + `inject` với XFF (kiểm `req.ip`), và `@fastify/proxy-addr` thật được resolve theo chuỗi `@nestjs/platform-fastify → fastify → proxy-addr`. Khi nâng Fastify, test sẽ đổi theo, không bị lệch như bản chép tay.
- Tự chạy lại: `tsc --noEmit` 0, eslint (`src/config`, `main.ts`) 0, **unit 175/175** (17 suite), int `client-auth-rate-limit.int-spec.ts` **16/16** (dùng container test đang chạy, không `compose up`). Int toàn bộ 442/442 là số dev báo.
- Mutation tự chạy (khôi phục byte-identical, sha256 `0731DF6D…0002` trước = sau):
  | Mutation | Kết quả |
  |---|---|
  | B: bỏ `isIP` ở nhánh CIDR | ☠️ 1 fail/20 |
  | C: bỏ throw danh sách rỗng | ☠️ 1 fail/20 |
  | A′: chỉ bỏ regex `/^\d+$/` | sống 20/20, **nhưng an toàn**: `"1"` rơi xuống nhánh IP, `isIP('1')=0` ⇒ vẫn throw (chỉ đổi thông báo). Guard số chủ yếu để có thông báo hướng dẫn. Mutation A của dev (khôi phục trả `number`) ⇒ 2 fail, đã đối chiếu test. |

## 🔴 Blocker
- (không có)
- [x] 🔴 lượt 3 (hop count) — ĐÃ ĐÓNG. `trust-proxy.ts:46–50` throw với mọi chuỗi chỉ gồm chữ số (đã thử `1`, ` 1 `, `0`, `00`, `10`, `11`). Các dạng gần số (`1.5`, `+1`, `1e1`, `0x7f000001`) bị nhánh IP từ chối. Test `refuses to build a FastifyAdapter from a numeric hop count` bắt được hồi quy.

## Security invariants / trust boundaries đã kiểm
Đã thử thật **44 giá trị**: `parseTrustProxy` thật → `new FastifyAdapter({trustProxy})` → `inject` (socket 127.0.0.1, `X-Forwarded-For: 6.6.6.6, 7.7.7.7`) → đọc `req.ip`. Thêm 12 danh sách đưa thẳng vào `proxyAddr.compile` với IP công khai v4/v6/mapped.

| Nhóm | Ví dụ | Kết quả | Đánh giá |
|---|---|---|---|
| Keyword của proxy-addr | `loopback`, `uniquelocal`, `linklocal`, `127.0.0.1,loopback` | throw "not a valid IP address" | ✅ **Nên từ chối.** Parser không phân loại được keyword. Lợi ích cũng nhỏ: `uniquelocal` = `10/8,172.16/12,192.168/16,fc00::/7` nên viết CIDR tương đương được. Hướng dẫn chỉ nhận IP/CIDR trong runbook đã khớp. |
| Danh sách trộn | `10.0.0.1,abc`, `10.0.0.1;10.0.0.2`, `10.0.0.0/8 #c` | throw, nêu đúng mục xấu | ✅ |
| Mục rỗng xen kẽ | `10.0.0.1,,`, ` 10.0.0.1 , 10.0.0.2 ` | lọc bỏ mục rỗng ⇒ `['10.0.0.1']` | ✅ chấp nhận được (còn ≥1 mục thật) |
| Chỉ dấu phẩy | `,`, ` , `, `,,` | throw (🟡3 đóng) | ✅ |
| Octal/hex/rút gọn | `010.0.0.0/8`, `0x7f.0.0.1/8`, `127.1/8`, `127.1`, `0x7f000001` | throw (🟡1 đóng) | ✅ |
| IPv6 + `isIP` | `::1`, `::1/128`, `fd00::/8`, `2001:db8::/32`, `[::1]` | chấp nhận / `[::1]` throw | ✅ |
| Zone id | `fe80::1%eth0` | chấp nhận; proxy-addr chỉ tin `fe80::1` | ✅ an toàn (1 địa chỉ link-local) |
| Mapped | `::ffff:127.0.0.1` ⇒ `req.ip=7.7.7.7` (tin đúng loopback); `::ffff:10.0.0.0/104` chấp nhận; `/103` throw | ✅ |
| "Không tin gì" vô hại | `0.0.0.0`, `::`, `0.0.0.0/8`, `::ffff:0.0.0.0/104` | chấp nhận; `req.ip` = socket | ✅ fail-closed |
| `::/8`, `::/16`, `::/80`, `::/95` | chấp nhận; proxy-addr chỉ tin `::1` (loopback v6), **không** tin `::ffff:6.6.6.6`/IPv4 (proxy-addr 5.1.1 yêu cầu subnet mapped ≥/96 mới khớp IPv4) | ✅ |
| Prefix lạ | `10.0.0.0/08` (= /8) chấp nhận; `/ 8`, `/`, `/-1`, `/33`, `/8/8` throw | ✅ |
| Hoa/thường | `TRUE` throw, `False` ⇒ `false` | ✅ |
| Chữ số Unicode | `٣` | throw | ✅ |

- **Identity (IP client)**: chỉ tin XFF khi socket nằm trong danh sách; `10.0.0.0/8` + socket loopback ⇒ XFF bị bỏ qua (có test). ✅
- **Failure behavior**: mọi cấu hình sai ⇒ throw lúc khởi động (`validation.schema` superRefine + `main.ts` + `assertTrustProxyConsistent`), không có nhánh nào ngầm thành "tin tất cả". ✅
- **Exposure**: thông báo lỗi chỉ lặp lại giá trị env của operator, không có secret. ✅
- **Tài liệu ↔ code**: runbook §5, `.env.example`, AC `tasks.md` Bước 0, `review-techlead.md` "Bổ sung — retry 3" đều khớp code. Ngoại lệ ở 🟡 dưới.

## 🟡 Nên sửa
- [ ] **🟡 Tài liệu lệch code** — `be/src/config/validation.schema.ts:72–73`: comment vẫn ghi "set to the proxy IP(s)/CIDR(s) **or a hop count** in production". Vì sao: đây đúng là hướng dẫn sai đã gây 🔴 lượt 3, ai đọc schema sẽ tưởng số được chấp nhận. Đề xuất: xoá "or a hop count", thêm "numeric is rejected (Fastify 5 ignores it)". → `DEBT-074`.

## 💭 Nit
- `tasks.md` R2/R3 (fold retry 1) vẫn ghi "Hop count > 10 ⇒ từ chối" và "số hop phải đúng bằng số proxy". Đây là lịch sử, đã bị Bước 0 + "Bổ sung — retry 3" thay. Có thể gạch ngang hoặc ghi "(đã thay ở retry 3)" để người đọc không nhầm.
- Thông báo lỗi cho keyword (`loopback`…) là "not a valid IP address". Có thể gợi ý thêm "keywords not supported; use CIDR (e.g. 127.0.0.0/8)".
- (từ lượt 3, vẫn còn) min prefix /8 cho IPv6 vẫn cho qua các khối public `2a00::/8`. Tech-lead đã ghi ngoài phạm vi.
- Các nit lượt 2 (refund lệch −1 ở ranh giới cửa sổ, `loadEnvFile` khác dotenv) chấp nhận được. `/introspect` 429 thiếu `error_description` bị tech-lead hoãn ⇒ ghi `DEBT-075` để không thất lạc.

## ✂️ Ponytail
- be/src/config/trust-proxy.spec.ts:L57-66: shrink: vòng `for` có `if` để tách case `'  '`. Thay bằng `expect(parseTrustProxy('  ')).toBe(false)` + vòng 3 giá trị chỉ dấu phẩy, không cần nhánh.
- be/src/config/trust-proxy.ts:L46-50: giữ nguyên. Về logic thì thừa (nhánh `isIP` đã từ chối số), nhưng nó cho thông báo hướng dẫn và có test riêng.
net: -4 lines possible.