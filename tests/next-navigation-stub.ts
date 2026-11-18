/** next/navigation for a client component drawn on the server in a test: a router that goes nowhere. */
// A server module reached from a page under test may import redirect (lib/studio-route.ts): the synthetic one, which throws.
export { redirect } from "./studio-today-navigation";
export const useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} });
export const usePathname = () => "/studio/deals";
export const useSearchParams = () => new URLSearchParams();
