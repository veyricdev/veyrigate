import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from "jose";
import { createAuth, type Auth } from "@/server/auth/bff";
import { createDiscovery, type Discovery } from "@/server/oidc/discovery";
import { cookieNames } from "@/server/session/cookies";
import { createSessionStore, type SessionStore } from "@/server/session/store";

/**
 * In-process fake IdP + admin API behind an injected `fetch`, so the BFF runs its real HTTP, JOSE
 * and Redis code. Every behaviour is a mutable field a test can override.
 */
export const ISSUER = "http://idp.test";
export const APP_URL = "http://localhost:3000";
export const CLIENT_ID = "fe-admin";
const SECRET = "client-secret-0123456789abcdef0123456789";

type Json = Record<string, unknown>;
type Reply = { status: number; body: Json };
type Handler = (req: { form: URLSearchParams; headers: Headers }) => Reply | Promise<Reply>;

export interface FakeIdp {
  auth: Auth;
  store: SessionStore;
  /** Created session keys (for cleanup). */
  sessionKeys: Set<string>;
  /** Every URL the BFF fetched (any origin), plus per-endpoint counters (matched by path only). */
  calls: { urls: string[]; token: URLSearchParams[]; revoke: string[]; me: number; userinfo: number };
  /** Discovery document served at `/.well-known/openid-configuration` (patch it to test trust checks). */
  discoveryDoc: Json;
  /** Discovery used by the BFF (real `createDiscovery` over the fake fetch by default). */
  discovery: () => Promise<Discovery>;
  sub: string;
  tenantId: string;
  roles: string[];
  /** Overrides for the next tokens; `idClaims` are merged into the default ID token claims. */
  idClaims: Json;
  signWith: "idp" | "foreign" | "hs256" | "none";
  token: Handler;
  me: () => { status: number; body: Json };
  userinfo: () => { status: number; body: Json };
  sign(claims: Json): Promise<string>;
  /** Default /token behaviour (client auth check + fresh tokens); handy inside overrides. */
  issue(withNonce: boolean): Promise<Json>;
  /** Clock used by the BFF (ms). */
  clock: { now: number };
  /** Nonce of the last /auth/login (echoed in the next code-grant ID token). */
  nonce: string;
  /** Fake access-token lifetime in seconds. */
  expiresIn: number;
}

export async function createFakeIdp(redis: Redis): Promise<FakeIdp> {
  const idpKey = await generateKeyPair("RS256", { extractable: true });
  const foreignKey = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(idpKey.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const clock = { now: Date.now() };

  const fake = {} as FakeIdp;
  const sign = async (claims: Json): Promise<string> => {
    const nowSec = Math.floor(clock.now / 1000);
    const payload: JWTPayload = {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: fake.sub,
      iat: nowSec,
      exp: nowSec + 300,
      ...claims,
    };
    if (fake.signWith === "none") {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.`;
    }
    if (fake.signWith === "hs256") {
      return new SignJWT(payload).setProtectedHeader({ alg: "HS256", kid: "k1" }).sign(randomBytes(32));
    }
    const key = fake.signWith === "foreign" ? foreignKey.privateKey : idpKey.privateKey;
    return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(key);
  };

  const issue = async (withNonce: boolean): Promise<Json> => ({
    access_token: `at-${randomBytes(8).toString("hex")}`,
    token_type: "Bearer",
    expires_in: fake.expiresIn,
    refresh_token: `rt-${randomBytes(8).toString("hex")}`,
    id_token: await sign({
      ...(withNonce ? { nonce: fake.nonce, auth_time: Math.floor(clock.now / 1000) } : {}),
      ...fake.idClaims,
    }),
  });

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    fake.calls.urls.push(url.toString());
    if (url.pathname === "/.well-known/openid-configuration") return json(200, fake.discoveryDoc);
    if (url.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      fake.calls.token.push(form);
      const res = await fake.token({ form, headers });
      return json(res.status, res.body);
    }
    if (url.pathname === "/revoke") {
      fake.calls.revoke.push(new URLSearchParams(String(init?.body ?? "")).get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/admin/me") {
      fake.calls.me++;
      const res = fake.me();
      return json(res.status, res.body);
    }
    if (url.pathname === "/userinfo") {
      fake.calls.userinfo++;
      const res = fake.userinfo();
      return json(res.status, res.body);
    }
    return json(404, { error: "not_found" });
  }) as typeof fetch;

  const store = createSessionStore({
    redis,
    secret: randomBytes(32).toString("base64url"),
    now: () => clock.now,
  });
  const sessionKeys = new Set<string>();
  const create = store.create.bind(store);
  store.create = async (data) => {
    const r = await create(data);
    sessionKeys.add(r.key);
    return r;
  };

  Object.assign(fake, {
    store,
    sessionKeys,
    calls: { urls: [], token: [], revoke: [], me: 0, userinfo: 0 },
    discoveryDoc: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks.json`,
      end_session_endpoint: `${ISSUER}/logout`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      revocation_endpoint: `${ISSUER}/revoke`,
    },
    discovery: createDiscovery(ISSUER, fetchImpl, () => clock.now),
    sub: "user-1",
    tenantId: "t1",
    roles: ["super_admin"],
    idClaims: {},
    signWith: "idp",
    clock,
    expiresIn: 900,
    nonce: "",
    sign,
    me: () => ({ status: 200, body: { sub: fake.sub, tenantId: fake.tenantId, roles: fake.roles } }),
    userinfo: () => ({ status: 200, body: { sub: fake.sub, email: "admin@example.com" } }),
  } satisfies Partial<FakeIdp>);

  fake.issue = issue;
  fake.token = async ({ form, headers }) => {
    const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`;
    if (headers.get("authorization") !== expected) return { status: 401, body: { error: "invalid_client" } };
    return { status: 200, body: await issue(form.get("grant_type") === "authorization_code") };
  };

  fake.auth = createAuth({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    appUrl: APP_URL,
    adminResource: `${ISSUER}/admin/`,
    idp: { clientId: CLIENT_ID, clientSecret: SECRET, adminApiBaseUrl: ISSUER, fetch: fetchImpl },
    discovery: () => fake.discovery(),
    jwks: () => jwks,
    store,
    cookies: cookieNames(APP_URL),
    now: () => clock.now,
  });

  return fake;
}

/** Cookie header from Set-Cookie values (name=value pairs, deletions dropped). */
export function setCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair!.indexOf("=");
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

export interface LoginStart {
  state: string;
  nonce: string;
  authorize: URL;
  txCookie: string;
}

/** GET /auth/login and capture what the browser would carry to the IdP and back. */
export async function startLogin(idp: FakeIdp, query = "", cookie = ""): Promise<LoginStart> {
  const res = await idp.auth.login(
    new Request(`${APP_URL}/auth/login${query}`, { headers: cookie ? { cookie } : {} }),
  );
  if (res.status !== 302) throw new Error(`login status ${res.status}`);
  const authorize = new URL(res.headers.get("location")!);
  const state = authorize.searchParams.get("state")!;
  const nonce = authorize.searchParams.get("nonce")!;
  idp.nonce = nonce;
  return { state, nonce, authorize, txCookie: setCookies(res).fea_tx! };
}

/** GET /auth/callback as the browser would after the IdP redirect. */
export function callback(
  idp: FakeIdp,
  params: Record<string, string>,
  cookies: Record<string, string>,
): Promise<Response> {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const qs = new URLSearchParams(params).toString();
  return idp.auth.callback(new Request(`${APP_URL}/auth/callback?${qs}`, { headers: cookie ? { cookie } : {} }));
}

/** Full happy-path login; returns the session cookie value. */
export async function signIn(idp: FakeIdp, query = "", cookie = ""): Promise<{ sid: string; res: Response }> {
  const s = await startLogin(idp, query, cookie);
  const cookies: Record<string, string> = { fea_tx: s.txCookie };
  if (cookie) for (const part of cookie.split("; ")) cookies[part.split("=")[0]!] = part.split("=")[1]!;
  const res = await callback(idp, { code: "c1", state: s.state, iss: ISSUER }, cookies);
  return { sid: setCookies(res).fea_sid ?? "", res };
}
