/** next/navigation for the takedown page drawn on the server in tests/uncertain-send-rights-takedown.test.ts. */
export { usePathname, useRouter, useSearchParams } from "./next-navigation-stub";
export function notFound(): never {
  throw new Error("notFound (test)");
}
