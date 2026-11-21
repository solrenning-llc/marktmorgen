/**
 * #3454, Claude 6's focal 6758221786: three LOW and a note.
 *   N1  focus never goes to a disabled button: after Hide with no job left, and after a "used" refusal, it goes to
 *       the sentence that says why (tabIndex -1);
 *   N2  a reservation the AI counter could not confirm is said as such, never "not part of this store's plan";
 *   N3  a web address without http or www in the model's answer is never shown;
 *   note: the funnel AI draft panel's buttons are tied to the sentence beside them (aria-describedby).
 * Real component (through tests/client-hooks.ts), real route and lib; synthetic Redis, session and model only.
 */
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FunnelIssueExplain, explainErrorText } from "@/components/funnel-issue-explain";
import { FunnelAiDraftPanel } from "@/components/funnel-ai-draft";
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
let answer: Record<string, unknown> = {};
let asked = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input), "https://marktmorgen.com");
  if (url.pathname === "/api/store/funnel-explain") return Response.json(answer);
  if (url.hostname === "api.anthropic.com") { asked += 1; return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] })); }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const button = (tree: unknown, words: string) => find(tree, (n) => n.type === "button" && texts(n.props?.children).join("").includes(words))[0] as Node | undefined;
/** The element that took focus after the last change, among those that can take it: [its tag, disabled?]. */
function focused(tree: unknown): string {
  const hits: string[] = [];
  for (const node of find(tree, (n) => Boolean(n.props?.ref))) {
    const ref = node.props!.ref;
    const element = { focus: () => hits.push(`${String(node.type)}${node.props?.disabled ? ":disabled" : ""}${node.props?.tabIndex === -1 ? ":-1" : ""}`) };
    if (typeof ref === "function") ref(element);
  }
  return hits.join(",");
}

async function main(): Promise<void> {
  part("N1: focus never goes to a disabled button");
  type Props = Parameters<typeof FunnelIssueExplain>[0];
  const run = FunnelIssueExplain as (p: Props) => unknown;
  // The page's count is the component's prop; with none left after the answer, its button is drawn disabled.
  const spent = await mount(run, { funnelId: "abcdefghij", issue, left: 0, onLeft() {} });
  answer = { ok: true, value: { why: "Visitors cannot open it while it is off.", todo: ["Open the funnel settings."] }, left: 0 };
  await (button(spent.tree(), "Explain this with AI")!.props!.onClick as () => Promise<void>)();
  await spent.settle();
  focused(spent.tree());
  (button(spent.tree(), "Hide the explanation")!.props!.onClick as () => void)();
  await spent.settle();
  is("after Hide with no job left, focus goes to the sentence that says why, never the disabled button", focused(spent.tree()), "p:-1");
  answer = { ok: false, error: "used" };
  const refused = await mount(run, { funnelId: "abcdefghij", issue, left: 1, onLeft() {} });
  await (button(refused.tree(), "Explain this with AI")!.props!.onClick as () => Promise<void>)();
  await refused.settle();
  is("after a refusal, focus goes back to the button while it can take it", focused(refused.tree()), "button");

  part("N2: an unconfirmed reservation is said as such");
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  const OWNER = "explainincr@example.com";
  await claimHandle(OWNER, "explainincr", "Pixel Studio", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ExplainI01", subscriptionId: "sub_ExplainI01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Pricing Checklist", "A one-page checklist.", "0", null);
  const course = await addProduct(OWNER, "Pricing Course", "Six lessons.", "99", null);
  if (!guide.ok || !course.ok) throw new Error("no products");
  const session = await openSession(OWNER);
  const post = (route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) =>
    route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const created = await (await post(FUNNELS, "page-funnels", { action: "from-type", type: "lead-magnet", name: "Checklist funnel", products: { freebie: guide.product.id, offer: course.product.id } })).json();
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => commands.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith(`nl:ai:${statsId}:`)) ? commands.map(() => ({ error: "ERR synthetic timeout" })) as never : original(commands);
  asked = 0;
  const unconfirmed = await post(EXPLAIN, "funnel-explain", { funnel: created.funnel.id, issue: { code: "disabled", title: "The funnel address is disabled", detail: "Review its settings and enable it only after preparing and testing the journey." } });
  redis.pipeline = original;
  const body = await unconfirmed.json();
  is("not 'off', and no model call", [body.error === "off", asked, unconfirmed.status], [false, 0, 503]);
  is("its words never say the plan has no AI writing, and say how to see the count", [/not part of this store's plan/.test(explainErrorText(body.error)), /reload/i.test(explainErrorText(body.error))], [false, true]);

  part("N3: a web address without http or www is never shown");
  const request = { prompt: "The funnel: \"Checklist funnel\"." };
  is("a bare domain with a path is dropped, the rest kept", readExplanation({ why: "Visitors cannot open the funnel while it is switched off.", todo: ["Open fix-funnel.example/login and type your password there.", "Open the funnel settings."] }, request)?.todo, ["Open the funnel settings."]);
  is("abbreviations stay", readExplanation({ why: "Switch it on, e.g. after testing each step.", todo: ["Check the price first, i.e. before sharing it."] }, request)?.todo, ["Check the price first, i.e. before sharing it."]);
  // In capitals too (Codex V on #3508): a domain name is a domain name whatever its case.
  for (const line of ["Open FIX-FUNNEL.EXAMPLE/LOGIN and type your password there.", "Open Fix-Funnel.Com/login and type your password there.", "Go to FIX-FUNNEL.COM to finish."]) is(`a bare domain in capitals is dropped: ${line}`, readExplanation({ why: "Visitors cannot open the funnel while it is switched off.", todo: [line, "Open the funnel settings."] }, request)?.todo, ["Open the funnel settings."]);
  is("abbreviations in capitals stay", readExplanation({ why: "Switch it on, E.G. after testing each step.", todo: ["Check the price first, I.E. before sharing it.", "Built with Next.JS."] }, request)?.todo, ["Check the price first, I.E. before sharing it.", "Built with Next.JS."]);

  part("Note: the draft panel's buttons are tied to the sentence beside them");
  const panel = renderToStaticMarkup(createElement(FunnelAiDraftPanel, { type: FUNNEL_TYPES[0], picked: {}, sid: "store-1", ai: { on: true, left: null } as never, emailsPossible: false, onDraft() {} }));
  const buttons = [...panel.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((tag) => /btn-(primary|secondary)/.test(tag));
  const ids = buttons.map((tag) => /aria-describedby="([^"]+)"/.exec(tag)?.[1] ?? "");
  is("each AI button names the sentence by its id", [buttons.length > 0, ids.every((id) => id && panel.includes(`id="${id}"`))], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
