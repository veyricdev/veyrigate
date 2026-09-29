import type Redis from 'ioredis';

/**
 * Lua script registration framework (B1.4).
 *
 * Registers named Lua scripts as custom ioredis commands via `defineCommand`,
 * so callers invoke them like `redis.myScript(keys..., args...)` with EVALSHA
 * caching handled by ioredis.
 *
 * The concrete atomic scripts (bind+consume authorization code, refresh-token
 * rotation) are added in B4.3 / B4.5 — this loader only provides the wiring.
 */
export interface LuaScriptDef {
  /** Command name exposed on the client (e.g. `consumeAuthCode`). */
  name: string;
  /** Number of KEYS the script expects. Omit for a dynamic count passed as the first call argument. */
  numberOfKeys?: number;
  /** The Lua source. */
  lua: string;
}

export function loadLuaScripts(client: Redis, scripts: readonly LuaScriptDef[]): void {
  for (const script of scripts) {
    client.defineCommand(script.name, {
      numberOfKeys: script.numberOfKeys,
      lua: script.lua,
    });
  }
}
