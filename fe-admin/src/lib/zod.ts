import { z } from "zod";

// A7 (DEBT-364/366): zod 4 decides whether to JIT-compile an object parser when the schema is
// BUILT (`z.object(...)`), by probing `new Function("")`. The strict CSP (no 'unsafe-eval') blocks
// the probe and the browser reports a violation. Jitless mode skips the probe (same results,
// interpreted parsing). Every app module imports `z` from here (ESLint forbids "zod" elsewhere in
// src), so ESM evaluation order runs this config before any schema is built, whatever the chunking.
z.config({ jitless: true });

export { z };
