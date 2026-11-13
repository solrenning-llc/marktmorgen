/**
 * Cloud I's MEDIUM on #3441: "Use this idea" fills the product's name and
 * short description with the model's words, and the form saved them with no
 * AI-draft review (756 [STN3]) and with checks left from another draft. The
 * ideas box (components/product-ideas.tsx) now draws the review, the badge
 * and its three checks, under an idea it used, tells the form its checks
 * afresh (onReviewChange) so the save is held until they are checked, and on
 * "Put back what you had" tells it null, so the form puts back the checks it
 * had before. The box's real code runs under tests/client-hooks.ts with a
 * stand-in fetch; nothing real is sent. The form's wiring is read from its
 * source.
 */
import { readFileSync } from "node:fs";
import { ProductIdeas } from "@/components/product-ideas";
import { AiDraftReview } from "@/components/ai-draft-review";
import { AiOn } from "@/components/ai-assist";
import { IDEAS_COPY } from "@/lib/product-ideas-rules";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

(globalThis as Record<string, unknown>).document = { getElementById: () => null };

const idea = (title: string) => ({ title, who: "Home bakers who want a calm first loaf.", why: "The store already teaches sourdough." });
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ ok: true, value: { ideas: [idea("Starter Care Guide")] }, left: 10 }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

const label = (n: Node) => texts(n.props?.children).join("");
const button = (tree: unknown, starts: string) => find(tree, (n) => n.type === "button" && label(n).startsWith(starts))[0] as Node | undefined;
const click = (node: Node | undefined) => (node?.props?.onClick as (() => unknown) | undefined)?.();
const review = (tree: unknown) => find(tree, (n) => n.type === AiDraftReview)[0]?.props as { checks?: boolean[]; onToggle?: (i: number, t: boolean) => void } | undefined;

async function main(): Promise<void> {
  part("An idea used is drawn with the AI-draft review, and the form is told its checks afresh");
  const told: (boolean[] | null)[] = [];
  const box = await mount(
    ProductIdeas,
    { title: "Rye for beginners", summary: "My own words.", titleFieldId: "product-title-1", onUse: () => {}, onReviewChange: (checks: boolean[] | null) => told.push(checks) },
    new Map([[AiOn, { on: true, left: 10 }]]),
  );
  click(button(box.tree(), IDEAS_COPY.ask));
  await box.settle();
  is("no review before an idea is used", review(box.tree()), undefined);
  click(button(box.tree(), IDEAS_COPY.use));
  await box.settle();
  is("the review is drawn under the idea used, its three boxes unchecked", review(box.tree())?.checks, [false, false, false]);
  is("the form is told the checks afresh, so its save is held", told.at(-1), [false, false, false]);
  review(box.tree())?.onToggle?.(0, true);
  await box.settle();
  is("a box checked is told to the form", told.at(-1), [true, false, false]);
  click(button(box.tree(), IDEAS_COPY.undo));
  await box.settle();
  is("put back: the review goes", review(box.tree()), undefined);
  is("and the form is told null, to put back its own checks", told.at(-1), null);
  box.unmount();

  part("The product form passes the checks on to its save hold");
  const form = readFileSync("components/product-editor.tsx", "utf8");
  is("the form gives the ideas box onReviewChange", /<ProductIdeas[\s\S]{0,400}onReviewChange=/.test(form), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
