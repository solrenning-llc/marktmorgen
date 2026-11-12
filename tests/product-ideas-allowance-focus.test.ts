/**
 * Cloud I's two LOWs on #3441 (comment 6807013617), in the ideas box (components/product-ideas.tsx):
 *   1. a "failed" answer counts the job, yet the box kept showing the allowance it had before ("1 left this month")
 *      as known: it is now shown as unknown until the next answer says it;
 *   2. the Ask button was `disabled` while asking (and once nothing was left), which drops keyboard focus to the
 *      page's body (WCAG 2.4.3): it is now `aria-disabled`, and a press while it is says nothing and asks nothing.
 * The box's real code runs under tests/client-hooks.ts with a stand-in fetch; nothing real is sent.
 */
import { ProductIdeas } from "@/components/product-ideas";
import { AiOn } from "@/components/ai-assist";
import { IDEAS_COPY } from "@/lib/product-ideas-rules";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
(globalThis as Record<string, unknown>).document ??= { getElementById: () => null };

let asked = 0;
let answer: () => Promise<Response> = async () => new Response("{}");
globalThis.fetch = (async () => {
  asked += 1;
  return answer();
}) as typeof fetch;

const label = (n: Node) => texts(n.props?.children).join("");
const askButton = (tree: unknown) => find(tree, (n: Node) => n.type === "button" && [IDEAS_COPY.ask, IDEAS_COPY.asking].includes(label(n)))[0] as Node | undefined;
const shown = (tree: unknown) => texts(tree).join(" ");
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

async function box(left: number) {
  return mount(
    ProductIdeas,
    { title: "", summary: "", titleFieldId: "product-title-1", onUse: () => {} },
    new Map([[AiOn, { on: true, left }]]),
  );
}

async function main(): Promise<void> {
  part("LOW 1: a failed answer leaves the allowance unknown");
  let b = await box(1);
  is("before asking, the allowance is said", shown(b.tree()).includes(`1 ${IDEAS_COPY.allowance}`), true);
  answer = async () => json({ ok: false, error: "failed" });
  (askButton(b.tree())?.props?.onClick as () => void)();
  await b.settle();
  is("the failure is said", shown(b.tree()).includes(IDEAS_COPY.failed), true);
  is("and the allowance is no longer shown as known", [shown(b.tree()).includes(`1 ${IDEAS_COPY.allowance}`), shown(b.tree()).includes(IDEAS_COPY.unknownAllowance)], [false, true]);
  b.unmount();

  part("LOW 2: the Ask button keeps the focus while it waits");
  b = await box(3);
  asked = 0;
  let release: () => void = () => {};
  answer = () => new Promise((resolve) => {
    release = () => resolve(json({ ok: false, error: "slow" }));
  });
  (askButton(b.tree())?.props?.onClick as () => void)();
  await b.settle();
  const waiting = askButton(b.tree())?.props ?? {};
  is("while asking, it is never `disabled` (focus stays on it), but says it is not available", [waiting.disabled === true, waiting["aria-disabled"]], [false, true]);
  (waiting.onClick as () => void)();
  await b.settle();
  is("a second press while asking asks nothing", asked, 1);
  release();
  await b.settle();
  b.unmount();

  part("Nothing left: not available, never `disabled`, and a press asks nothing");
  b = await box(0);
  asked = 0;
  const none = askButton(b.tree())?.props ?? {};
  is("aria-disabled, not disabled", [none.disabled === true, none["aria-disabled"]], [false, true]);
  (none.onClick as () => void)();
  await b.settle();
  is("pressed: nothing asked", asked, 0);
  b.unmount();

  part("Control: with an allowance and nothing running, it can be pressed");
  b = await box(2);
  is("not marked as unavailable", askButton(b.tree())?.props?.["aria-disabled"], false);
  b.unmount();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
