/** The only session data the browser ever receives (no token, no session id). */
export interface Viewer {
  sub: string;
  email: string | null;
  roles: string[];
  tenantId: string;
}

/** UI gate only: the admin API stays the enforcement point. */
export const isAdmin = (viewer: Viewer) =>
  viewer.roles.includes("super_admin") || viewer.roles.includes("tenant_admin");
