export function safeReturnTo(value: unknown, issuer: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\r\n]|%0d|%0a/i.test(value)
  )
    return '/';
  try {
    return new URL(value, issuer).origin === new URL(issuer).origin ? value : '/';
  } catch {
    return '/';
  }
}
