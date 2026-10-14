import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const rootEl = document.getElementById("root")!;

/**
 * Validate env at startup so a missing/invalid `.env` shows a readable message instead of a
 * blank screen. The router (and the whole env-dependent module graph) is imported DYNAMICALLY
 * inside the try: that way `env.app`'s eager `parseEnv` runs here and any throw is caught and
 * rendered, instead of crashing during the static import phase.
 */
async function bootstrap() {
  try {
    await import("./env.app"); // eager env validation (throws on bad/missing .env)
    const { RouterProvider } = await import("react-router");
    const { router } = await import("./router");
    createRoot(rootEl).render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rootEl.innerHTML = "";
    const pre = document.createElement("pre");
    pre.setAttribute("role", "alert");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.color = "#b00020";
    pre.textContent = message;
    rootEl.append(pre);
  }
}

void bootstrap();
