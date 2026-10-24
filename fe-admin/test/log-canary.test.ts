// @vitest-environment node
// INV-20 FE (A7, run 51 F3): the BFF error paths that talk to the IdP token endpoint never log the
// upstream body, a token, a bearer header or the session cookie. Every console line is captured.
// The admin API 5xx/4xx canary branches are covered by admin-api-risk.test.ts ("raw BE bodies never
// cross to the browser or the logs").
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toPublicError } from "@/server/errors";
import { connectTestRedis } from "./support/redis";
import { APP_URL, ISSUER, callback, createFakeIdp, signIn, startLogin, type FakeIdp } from "./support/fake-idp";

let redis: Redis;
let idp: FakeIdp;
let logged: string[];

const CANARY = "RT-CANARY";
const JWT_CANARY = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2ln";
const body = { error: "invalid_grant", error_description: `${CANARY} ${JWT_CANARY}`, refresh_token: CANARY };

beforeAll(async () => {
  redis = await connectTestRedis();
});
beforeEach(async () => {
  idp = await createFakeIdp(redis);
  logged = [];
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (idp.sessionKeys.size) await redis.del(...idp.sessionKeys);
});
afterAll(() => redis.disconnect());

function expectCleanLogs(...secrets: string[]) {
  const text = logged.join("\n");
  for (const s of [CANARY, "eyJ", "Bearer ", ...secrets]) expect(text).not.toContain(s);
}

describe.each([400, 500])("token endpoint %i with a canary body", (status) => {
  it("callback code exchange: rejected, nothing of the body in the logs", async () => {
    idp.token = () => ({ status, body });
    const s = await startLogin(idp);
    const res = await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain(CANARY);
    expect(logged.length).toBeGreaterThan(0); // the failure is logged (with the error's message)
    expectCleanLogs(s.txCookie, s.state);
  });

  it("refresh: session ends or 503, nothing of the body, token or cookie in the logs", async () => {
    const { sid } = await signIn(idp);
    idp.clock.now += 900_000 - 30_000; // inside the refresh skew
    idp.token = () => ({ status, body });
    // A throw (5xx => 503) goes through the same boundary as in the app, which logs it.
    await idp.auth
      .viewer(new Request(`${APP_URL}/`, { headers: { cookie: `fea_sid=${sid}` } }))
      .catch((err: unknown) => toPublicError("root beforeLoad", err));
    expect(idp.calls.token.filter((f) => f.get("grant_type") === "refresh_token")).toHaveLength(1);
    expectCleanLogs(sid);
  });
});
