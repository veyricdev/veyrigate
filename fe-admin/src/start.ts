import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { toPublicError } from "@/server/errors";

// Server functions are same-origin RPC endpoints: refuse cross-site calls.
const csrfMiddleware = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

// DEBT-275: an unintended error in any server function (SSR call or /_serverFn RPC) is logged with
// a request id and replaced by a fixed message before it is serialised to the browser.
const serverFnErrorBoundary = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    const { error, status } = toPublicError("server function", err);
    if (status) setResponseStatus(status);
    throw error;
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [serverFnErrorBoundary],
}));
