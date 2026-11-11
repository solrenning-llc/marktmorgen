/**
 * Revisor 2's LOW on #3508 (26 [E9]): the month's AI allowance is one number for the store, so an explanation asked
 * under one funnel must lower the count under every funnel on the page at once, not only its own (the count was kept
 * per funnel and stayed old under the others). The real PageFunnelEditor, through tests/client-hooks.ts; synthetic
 * funnels only.
 */
import { PageFunnelEditor, type SavedFunnel } from "@/components/page-funnel-editor";
import { FunnelSharingReview } from "@/components/funnel-sharing-review";
import { find, mount } from "./client-hooks";
import { done, is, part } from "./check";

type Explain = { funnelId: string; left: number | null; onLeft?: (left: number) => void } | null | undefined;
const funnel = (id: string): SavedFunnel => ({
  funnel: { id, name: `Funnel ${id}`, slug: `go-${id}`, steps: [{ kind: "page", id: "home" }], on: true, since: 1 },
  steps: [{ title: "Home", open: true, why: "", free: false, product: false, seen: 0, done: 0 }],
  pageIssues: [{ code: "disabled", title: "The funnel address is disabled", detail: "Review its settings." }],
});
const explains = (tree: unknown): Explain[] => find(tree, (n) => n.type === FunnelSharingReview).map((n) => n.props?.explain as Explain);

async function main() {
part("One allowance for every funnel on the page");
const props = { saved: [funnel("aaaaaaaaaa"), funnel("bbbbbbbbbb")], choices: [{ kind: "page" as const, id: "home", title: "Home", note: "" }], base: "https://example.test", ai: { on: true, left: 5 } };
const view = await mount(PageFunnelEditor as (p: typeof props) => unknown, props);
const before = explains(view.tree());
is("both funnels start from the page's count", before.map((e) => e?.left), [5, 5]);
before[0]?.onLeft?.(4);
await view.settle();
is("an explanation under the first lowers the count under the second too", explains(view.tree()).map((e) => e?.left), [4, 4]);
view.unmount();

const unread = await mount(PageFunnelEditor as (p: typeof props) => unknown, { ...props, ai: { on: true, left: null } as never });
is("an allowance that could not be read stays unknown under every funnel", explains(unread.tree()).map((e) => e?.left), [null, null]);
unread.unmount();
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
