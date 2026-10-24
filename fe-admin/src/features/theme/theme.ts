export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = "theme";
const ONE_YEAR = 60 * 60 * 24 * 365;

/** Whitelist: any other cookie value (tampered, stale) falls back to "system". */
export function parseTheme(value: unknown): Theme {
  return THEMES.find((t) => t === value) ?? "system";
}

/** Class for <html>: none for "system" (CSS follows prefers-color-scheme). */
export function themeClass(theme: Theme): string | undefined {
  return theme === "system" ? undefined : theme;
}

/**
 * UI preference cookie written by JS (`theme`, `sidebar_state`): never HttpOnly (JS writes it, no
 * secret, the server whitelists the value), always SameSite=Lax, Secure when the page is https.
 */
export function writePrefCookie(name: string, value: string, maxAgeSec: number) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`;
}

export function persistTheme(theme: Theme) {
  writePrefCookie(THEME_COOKIE, theme, ONE_YEAR);
}
