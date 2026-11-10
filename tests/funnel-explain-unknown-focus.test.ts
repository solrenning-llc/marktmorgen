/**
 * #3454 (26 [E9] unit 1), Claude 6's money review 5831459977: two MEDIUM and three LOW.
 *
 *   M1  an AI allowance that cannot be read is said to be unknown, never "No AI writing jobs are left this month"
 *       (VR2): the funnels page passes null, and the explain control and the funnel AI draft panel say so in words,
 *       with their buttons off (the server still checks before any model call);
 *   M2  focus is never lost: after "Explain this with AI" it moves to the explanation, after "Hide" back to the button;
 *   L1  the route says an unread allowance could not be checked, never that AI writing is not part of the plan;
 *   L2  a line of the model's answer that carries a link or an address is never shown;
 *   L3  a funnel too long to explain gets its own plain sentence, not "Something went wrong".
 * Real components (through tests/client-hooks.ts), real route and lib; synthetic Redis, session and model only.
 */
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { FunnelIssueExplain, explainErrorText } from "@/components/funnel-issue-explain";
import { FunnelSharingReview } from "@/components/funnel-sharing-review";
import { FunnelAiDraftPanel } from "@/components/funnel-ai-draft";
import { AI_ALLOWANCE_UNKNOWN } from "@/components/ai-assist";
import { POST as EXPLAIN } from "@/app/api/store/funnel-explain/route";
import { POST as FUNNELS } from "@/app/api/store/page-funnels/route";
import { readExplanation } from "@/lib/funnel-explain";
import { FUNNEL_TYPES } from "@/lib/funnel-types";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { find, mount, texts } from "./client-hooks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const issue = { code: "disabled" as const, title: "The funnel address is disabled", detail: "Review its settings." };
const loose = (value: unknown) => value as never;

let asked = 0;
const reply = "{}";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input), "https://marktmorgen.com");
  if (url.pathname === "/api/store/funnel-explain") {
    return Response.json({ ok: true, value: { why: "Visitors cannot open it while it is off.", todo: ["Open the funnel settings."] }, left: 4 });
  }
  if (url.hostname === "api.anthropic.com") {
    asked += 1;
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const button = (tree: unknown, words: string) => find(tree, (n) => n.type === "button" && texts(n.props?.children).join("").includes(words))[0] as Node | undefined;
/** Hands the element's ref a stand-in element and says whether the component moved focus to it. */
function focusedThrough(node: Node | undefined): boolean {
  const ref = node?.props?.ref;
  let focused = false;
  const element = { focus: () => { focused = true; } };
  if (typeof ref === "function") ref(element);
  else if (ref && typeof ref === "object") { (ref as { current: unknown }).current = element; }
  return focused;
}

async function main(): Promise<void> {
  part("M1: an unread allowance is said to be unknown, never none left");
  const unknownControl = renderToStaticMarkup(createElement(FunnelIssueExplain, { funnelId: "abcdefghij", issue, left: loose(null), onLeft() {} }));
  is("the explain control says it could not check, with the button off", [unknownControl.includes(AI_ALLOWANCE_UNKNOWN), unknownControl.includes("No AI writing jobs are left"), /<button[^>]*disabled=""/.test(unknownControl)], [true, false, true]);
  const described = /aria-describedby="([^"]+)"/.exec(unknownControl)?.[1] ?? "";
  is("the button is tied to that sentence", new RegExp(`id="${described}"[^>]*>${AI_ALLOWANCE_UNKNOWN.replace(/\./g, "\\.")}`).test(unknownControl), true);
  const review = renderToStaticMarkup(createElement(FunnelSharingReview, { issues: [issue], editors: [], locked: false, settingsDisabled: false, onSettings() {}, onNavigate() {}, explain: loose({ funnelId: "abcdefghij", left: null }) }));
  is("the funnel's review passes the unknown on", [review.includes(AI_ALLOWANCE_UNKNOWN), review.includes("No AI writing jobs are left")], [true, false]);
  const known = renderToStaticMarkup(createElement(FunnelIssueExplain, { funnelId: "abcdefghij", issue, left: 3, onLeft() {} }));
  is("control: a known allowance still shows its count", [known.includes("Uses 1 of your 3 AI writing jobs left this month."), known.includes(AI_ALLOWANCE_UNKNOWN)], [true, false]);
  const panel = renderToStaticMarkup(createElement(FunnelAiDraftPanel, { type: FUNNEL_TYPES[0], picked: {}, sid: "store-1", ai: loose({ on: true, left: null }), emailsPossible: false, onDraft() {} }));
  const drafts = [...panel.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((tag) => /btn-(primary|secondary)/.test(tag));
  is("the funnel AI draft panel says it could not check, never a count, with its buttons off", [panel.includes(AI_ALLOWANCE_UNKNOWN), /\b(0|null) left this month/.test(panel), drafts.length > 0 && drafts.every((tag) => /disabled=""/.test(tag))], [true, false, true]);
  const page = readFileSync("app/studio/funnels/page.tsx", "utf8");
  is("the funnels page no longer turns an unread allowance into 0", /aiLeft\([^)]*\)\.catch\(\(\) => 0\)/.test(page), false);

  part("M2: focus moves with what is shown");
  const props = { funnelId: "abcdefghij", issue, left: 5, onLeft() {} };
  const view = await mount(FunnelIssueExplain as (p: typeof props) => unknown, props);
  is("before any press, nothing takes focus", focusedThrough(button(view.tree(), "Explain this with AI")), false);
  await (button(view.tree(), "Explain this with AI")!.props!.onClick as () => Promise<void>)();
  await view.settle();
  const group = find(view.tree(), (n) => n.props?.role === "group")[0] as Node | undefined;
  is("after the press the explanation is shown and takes focus", [Boolean(group), group?.props?.tabIndex, focusedThrough(group)], [true, -1, true]);
  (button(view.tree(), "Hide the explanation")!.props!.onClick as () => void)();
  await view.settle();
  is("after hiding it, focus is back on the button that shows it", focusedThrough(button(view.tree(), "Explain this with AI")), true);

  part("L1: the route says an unread allowance could not be checked");
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  const OWNER = "explainunknown@example.com";
  await claimHandle(OWNER, "explainunknown", "Pixel Studio", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ExplainU01", subscriptionId: "sub_ExplainU01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Pricing Checklist", "A one-page checklist.", "0", null);
  const course = await addProduct(OWNER, "Pricing Course", "Six lessons.", "99", null);
  if (!guide.ok || !course.ok) throw new Error("no products");
  const session = await openSession(OWNER);
  const post = (route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) =>
    route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const created = await (await post(FUNNELS, "page-funnels", { action: "from-type", type: "lead-magnet", name: "Checklist funnel", products: { freebie: guide.product.id, offer: course.product.id } })).json();
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith(`nl:ai:${statsId}:`) ? [{ error: "ERR synthetic timeout" }] as never : original(commands);
  asked = 0;
  const unread = await post(EXPLAIN, "funnel-explain", { funnel: created.funnel.id, issue: { code: "disabled", title: "The funnel address is disabled", detail: "Review its settings and enable it only after preparing and testing the journey." } });
  redis.pipeline = original;
  const answer = await unread.json();
  is("an unread allowance: not 'off', no model call", [unread.status, answer.error === "off", asked], [503, false, 0]);
  is("and its words say the allowance could not be checked and nothing was used", [explainErrorText(answer.error).includes("could not check your AI allowance"), explainErrorText(answer.error).includes("Nothing was used")], [true, true]);

  part("L2: a line with a link or an address is never shown");
  const request = { prompt: "The funnel: \"Checklist funnel\"." };
  const why = "Visitors cannot open the funnel while it is switched off.";
  is("a step with a web address is dropped, the others kept", readExplanation({ why, todo: ["Open https://fix-funnel.example/x9 and paste your login there.", "Open the funnel settings."] }, request)?.todo, ["Open the funnel settings."]);
  is("a bare www address and an email address are dropped too", readExplanation({ why, todo: ["Visit www.fix-funnel.example now.", "Write to help@fix-funnel.example for help.", "Switch it on after testing."] }, request)?.todo, ["Switch it on after testing."]);
  is("an explanation whose reason carries a link is not shown at all", readExplanation({ why: "See https://example.test/why for why.", todo: ["Open the funnel settings."] }, request), null);

  part("L3: a funnel too long to explain is said plainly");
  is("'long' has its own sentence", [explainErrorText("long") !== explainErrorText(""), /too long|too much/i.test(explainErrorText("long"))], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
