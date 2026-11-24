/**
 * #5285 row #3454: the findings of #3454's reviews that were still in main after it merged (Claude 3's check,
 * 7103254701), each with a check that fails before its fix:
 *   LOW 3 (Claude 1)  an answer that predicts a result in words ("This can double your sales.") was shown; only
 *                     digits were caught (the fix stayed on the side branch claude3/keep/h-3454);
 *   LOW 2 (Claude 1)  names were cut by characters, not bytes, so emoji step names pushed a request whose ASCII
 *                     twin fits over the 8,192-byte input bound, and it was refused as "long";
 *   N4 (Claude 6)     the two focus targets with tabIndex -1 (the answer group, the cost sentence) got only the
 *                     browser's default ring, not the site's (WCAG 2.4.7, 2.4.13);
 *   NIT (Claude 6)    `after` repeated the arithmetic of the two onLeft calls under it: the count a refusal leaves
 *                     is now computed once, and the calls and the focus follow it unchanged.
 * Real component (through tests/client-hooks.ts) and lib; synthetic fetch only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FunnelIssueExplain } from "@/components/funnel-issue-explain";
import { FUNNEL_EXPLAIN_CALL, MAX_EXPLAIN_STEPS, MAX_STEP_NAME, explainFits, explainRequest, quoted, readExplanation } from "@/lib/funnel-explain";
import type { FunnelLaunchIssue, FunnelLaunchStep } from "@/lib/funnel-launch-review";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

const disabled: FunnelLaunchIssue = { code: "disabled", title: "The funnel address is disabled", detail: "Review its settings and enable it only after preparing and testing the journey." };
const steps = [{ title: "Free checklist", open: false, why: "This page is kept back.", product: false, free: false }] as FunnelLaunchStep[];
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

let answer: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input), "https://marktmorgen.com");
  if (url.pathname === "/api/store/funnel-explain") return Response.json(answer);
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const button = (tree: unknown, words: string) => find(tree, (n) => n.type === "button" && texts(n.props?.children).join("").includes(words))[0] as Node | undefined;
const classOf = (tree: unknown, test: (n: Node) => boolean) => String((find(tree, (n) => test(n as Node))[0] as Node | undefined)?.props?.className ?? "");
/** The site's ring (app/globals.css): 3px of --focus, 3px off the box. */
const RING = ["focus:outline-3", "focus:outline-offset-3", "focus:outline-(--focus)"];

async function main(): Promise<void> {
  part("LOW 3: an answer that predicts a result in words is never shown");
  const plain = explainRequest(disabled, "Funnel", steps);
  is("control: a plain answer is kept", readExplanation({ why: "Visitors cannot open it while it is off.", todo: ["Open settings."] }, plain) !== null, true);
  for (const why of ["This can double your sales.", "Turning it on will triple your revenue.", "This is guaranteed to work.", "It can multiply your conversions.", "Fixing it guarantees more buyers."]) {
    is(`never shown: ${why}`, readExplanation({ why, todo: ["Open settings."] }, plain), null);
  }
  is("nor in a step", readExplanation({ why: "Visitors cannot open it.", todo: ["Turn it on to double your sign-ups."] }, plain), null);
  is("control: 'double-check' is advice, not a prediction", readExplanation({ why: "Visitors cannot open it while it is off.", todo: ["Double-check the address, then turn it on."] }, plain) !== null, true);

  part("LOW 2: names are bounded in bytes, so emoji names fit where their ASCII twins fit");
  const many = (title: string) => Array.from({ length: MAX_EXPLAIN_STEPS + 3 }, () => ({ title, open: true, why: "", product: true, free: false })) as FunnelLaunchStep[];
  const long = { ...disabled, detail: "d".repeat(1_000) };
  is("control: the ASCII worst case fits", explainFits(explainRequest(long, "n".repeat(500), many("s".repeat(500)))), true);
  // A three-byte character is one UTF-16 unit, so a cut by characters let each name hold three times its bound.
  for (const wide of ["🚀", "漢", "✓"]) {
    const request = explainRequest({ ...disabled, title: wide.repeat(400), detail: wide.repeat(1_000) }, wide.repeat(500), many(wide.repeat(500)));
    is(`the ${wide} worst case fits too (it is not refused as long)`, [explainFits(request), bytes(request.system) + bytes(request.prompt) <= FUNNEL_EXPLAIN_CALL.inputBytes], [true, true]);
  }
  is("a quoted name holds at most its bound in UTF-8 bytes, plus its two quotes", bytes(quoted("🚀".repeat(500), MAX_STEP_NAME)), MAX_STEP_NAME - (MAX_STEP_NAME % 4) + 2);
  is("a name is never cut inside a character (no lone surrogate)", /[\ud800-\udfff]/.test(quoted(`a${"🚀".repeat(100)}`, MAX_STEP_NAME).replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")), false);
  is("control: an ASCII name is cut where it was before", quoted("x".repeat(500), MAX_STEP_NAME), `"${"x".repeat(MAX_STEP_NAME)}"`);
  is("control: accented letters keep whole", quoted("é".repeat(200), 9), `"${"é".repeat(4)}"`);

  part("N4: the two tabIndex -1 targets get the site's focus ring");
  type Props = Parameters<typeof FunnelIssueExplain>[0];
  const run = FunnelIssueExplain as (p: Props) => unknown;
  const first = renderToStaticMarkup(createElement(FunnelIssueExplain, { funnelId: "abcdefghij", issue: disabled, left: 3, onLeft() {} }));
  const cost = first.match(/<p tabindex="-1"[^>]*class="([^"]*)"/)?.[1] ?? "";
  is("the cost sentence carries the ring", RING.filter((c) => !cost.split(" ").includes(c)), []);
  const shown = await mount(run, { funnelId: "abcdefghij", issue: disabled, left: 3, onLeft() {} });
  answer = { ok: true, value: { why: "Visitors cannot open it while it is off.", todo: ["Open the funnel settings."] }, left: 2 };
  await (button(shown.tree(), "Explain this with AI")!.props!.onClick as () => Promise<void>)();
  await shown.settle();
  const group = classOf(shown.tree(), (n) => n.props?.role === "group" && n.props?.tabIndex === -1);
  is("control: the answer group is drawn", group.length > 0, true);
  is("the answer group carries the ring", RING.filter((c) => !group.split(" ").includes(c)), []);

  part("NIT: a refusal's count is computed once; the calls to onLeft are unchanged");
  for (const [reason, left, calls] of [
    ["used", 3, [0]],
    ["used", null, [0]],
    ["failed", 3, [2]],
    ["failed", null, []],
    ["stale", 3, []],
    ["unconfirmed", 2, []],
  ] as const) {
    const seen: number[] = [];
    const view = await mount(run, { funnelId: "abcdefghij", issue: disabled, left, onLeft: (n: number) => seen.push(n) });
    answer = { ok: false, error: reason };
    await (button(view.tree(), "Explain this with AI")?.props?.onClick as (() => Promise<void>) | undefined)?.();
    await view.settle();
    is(`${reason} with ${left} left calls onLeft with ${JSON.stringify(calls)}`, seen, [...calls]);
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
