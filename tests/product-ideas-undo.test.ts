/**
 * "Put back what you had" in the product ideas box (758 [STN5] unit 2;
 * components/product-ideas.tsx), run as the creator uses it: the box's real
 * code runs under tests/client-hooks.ts with `fetch` replaced by a stand-in.
 * Nothing real is sent. What is checked: once an idea has filled the form,
 * asking for new ideas keeps the undo, and the undo still puts back what the
 * name and short description held before the first idea was used.
 */
import { ProductIdeas } from "@/components/product-ideas";
import { AiOn } from "@/components/ai-assist";
import { IDEAS_COPY } from "@/lib/product-ideas-rules";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

// The one browser object the box reads; the in-memory hook runner draws nothing.
(globalThis as Record<string, unknown>).document = { getElementById: () => null };

const idea = (title: string) => ({ title, who: "Home bakers who want a calm first loaf.", why: "The store already teaches sourdough." });
let answer: unknown = { ok: true, value: { ideas: [idea("Starter Care Guide"), idea("Weekend Bake Plan")] }, left: 10 };
globalThis.fetch = (async () => new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

const label = (n: Node) => texts(n.props?.children).join("");
const button = (tree: unknown, starts: string) => find(tree, (n) => n.type === "button" && label(n).startsWith(starts))[0] as Node | undefined;
const click = (node: Node | undefined) => (node?.props?.onClick as (() => unknown) | undefined)?.();

async function main(): Promise<void> {
  part("The undo outlives a new request for ideas");
  const used: { title: string; summary: string }[] = [];
  const box = await mount(ProductIdeas, { title: "Rye for beginners", summary: "My own words.", titleFieldId: "product-title-1", onUse: (next) => used.push(next) }, new Map([[AiOn, { on: true, left: 10 }]]));
  click(button(box.tree(), IDEAS_COPY.ask));
  await box.settle();
  click(button(box.tree(), IDEAS_COPY.use));
  await box.settle();
  is("an idea fills the form", used.at(-1)?.title, "Starter Care Guide");
  is("the undo is offered", Boolean(button(box.tree(), IDEAS_COPY.undo)), true);
  answer = { ok: true, value: { ideas: [idea("Shaping Lessons")] }, left: 9 };
  click(button(box.tree(), IDEAS_COPY.ask));
  await box.settle();
  is("new ideas came", Boolean(find(box.tree(), (n) => n.type === "h4" && label(n) === "Shaping Lessons").length), true);
  is("the undo is still offered", Boolean(button(box.tree(), IDEAS_COPY.undo)), true);
  click(button(box.tree(), IDEAS_COPY.undo));
  await box.settle();
  is("and it puts back what the boxes held before the first idea", used.at(-1), { title: "Rye for beginners", summary: "My own words." });
  is("then it is gone", button(box.tree(), IDEAS_COPY.undo), undefined);
  box.unmount();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
