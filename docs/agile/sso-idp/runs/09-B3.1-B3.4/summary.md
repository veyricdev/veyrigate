# Summary — B3.1–B3.4 (M2) — ✅ PASS 206/206

- Phạm vi: Client & Resource (spec §7, §9.3, §9.7). B3.1 Client/ClientCredential + validator
  redirect_uri (exact, no wildcard/fragment, https-only, env-aware localhost) + postLogoutRedirectUris;
  B3.2 Resource + allowedResources (identifier→resourceId); B3.3 client auth /token
  (basic/post/none, Argon2id, rotation overlap, anti-enumeration); B3.4 ClientCorsService
  (per-client + union allowlist, chưa wire HTTP — chờ B4).
- Kết quả: tech-lead PASS (C1–C6) · senior PASS · tester PASS — 67 unit + 139 integration.
- Commit: `c813f4b`.
- Quyết định quan trọng: grace TTL rotation secret = 604800s (7 ngày, TẠM — spec §17 còn mở,
  theo Q liên quan); CORS tách per-client/union theo endpoint, không global tĩnh (C5).
- Debt để lại: DEBT-019 (@fastify/cors chưa wire → B4), DEBT-020 (index allowedCorsOrigins → B4),
  DEBT-021 (rotateSecret không atomic → B6.3).