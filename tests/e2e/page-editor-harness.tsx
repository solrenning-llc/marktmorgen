/**
 * The page editor alone in a browser page, for tests/e2e/page-editor-actions.mjs
 * (AX274, AAA review of #2904): the real component (components/page-editor.tsx)
 * with a synthetic page and a stand-in for every request it makes, kept in the
 * page. A request is held, never answered, unless a check answers it, so an
 * upload can be left "being sent". Nothing leaves the page: no server, no
 * store, no real person.
 */
import { createRoot } from "react-dom/client";
import { PageEditor } from "@/components/page-editor";
import { DEFAULT_LOOK } from "@/lib/store-look";
import { EMPTY_PAGE, type PageBlock, emptyBlock } from "@/lib/sales-page";

type Held = { url: string; answer: (status: number, body: unknown) => void };
type Harness = { mount: (blocks: PageBlock[]) => void; block: typeof emptyBlock; held: Held[] };

/** The page's own handle on the harness, read by tests/e2e/page-editor-actions.mjs as window.harness. */
const page = window as unknown as Window & { harness: Harness };
const held: Held[] = [];

// Every request is held until a check answers it (or never), so nothing is sent and a send can stay pending.
window.fetch = ((input: string | URL | Request) =>
  new Promise<Response>((resolve) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    held.push({ url, answer: (status, body) => resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) });
  })) as typeof fetch;

const root = createRoot(document.getElementById("root")!);
let mounted = 0;
page.harness = {
  held,
  block: emptyBlock,
  mount(blocks) {
    root.render(
      <PageEditor
        key={++mounted}
        product={{ id: "prodsynthetic01", title: "Synthetic Guide", summary: "A synthetic product", free: false, pill: "", picture: null, defaultLabel: "Buy now", leadsTo: "the checkout" }}
        initial={{ ...EMPTY_PAGE, blocks }}
        about=""
        look={{ ...DEFAULT_LOOK }}
        storeName="Synthetic Studio"
        photo={null}
        pageHref="/@synthetic/synthetic-guide"
        nextOptions={[]}
        summary={null}
        folder="0123456789abcdef01234567"
      />,
    );
  },
};
