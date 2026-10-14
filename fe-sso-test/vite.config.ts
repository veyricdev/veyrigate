/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SPA public client for OIDC manual-client testing (plan T1/T2).
// Dev server pinned to :5173 with strictPort so redirect_uri/CORS stay exact.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    // Default DOM env for component/router tests; crypto/jose specs opt into node
    // via a per-file `// @vitest-environment node` pragma (avoids Uint8Array realm
    // mismatch between the faked DOM and Node WebCrypto).
    environment: "happy-dom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
