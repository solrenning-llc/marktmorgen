/** next/navigation for the help pages drawn in tests/help-pages.test.ts: notFound throws as Next's does, and a router that goes nowhere. */
export class NotFoundError extends Error {}
export const notFound = (): never => {
  throw new NotFoundError("not found");
};
export const useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} });
export const usePathname = () => "/help";
export const useSearchParams = () => new URLSearchParams();
export const redirect = (to: string): never => {
  throw new Error(`redirect to ${to}`);
};
