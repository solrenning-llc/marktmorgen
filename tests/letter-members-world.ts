/**
 * Stand-ins for tests/letter-members.test.ts (wired in tests/test-config.mjs):
 * the request's cookies, so a store's email page can be drawn outside a
 * request, and the store's tracking, an async part the static renderer
 * cannot draw and which is not what is checked there.
 */
export const cookieValues = new Map<string, string>();
export async function cookies() {
  return { get: (name: string) => (cookieValues.has(name) ? { name, value: cookieValues.get(name)! } : undefined) };
}
export async function headers() {
  return new Headers();
}
export function StoreTracking(): null {
  return null;
}
