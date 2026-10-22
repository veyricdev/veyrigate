import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Admin BFF (plan A1). Dev server pinned to :3000 with strictPort: the seeded fe-admin client's
// redirect_uri is http://localhost:3000/..., so a silent port fallback would break login.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 3000, strictPort: true },
  preview: { port: 3000, strictPort: true },
  plugins: [tailwindcss(), tanstackStart(), react()],
});
