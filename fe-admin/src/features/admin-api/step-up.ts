import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "@/lib/zod";
import { isSigningOut } from "./query-client";

/**
 * Step-up round-trip without losing the form (plan A5 / D3, run 43 F3). The draft lives in this
 * tab's `sessionStorage`, not in Redis: the step-up callback always issues a NEW session id.
 *
 * Rules: one intent per tab (`fea:stepup`), single use (read => removed, even when refused), 10 min
 * (the login transaction TTL), bound to action + path + the viewer's `sub`. The payload is parsed
 * by the form's zod schema on save (allowlist: unknown fields such as a secret are dropped) and
 * again on restore (the stored value is untrusted). Never store a secret, a token or server data.
 * Restoring never submits: the user reviews and submits again.
 */
const KEY = "fea:stepup";
const TTL_MS = 10 * 60_000;

const StoredIntent = z.object({
  v: z.literal(1),
  action: z.string(),
  path: z.string(),
  sub: z.string(),
  payload: z.unknown(),
  exp: z.number(),
});

export interface StepUpIntent {
  /** What the form was doing, e.g. `client.update`. */
  action: string;
  /** Page to come back to (pathname + search). */
  path: string;
  /** The viewer who started it. */
  sub: string;
  payload: unknown;
}

/** Stores the allowlisted draft; false when it is invalid or storage is blocked. */
export function saveIntent(schema: z.ZodType, intent: StepUpIntent): boolean {
  clearIntent(); // an older unused draft must never outlive a newer one that failed (DEBT-299)
  const payload = schema.safeParse(intent.payload);
  if (!payload.success) return false;
  const { action, path, sub } = intent;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ v: 1, action, path, sub, payload: payload.data, exp: Date.now() + TTL_MS }));
    return true;
  } catch {
    return false;
  }
}

/** The draft for this form, page and viewer (once), else null. Call once per mount. */
export function takeIntent<S extends z.ZodType>(schema: S, action: string, path: string, sub: string): z.infer<S> | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let stored;
  try {
    stored = StoredIntent.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!stored.success) return null;
  const s = stored.data;
  const now = Date.now();
  if (s.exp <= now || s.exp > now + TTL_MS || s.action !== action || s.path !== path || s.sub !== sub) return null;
  const payload = schema.safeParse(s.payload);
  return payload.success ? payload.data : null;
}

/**
 * {@link takeIntent} for a form: read once after mount (null until then, or when there is none).
 * Never call `takeIntent` in a `useState` initializer: StrictMode runs it twice and the second
 * call gets null. The ref survives StrictMode's effect re-run, so the draft is taken only once.
 */
export function useStepUpDraft<S extends z.ZodType>(schema: S, action: string, path: string, sub: string): z.infer<S> | null {
  const [draft, setDraft] = useState<z.infer<S> | null>(null);
  const taken = useRef(false);
  useEffect(() => {
    if (taken.current) return;
    taken.current = true;
    setDraft(takeIntent(schema, action, path, sub));
  }, [schema, action, path, sub]);
  return draft;
}

/** Drops any pending draft (sign-out). */
export function clearIntent(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // storage blocked: nothing stored either
  }
}

/** `step_up_required`: keep the draft, then re-authenticate (`prompt=login&max_age=0`) and come back. */
export function startStepUp(schema: z.ZodType, intent: StepUpIntent): void {
  if (isSigningOut()) return; // the logout POST must not be replaced, nor a draft kept after it
  if (!saveIntent(schema, intent)) {
    toast.warning("Your changes could not be kept. Please enter them again after confirming your identity.");
  }
  reauthenticate(intent.path);
}

/** Re-authenticate (`prompt=login&max_age=0`) and come back to `path`; stores nothing. */
export function reauthenticate(path: string): void {
  if (isSigningOut()) return;
  location.assign(`/auth/login?stepup=1&returnTo=${encodeURIComponent(path)}`);
}
