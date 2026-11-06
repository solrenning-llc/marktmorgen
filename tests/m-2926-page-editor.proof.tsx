/**
 * Prepared, NOT EXECUTED: review #2926, public PageEditor + actual React DOM.
 * PicturesEditor is private. This proof does not extract, export, copy or simulate it.
 * Head: 2e070b21ddd995c669d7cf0f8a07846475ca43df.
 * Base: 98c47cbccd75e0d97f748983842c164f3352c6a0.
 * A caller must supply real, synthetic PageEditor props, with one pictures block
 * holding one existing picture. No guessed StoreLook or replacement business logic.
 */
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PageEditor } from "@/components/page-editor";
import { DEFAULT_LOOK } from "@/lib/store-look";
import { EMPTY_PAGE } from "@/lib/sales-page";

type Props = Parameters<typeof PageEditor>[0];
// Defaults are actual public exports, not a reconstructed StoreLook. Concrete
// synthetic values follow Picture and PageEditor props; typecheck is pending GO.
export const fixture = {
  product: { id: "m2926-product", title: "Local focus review", summary: "Synthetic fixture", free: false, pill: "", picture: null, defaultLabel: "Open", leadsTo: "Local review" },
  initial: { ...EMPTY_PAGE, blocks: [{ id: "m2926-pictures", kind: "pictures", heading: "Review pictures", items: [{ path: "images/0123456789abcdef01234567/0123456789abcdef0123456789abcdef.jpg", width: 1, height: 1, alt: "Synthetic existing picture", caption: "" }] }] },
  about: "", look: { ...DEFAULT_LOOK }, storeName: "Synthetic local review", photo: null,
  pageHref: "/local-review", nextOptions: [], summary: null, folder: "0123456789abcdef01234567",
  site: { id: "m2926-site", kinds: ["pictures"] },
} satisfies Props;
let root: Root | null = null;
let navigationCalls = 0;

// Use Next's real context seam, rather than replacing useRouter or the editor.
const router = {
  bfcacheId: "m-2926-local-review",
  back() { navigationCalls += 1; }, forward() { navigationCalls += 1; },
  push() { navigationCalls += 1; }, replace() { navigationCalls += 1; },
  refresh() { navigationCalls += 1; }, prefetch: async () => {},
};

async function unmount(): Promise<void> {
  if (root) flushSync(() => root?.unmount());
  root = null;
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

async function mount(props: Props = fixture): Promise<void> {
  await unmount();
  if (!props.site || props.initial.blocks.length !== 1 || props.initial.blocks[0].kind !== "pictures" || props.initial.blocks[0].items.length !== 1) {
    throw new Error("Fixture must be a synthetic site PageEditor with one pictures block and one existing picture");
  }
  const container = document.getElementById("app");
  if (!container) throw new Error("Missing browser mount point");
  navigationCalls = 0;
  root = createRoot(container);
  flushSync(() => root?.render(
    <AppRouterContext.Provider value={router}>
      <PageEditor {...props} />
    </AppRouterContext.Provider>,
  ));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

declare global {
  interface Window {
    m2926: { mount: typeof mount; unmount: typeof unmount; navigationCalls: () => number };
  }
}
window.m2926 = { mount, unmount, navigationCalls: () => navigationCalls };
