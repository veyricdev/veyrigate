import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

export const ADMIN_OPENAPI_PATH = '/openapi/admin.json';

/**
 * Whether the admin OpenAPI JSON is served (Q-27.1). Raw `NODE_ENV` allowlist, same fail-closed
 * shape as `isDemoEnabled`: only `development`/`test`; `production` or unset => no route (404).
 */
export function isAdminOpenApiEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

const ADMIN_PATH = /^\/admin(\/|$)/;

/** Keep only `/admin/*` operations and the component schemas they (transitively) reference. */
export function adminOnly(doc: OpenAPIObject): OpenAPIObject {
  const paths = Object.fromEntries(Object.entries(doc.paths).filter(([p]) => ADMIN_PATH.test(p)));
  const all = doc.components?.schemas ?? {};
  const keep = new Set<string>();
  const queue = [JSON.stringify(paths)];
  while (queue.length) {
    for (const [, name] of queue.pop()!.matchAll(/#\/components\/schemas\/([^"]+)/g)) {
      if (!keep.has(name) && all[name]) {
        keep.add(name);
        queue.push(JSON.stringify(all[name]));
      }
    }
  }
  const schemas = Object.fromEntries(Object.entries(all).filter(([name]) => keep.has(name)));
  return { ...doc, paths, components: { ...doc.components, schemas } };
}

/**
 * Register `GET /openapi/admin.json` (JSON only, no Swagger UI, not under `/admin` so it is never
 * mistaken for a guarded route). Shared by `main.ts` and the integration bootstrap so the wiring
 * under test is the production one. Must run before the app is initialised/listening.
 * Returns whether the route was registered.
 */
export function registerAdminOpenApi(app: INestApplication, env: NodeJS.ProcessEnv): boolean {
  if (!isAdminOpenApiEnabled(env)) return false;
  const config = new DocumentBuilder()
    .setTitle('Veyrigate admin API')
    .setVersion('1')
    .addBearerAuth()
    .build();
  const doc = adminOnly(SwaggerModule.createDocument(app, config));
  const fastify = app.getHttpAdapter().getInstance() as {
    get(path: string, handler: (req: unknown, reply: AdminDocReply) => unknown): unknown;
  };
  fastify.get(ADMIN_OPENAPI_PATH, (_req, reply) =>
    reply.header('Cache-Control', 'no-store').send(doc),
  );
  return true;
}

interface AdminDocReply {
  header(name: string, value: string): AdminDocReply;
  send(payload: unknown): unknown;
}
