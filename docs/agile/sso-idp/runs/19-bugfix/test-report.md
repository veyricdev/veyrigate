# Test Report ? 2026-10-13

## K?t qu?: PASS (555/555 test ? unit 141 + int 414)

Run `19-bugfix` (DEBT-059 / 055 / 060 / 001+003 / 005). Tester x?c minh acceptance c?a 5 task
[BE] (g?m *(tech-lead fold)*), l?p khe senior n?u (DEBT-066), s?a DEBT-065, v? ?i?u tra DEBT-067.

- Full suite XANH: **typecheck 0 l?i**, **lint 0 l?i**, `pnpm test` = **141** unit, `pnpm test:int` = **414** int ? **555** t?ng (baseline 554; +1 do case DEBT-066 m?i). 0 fail.
- **DEBT-065 ?? ??ng** (s?a file test ? ???c ph?p): kh?i ph?c backtick + xo? byte `\x08` trong 3 file test; x?c minh 0 control byte, kh?ng BOM.
- **DEBT-066 ?? ??ng** (ch? th?m test): case `net.createServer` accept-nh?ng-im-l?ng ch?ng minh `commandTimeout` l? th? c?t treo; mutant b? `commandTimeout` ? case FAIL.
- **DEBT-067**: l? **l?i code (ordering)**, KH?NG ph?i thi?u test ? **tr? l?i backend-dev** (kh?ng s?a code s?n ph?m). Xem case T-067.

---

## L?nh ?? ch?y + output th?c t?

### 1) typecheck ? `pnpm --filter be typecheck` (tsc --noEmit)
```
$ tsc --noEmit
TYPECHECK_EXIT=0
```

### 2) lint ? `pnpm --filter be lint` (eslint src test)
```
$ eslint src test
LINT_EXIT=0
```

### 3) unit ? `pnpm --filter be test`
```
Test Suites: 16 passed, 16 total
Tests:       141 passed, 141 total
Snapshots:   0 total
Ran all test suites.
```

### 4) integration ? `pnpm --filter be test:int` (runInBand, Mongo @27117 rs0 + Redis @6479)
```
Test Suites: 21 passed, 21 total
Tests:       414 passed, 414 total
Snapshots:   0 total
Time:        95.392 s
Ran all test suites.
```
> Ghi ch?: trong log int xu?t hi?n `ERROR [ExceptionsHandler] Error: redis down` + stack ioredis
> ? ??y l? **output c? ?** c?a test ?m (userinfo/token redis-down fail-closed), KH?NG ph?i fail.
> Jest process c? th? exit code ?0 do m?t rejection ioredis "eventual" n? sau teardown (pattern
> swallow-eventual-rejection, li?n quan DEBT-070); t?n hi?u th?m quy?n l? d?ng t?ng
> `Tests: 414 passed, 414 total` + `Test Suites: 21 passed`. Kh?ng c? suite/test n?o FAIL.

### 5) Ch?y ri?ng file DEBT-005/066 (x?c minh + `--detectOpenHandles`)
```
PASS test/redis-fail-fast.int-spec.ts (13.3 s)
  Redis request-path fail-fast on an unreachable server (DEBT-005)
    ? RED: the OLD options (maxRetriesPerRequest:null, no commandTimeout) stay pending past 2.5s (2538 ms)
    ? GREEN: buildRedisOptions rejects a command within ~commandTimeout (no hang) (230 ms)
    ? buildRedisOptions sets commandTimeout from config and maxRetriesPerRequest=1 (3 ms)
    ? fail-closed: RateLimitService.hit REJECTS (never returns allowed:true) when Redis is unreachable (230 ms)
    ? GREEN(DEBT-066): a silent (accepts-but-never-replies) server => get rejects with "Command timed out" within ~commandTimeout (1040 ms)
Tests: 5 passed, 5 total   (no open-handle warning)
```

### 6) MUTANT KILL ? b? `commandTimeout` kh?i `buildRedisOptions` (t?m, ?? kh?i ph?c)
Ch?ng minh case DEBT-066 th?c s? gi?t mutant m? senior n?u (M12/M16):
```
FAIL test/redis-fail-fast.int-spec.ts
    ? RED: the OLD options ... stay pending past 2.5s (2514 ms)        <- v?n PASS (refused)
    ? GREEN: buildRedisOptions rejects ... (212 ms)                    <- v?n PASS (127.0.0.1:1 refused)
    ? buildRedisOptions sets commandTimeout ... (Expected 1000, Received undefined)
    ? fail-closed: RateLimitService.hit REJECTS ... (213 ms)           <- v?n PASS (refused)
    ? GREEN(DEBT-066): a silent server ... (Exceeded timeout of 10000 ms for a test)  <- treo => FAIL
Tests: 2 failed, 3 passed, 5 total
```
K?t lu?n: c?c case `127.0.0.1:1` (refused) **KH?NG** gi?t mutant (??ng nh? senior b?o); **ch?**
case blackhole `net.createServer` (DEBT-066) treo t?i jest-timeout ? FAIL, ch?ng minh `commandTimeout`
m?i l? th? c?t treo. Ngu?n ?? kh?i ph?c y h?t backup (`diff` = IDENTICAL), kh?ng c?n mutant/residue.

---

## Test FAIL (sau khi kh?i ph?c ngu?n): KH?NG c?

## L?i code tr? l?i dev (KH?NG s?a code s?n ph?m)

- **T-067 (DEBT-067)** ? `token.controller.ts` nh?nh `!live` (?L213?227): `await
  this.refresh.revokeFamilyForEndedSession(...)` ??ng TR??C `recordIssued(..., 'failure',
  'session_ended', ...)`. N?u `revokeFamilyForEndedSession` **n?m**, `await` rethrow ? d?ng
  `recordIssued failure session_ended` **kh?ng bao gi? ch?y**. K?t c?c v?n fail-closed 500 (??ng),
  nh?ng **thi?u audit t? ch?i** ? vi ph?m b?t bi?n audit-completeness (m?i code-grant b? t? ch?i ph?i
  ?? l?i ??ng m?t `TOKEN_ISSUED failure`). ??y l? **l?i th? t? code**, c?n fix (try/finally ho?c ghi
  failure best-effort tr??c rethrow) + 1 int test stub `revokeFamilyForEndedSession` reject.
  **Tester KH?NG s?a** (quy t?c: code sai ? tr? dev). DEBT-067 gi? **m?** ? backlog.
  - R?i ro ch?n? KH?NG: fail-closed v?n ??ng (kh?ng bypass/over-grant/r? secret); ch? thi?u 1 d?ng
    audit ? nh?nh hi?m (revoke + n?m). Kh?ng che l?i h? t?ng th?nh success. ? **kh?ng ch?n PASS run 19**;
    l? debt audit-completeness ?? c? ID (DEBT-067), tr? backend-dev cho run k?.

---

## Coverage acceptance criteria (b?ng acceptance ? test ? PASS/FAIL)

| Task / DEBT | Acceptance (r?t g?n) | Test | K?t qu? |
|---|---|---|---|
| T1 DEBT-059 | session end gi?a re-check (offline_access): 0 success, 1 failure `session_ended`, family revoked | `token.int-spec.ts` ? "session ends between re-check ... offline_access => ..." | PASS |
| T1 DEBT-059 | session end (NO offline_access): 0 success, 1 failure `session_ended`, kh?ng family/TOKEN_REVOKED | `token.int-spec.ts` ? "session ends ... NO offline_access => ..." | PASS |
| T1 DEBT-059 | Redis error tr?n re-check ? 500, 0 TOKEN_ISSUED success | `token.int-spec.ts` ? "Redis error on the re-check => 500, 0 ... success" | PASS |
| T1 DEBT-059 | audit success n?m sau re-check live ? 500, no token, family revoked | `token.int-spec.ts` ? "audit of success fails after a live re-check => ..." | PASS |
| T2 DEBT-055 | pre-revoke n?m ? MARK sessions V?N ch?y, sweep ch?y, failure audit `pre_revoke`, rethrow l?i ??u, no rollback | `authentication.service.spec.ts:125` | PASS |
| T2 DEBT-055 | sessions.revoke n?m ? sweep v?n ch?y, failure audit `sessions`, gi? fail-closed (DEBT-050) | `authentication.service.spec.ts:156` | PASS |
| T2 DEBT-055 | failure-audit write l?i kh?ng che l?i revoke g?c | `authentication.service.spec.ts:180` | PASS |
| T3 DEBT-060 | happy: 1 attempt, tr? document | `consent.service.spec.ts` ? "happy path ..." | PASS |
| T3 DEBT-060 | E11000 m?t l?n ? retry ??ng 1 l?n, write IDENTICAL (no over-grant), kh?ng 500 | `consent.service.spec.ts` ? "E11000 once then success ..." | PASS |
| T3 DEBT-060 | E11000 b?n ? KH?NG retry l?n 3, propagate nguy?n | `consent.service.spec.ts` ? "E11000 twice (persistent) ..." | PASS |
| T3 DEBT-060 | non-11000 ? no retry, propagate | `consent.service.spec.ts` ? "non-11000 error => no retry ..." | PASS |
| T4 DEBT-001 | both up ? 200 {status:ok,mongo:up,redis:up} + no-store | `health.int-spec.ts` ? "both up => 200 ..." | PASS |
| T4 DEBT-001/003 | Mongo down ? 503 {mongo:down}, KH?NG server_error, no leak | `health.int-spec.ts` ? "Mongo down (DEBT-003) => 503 ..." | PASS |
| T4 DEBT-001 | Redis down ? 503 {redis:down}, KH?NG server_error | `health.int-spec.ts` ? "Redis down => 503 ..." | PASS |
| T4 DEBT-001 | both down ? 503 both down | `health.int-spec.ts` ? "both down => 503 ..." | PASS |
| T4 DEBT-001 | route kh?c v?n gi? RFC6749 {error,error_description} (filter kh?ng b? ph?) | `health.int-spec.ts` ? "sibling route ... RFC 6749 ..." | PASS |
| T5 DEBT-005 | option c? (null, no timeout) treo > 2.5s (RED t?i hi?n bug) | `redis-fail-fast.int-spec.ts` ? "RED: the OLD options ..." | PASS |
| T5 DEBT-005 | `buildRedisOptions` fail-fast ? commandTimeout+500ms (refused) | `redis-fail-fast.int-spec.ts` ? "GREEN: buildRedisOptions rejects ..." | PASS |
| T5 DEBT-005 | option: commandTimeout=env, maxRetriesPerRequest=1, lazyConnect=false | `redis-fail-fast.int-spec.ts` ? "buildRedisOptions sets commandTimeout ..." | PASS |
| T5 DEBT-005 | fail-closed: RateLimitService.hit REJECT (kh?ng allowed:true) khi Redis kh?ng reachable | `redis-fail-fast.int-spec.ts` ? "fail-closed: RateLimitService.hit REJECTS ..." | PASS |
| T5 DEBT-066 | server accept-nh?ng-im-l?ng (blackhole) ? `get` reject `Command timed out` ? commandTimeout+500ms; mutant b? timeout ? FAIL | `redis-fail-fast.int-spec.ts` ? "GREEN(DEBT-066): a silent ... server ..." | PASS (mutant-killing) |

## Coverage security invariants / risk matrix

| Invariant / chi?u r?i ro | Test | K?t qu? |
|---|---|---|
| INV audit-completeness: TOCTOU session end ? ??ng 1 `TOKEN_ISSUED failure session_ended`, kh?ng "success" gi? | DEBT-059 (4 case) | PASS |
| State: `exists` true?false (consumed/stale gi?a c?a exchange) ? fail-closed, family minted b? revoke (kh?ng orphan) | DEBT-059 case 1 | PASS |
| Dependency timeout/down (Redis re-check n?m) ? fail-closed 500, 0 success | DEBT-059 case 3; DEBT-005 fail-closed | PASS |
| INV-11/28: reset password l?i h? t?ng ? ch?y ?? 3 b??c revoke, kh?ng rollback credential, audit `revoke_failed` | DEBT-055 (3 case) | PASS |
| Authorization/over-grant: consent retry gi? write IDENTICAL (`$setUnion` ? allowed) ? kh?ng m? ???ng over-grant | DEBT-060 case 2 | PASS |
| Exposure budget: `/ready` 503 ch? enum up/down, no host/message/stack leak | DEBT-001/003 (Mongo-down leak assert) | PASS |
| Fail-open prevention: Redis down ? rate-limit `hit` REJECT (kh?ng bao gi? allowed:true) | DEBT-005 fail-closed case | PASS |
| Availability/DoS: l?nh Redis tr?n request-path fail-fast ? commandTimeout (blackhole + refused), kh?ng treo | DEBT-005 + DEBT-066 | PASS |

## DEBT ?? ??ng ? l??t tester n?y
- **DEBT-065** ? s?a comment 3 file test (backtick + `\x08`), 0 control byte, kh?ng BOM.
- **DEBT-066** ? th?m case blackhole ch?ng minh `commandTimeout`; mutant-kill x?c nh?n.

## DEBT v?n m? (tr? dev)
- **DEBT-067** ? l?i ordering code (`token.controller`), tr? **backend-dev** run k?. Kh?ng ch?n PASS run 19 (fail-closed v?n ??ng, ch? thi?u 1 d?ng audit nh?nh hi?m).
