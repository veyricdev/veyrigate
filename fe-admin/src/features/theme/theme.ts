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

export function persistTheme(theme: Theme) {
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax`;
}
