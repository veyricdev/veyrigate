# Tasks — run 10 — B4.1 (`/authorize`)

> Nguồn: `plan.md` §B4 (B4.1), `spec.md` §9.1–9.2, §13 bước 6. Mốc **M3** (walking skeleton).
> Phụ thuộc đã xong: B3.2 (Resource/allowedResources), B2.3 (session/tenant ctx), B2.5 (UI server-side).
> Chỉ B4.1. Consent (B4.2), AuthorizationCode store (B4.3), `/token` (B4.4) là run sau.

## Phạm vi

Chỉ dừng ở `/authorize` + `AuthorizeRequestContext`. KHÔNG phát hành code/token (đó là B4.3/B4.4).
Khi validate thành công và user đã đăng nhập + đủ consent → tạo context, chuyển sang bước phát code (B4.3, chưa có) ⇒ ở run này dừng ở điểm "sẵn sàng phát code" (trả về trạng thái/redirect tới login/consent, hoặc để lại TODO rõ cho B4.3). Chưa đăng nhập → đẩy sang trang login (B2.5). Thiếu consent → đẩy sang consent (B4.2, chưa có) ⇒ để TODO + DEBT.

## Task

- [x] **B4.1** [BE] **`/authorize` endpoint + `AuthorizeRequestContext`**
  - `AuthorizeRequestContext` lưu ở Redis, TTL 5–10 phút, **single-use** (`request_id`).
  - Validate: `client_id` tồn tại/active; `redirect_uri` **exact match** với client (tái dùng `redirect-uri.validator`/`ClientService`); `response_type=code`; `code_challenge_method=S256` (**reject `plain`**); `code_challenge` hợp lệ; `scope` (lọc theo `scopes_supported`); `resource` ∈ `allowedResources` của client (map identifier→resourceId qua `ResourceService`, **không so URI trực tiếp**); `state`, `nonce` echo nguyên vẹn.
  - `prompt`: `none` (không tương tác → lỗi `login_required`/`consent_required` nếu cần), `login` (ép re-auth), `consent` (ép hỏi consent); **`max_age`** (D3 step-up: so với `auth_time` của session).
  - **Chống open redirect (INV-3)**: lỗi xảy ra **trước khi** xác thực `client_id`+`redirect_uri` hợp lệ ⇒ **hiển thị trang lỗi, KHÔNG redirect**. Sau khi redirect_uri đã hợp lệ ⇒ trả lỗi OAuth qua redirect (`error`, `error_description`, `state`, + `iss` RFC 9207).
  - Nghiệm thu (spec §9.2, INV-3/4/14/15): test open-redirect (client_id/redirect_uri sai → trang lỗi, không redirect); PKCE `plain` bị từ chối; `resource` lạ bị từ chối; `state`/`nonce` echo đúng; context single-use + hết hạn.
  - DEBT trong phạm vi: **DEBT-015** (CSP `form-action` cho chuỗi redirect sang RP — xử lý hoặc xác nhận không áp dụng ở B4.1 vì `/authorize` dùng redirect GET, không POST form sang RP), **DEBT-019/020** (nếu wire CORS ở đây thì xử lý; nếu không thuộc `/authorize` thì giữ nguyên cho B4.4/B4.6).

## Ghi chú chặn

- **Q6** (session idle/absolute + token TTL) ảnh hưởng B4.4, không chặn B4.1 (B4.1 chỉ đọc `auth_time` cho `max_age`).
- **Q1** (consent semantic) chặn **B4.2**, không phải B4.1. B4.1 chỉ cần phát hiện "thiếu consent" ở mức khung.