// @vitest-environment node
// Tester (run 25): replay / degenerate-callback cases for the lab callback branch (F2, consume-once).
import { describe, it, expect } from "vitest";
import { beginLogin } from "../src/oidc/authorize";
import { readTransient } from "../src/oidc/transient";
import {
  LAB_RESULT_KEY,
  TAMPERED_STATE,
  findLabScenario,
  recordLabCallback,
  takeLabResult,
  takeStateTamperExpectation,
  tamperState,
} from "../src/oidc/lab";
import { CLIENT_ID, ISSUER, REDIRECT_URI, discovery, memStore } from "./helpers/env";

const CONFIG = {
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  scope: "openid offline_access",
  resource: `${ISSUER}/demo/`,
};

async function startLab(id: string) {
  const store = memStore();
  const s = findLabScenario(id);
  if (!s) throw new Error(id);
  const { transient } = await beginLogin(discovery, { ...CONFIG, purpose: "lab", labScenario: id }, store);
  return { store, state: transient.state };
}

describe("lab callback replay (consume-once, tester run 25)", () => {
  it("replaying the same lab callback records nothing the second time and keeps the first verdict", async () => {
    const { store, state } = await startLab("pkce-plain");
    const params = new URLSearchParams({ error: "invalid_request", state, iss: ISSUER });
    expect(recordLabCallback(params, ISSUER, store)?.pass).toBe(true);
    const first = store.getItem(LAB_RESULT_KEY);

    // Replay (back button / re-opened link): transient already consumed ⇒ nothing recorded.
    expect(recordLabCallback(params, ISSUER, store)).toBeNull();
    expect(store.getItem(LAB_RESULT_KEY)).toBe(first);
    expect(readTransient(store)).toBeNull();
  });

  it("matching state + iss but neither error nor code ⇒ 'rejected', never PASS", async () => {
    const { store, state } = await startLab("pkce-plain");
    const r = recordLabCallback(new URLSearchParams({ state, iss: ISSUER }), ISSUER, store);
    expect(r).toMatchObject({ outcome: "rejected", pass: false });
    const shown = takeLabResult(store);
    expect(shown?.pass).toBe(false);
  });

  it("no-nonce: code with matching state but missing iss ⇒ FAIL (iss mandatory for green)", async () => {
    const { store, state } = await startLab("no-nonce");
    const r = recordLabCallback(new URLSearchParams({ code: "c", state }), ISSUER, store);
    expect(r).toMatchObject({ outcome: "code", issOk: false, pass: false });
  });

  it("tamper flag is one-shot: a second forged-state callback is not treated as the lab check", () => {
    const store = memStore();
    tamperState("http://idp.test/authorize?state=genuine", store);
    const forged = new URLSearchParams({ code: "c", state: TAMPERED_STATE });
    expect(takeStateTamperExpectation(forged, store)).toBe(true);
    expect(takeStateTamperExpectation(forged, store)).toBe(false);
  });
});
