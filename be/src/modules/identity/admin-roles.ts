export const ADMIN_ROLE_VALUES = ['tenant_admin', 'super_admin'] as const;
export type AdminRole = (typeof ADMIN_ROLE_VALUES)[number];
