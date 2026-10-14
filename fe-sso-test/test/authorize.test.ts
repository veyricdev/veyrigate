// @vitest-environment node
import { describe, it, expect } from "vitest";
import { beginLogin } from "../src/oidc/authorize";
import type { Discovery } from "../src/oidc/discovery";
import type { TransientStore } from "../src/oidc/transient";

const ISSUER = "http://localhost:4000";
const discovery: Discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks.json`,
  end_session_endpoint: `${ISSUER}/logout`,
};

const config = {
  clientId: "fe-sso-test",
  redirectUri: "http://localhost:5173/callback",
  scope: "openid profile email offline_access",
  resource: "http://localhost:4000/demo/",
};

function memStore(): TransientStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("beginLogin", () => {
  it("builds an /authorize URL with all 9 required params and S256", async () => {
    const { url, transient } = await beginLogin(discovery, config, memStore());
    const u = new URL(url);
    const p = u.searchParams;
    expect(u.origin + u.pathname).toBe(`${ISSUER}/authorize`);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("fe-sso-test");
    expect(p.get("redirect_uri")).toBe("http://localhost:5173/callback");
    expect(p.get("scope")).toBe("openid profile email offline_access");
    expect(p.get("state")).toBe(transient.state);
    expect(p.get("nonce")).toBe(transient.nonce);
    expect(p.get("code_challenge")).toBeTruthy();
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("resource")).toBe("http://localhost:4000/demo/");
  });

  it("never puts the code_verifier in the /authorize URL (exposure budget)", async () => {
    const { url, transient } = await beginLogin(discovery, config, memStore());
    expect(url).not.toContain(transient.verifier);
  });

  it("omits prompt by default; includes it only when supplied (OPEN-2)", async () => {
    const def = await beginLogin(discovery, config, memStore());
    expect(new URL(def.url).searchParams.has("prompt")).toBe(false);
    const withPrompt = await beginLogin(discovery, { ...config, prompt: "login" }, memStore());
    expect(new URL(withPrompt.url).searchParams.get("prompt")).toBe("login");
  });

  it("generates fresh high-entropy state/nonce each call", async () => {
    const a = await beginLogin(discovery, config, memStore());
    const b = await beginLogin(discovery, config, memStore());
    expect(a.transient.state).not.toBe(b.transient.state);
    expect(a.transient.nonce).not.toBe(b.transient.nonce);
    expect(a.transient.state.length).toBeGreaterThanOrEqual(43);
    expect(a.transient.nonce.length).toBeGreaterThanOrEqual(43);
  });

  it("persists the transient (state/nonce/verifier/createdAt) to the store", async () => {
    const store = memStore();
    const { transient } = await beginLogin(discovery, config, store, { now: () => 1000 });
    const saved = JSON.parse(store.getItem("oidc:transient")!);
    expect(saved).toEqual({
      state: transient.state,
      nonce: transient.nonce,
      verifier: transient.verifier,
      createdAt: 1000,
    });
  });
});
