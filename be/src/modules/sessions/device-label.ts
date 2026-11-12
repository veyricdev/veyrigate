/**
 * Device label of a session (run 88, D88.17): "<Browser> on <OS>", built ONLY from allowlisted
 * names, so the raw User-Agent is never stored nor shown. Order matters: Edge/Opera carry `Chrome/`,
 * Chrome carries `Safari/`, iOS carries `Mac OS X`, Android carries `Linux`.
 */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];
const OSES: [RegExp, string][] = [
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\b(Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];
/** Real User-Agents stay far below this; longer input is cut before any regex runs. */
const MAX_UA = 512;

const pick = (ua: string, table: [RegExp, string][]): string =>
  table.find(([re]) => re.test(ua))?.[1] ?? 'Other';

export function deviceLabelFromUserAgent(userAgent: unknown): string {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, MAX_UA) : '';
  return `${pick(ua, BROWSERS)} on ${pick(ua, OSES)}`;
}
