/**
 * The signed-in community visitor for tests/places-totals-unknown.test.ts, which renders the real event pages: the
 * test says who is looking (`lookAs`), and the page reads that member as `communityVisitor` would have, with the
 * community's real settings. Also stands in for next/headers, whose cookies the pages hand to it. Synthetic only.
 */
import { readConfig } from "@/lib/community";
import type { Viewer } from "@/lib/community-access";
import type { Store } from "@/lib/store";

const slot = globalThis as unknown as { __placesViewer?: { key: string; owner: boolean; email: string } };

/** Who the next page is drawn for. */
export function lookAs(viewer: { key: string; owner: boolean; email: string }): void {
  slot.__placesViewer = viewer;
}

export async function communityVisitor(store: Store): Promise<Viewer> {
  const who = slot.__placesViewer;
  const config = store.community ? await readConfig(store.community.id) : null;
  if (!who || !config) return { state: "off" };
  return { state: "in", config, email: who.email, key: who.key, owner: who.owner, member: null, canWrite: true };
}

export async function cookies(): Promise<{ get: () => undefined }> {
  return { get: () => undefined };
}

export async function headers(): Promise<Headers> {
  return new Headers();
}

/** next/navigation, outside an app router: a page that would leave or be missing throws, as Next's own do. */
export function notFound(): never {
  throw new Error("NEXT_NOT_FOUND");
}
export function redirect(to: string): never {
  throw new Error(`NEXT_REDIRECT ${to}`);
}
export function useRouter(): { refresh: () => void; push: (to: string) => void; replace: (to: string) => void } {
  return { refresh: () => {}, push: () => {}, replace: () => {} };
}
export function usePathname(): string {
  return "/";
}
export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}
