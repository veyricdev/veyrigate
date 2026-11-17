# CodeQL open alerts (develop, 2026-11-17)

40 cảnh báo đang mở, nhóm theo mức độ.

## Critical

| # | Rule | Vị trí |
|---|---|---|
| #9 | Type confusion through parameter tampering | `be/…/logout/logout.service.ts:118` |

## High — code ứng dụng

| # | Rule | Vị trí |
|---|---|---|
| #37 | Use of password hash with insufficient computational effort | `be/…/mfa/recovery-codes.ts:43` |
| #27 | Use of password hash with insufficient computational effort | `be/…/crypto/crypto.util.ts:41` |
| #8 | Database query built from user-controlled sources | `be/…/resources/resource.service.ts:56` |
| #7 | Database query built from user-controlled sources | `be/…/clients/client.service.ts:233` |
| #2 | DOM text reinterpreted as HTML | `be/…/public/logout-redirect.js:11` |
| #1 | Polynomial regular expression used on uncontrolled data | `be/…/http/bearer.ts:20` |
| #32 | User-controlled bypass of security check | `be/…/ui/csrf.service.ts:105` |
| #31 | User-controlled bypass of security check | `be/…/ui/csrf.service.ts:105` |
| #29 | User-controlled bypass of security check | `be/…/authorize/authorize.service.ts:280` |
| #28 | User-controlled bypass of security check | `be/…/authorize/authorize.service.ts:274` |
| #16 | User-controlled bypass of security check | `be/…/authorize/authorize.service.ts:310` |
| #15 | User-controlled bypass of security check | `be/…/authorize/authorize.service.ts:306` |
| #14 | User-controlled bypass of security check | `be/…/authorize/authorize.service.ts:300` |
| #13 | User-controlled bypass of security check | `be/…/federation/federation.service.ts:172` |

## High — script

| # | Rule | Vị trí |
|---|---|---|
| #40 | Potential file system race condition | `be/scripts/pentest/checks.mjs:382` |
| #39 | Potential file system race condition | `be/scripts/pentest/checks.mjs:366` |
| #38 | Potential file system race condition | `be/scripts/pentest/mutate.mjs:73` |
| #36 | Insecure temporary file | `be/scripts/drills/lib.mjs:600` |

## High — test

| # | Rule | Vị trí |
|---|---|---|
| #30 | Bad HTML filtering regexp | `be/test/run86-tester.int-spec.ts:252` |
| #22 | Incomplete URL scheme check | `be/test/admin-api.int-spec.ts:1123` |
| #6 | Bad HTML filtering regexp | `fe-admin/test/csp-nonce-ssr.test.tsx:85` |
| #5 | Bad HTML filtering regexp | `fe-admin/test/csp-nonce-concurrency.test…:115` |
| #4 | Bad HTML filtering regexp | `e2e/tests/fe-admin-hardening.spec…:92` |
| #3 | Bad HTML filtering regexp | `be/test/ui.int-spec.ts:1605` |

## Medium — script

| # | Rule | Vị trí |
|---|---|---|
| #35 | Network data written to file | `be/scripts/drills/lib.mjs:570` |
| #34 | Network data written to file | `be/scripts/drills/rotate-drill.mjs:122` |
| #33 | File data in outbound network request | `be/scripts/drills/rotate-drill.mjs:47` |
| #21 | Network data written to file | `fe-admin/scripts/fetch-openapi.mjs:12` |

## Medium — test

| # | Rule | Vị trí |
|---|---|---|
| #26 | Network data written to file | `be/test/run55-tester.vault-spec:103` |
| #25 | Network data written to file | `be/test/run54-tester.vault-spec:101` |
| #20 | Network data written to file | `be/test/vault-transit.vault-spec:446` |
| #19 | Network data written to file | `be/test/vault-transit.vault-spec:147` |
| #18 | Network data written to file | `be/test/b73c-tester.vault-spec:115` |
| #17 | Network data written to file | `be/test/b73-tester.vault-spec.ts:158` |
| #24 | File data in outbound network request | `be/test/run55-tester.vault-spec:50` |
| #23 | File data in outbound network request | `be/test/run54-tester.vault-spec:47` |
| #12 | File data in outbound network request | `be/test/vault-transit.vault-spec:63` |
| #11 | File data in outbound network request | `be/test/b73c-tester.vault-spec:45` |
| #10 | File data in outbound network request | `be/test/b73-tester.vault-spec.ts:57` |
