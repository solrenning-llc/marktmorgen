/** next/navigation for tests/studio-today-trips.test.ts: a redirect or a not-found is thrown, so the test sees it. */
export function notFound(): never {
  throw new Error("NOT_FOUND");
}
export function redirect(to: string): never {
  throw new Error(`REDIRECT ${to}`);
}
export function permanentRedirect(to: string): never {
  throw new Error(`REDIRECT ${to}`);
}
export function useRouter() {
  return {};
}
export function usePathname() {
  return "/";
}
export function useSearchParams() {
  return new URLSearchParams();
}
