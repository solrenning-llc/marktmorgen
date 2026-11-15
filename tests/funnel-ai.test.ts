/**
 * A whole funnel drafted with AI (lib/funnel-ai.ts, lib/funnel-ai-rules.ts),
 * through the studio's own routes. The model is played by a stand-in for
 * `fetch`; the AI spending policy is the approving test double every writing
 * test uses (tests/ai-spend-regression-stub.ts), so this checks what the
 * feature does with admission, not the ledger itself. What is checked:
 *
 *   - its weight is the requests' bounds, said before it runs, and taken
 *     from the month's jobs before any request: refused without enough
 *     left, kept when an attempt fails, never charged for a refusal;
 *   - it drafts from the store's own records, into the guided setup's own
 *     structures: invented numbers removed, offers only from the store's
 *     products, links only the store's, subscription left to the visitor;
 *   - the research cites only the store's dated records and drops what they
 *     do not hold, and says it searched nothing on the web;
 *   - the setup saves the drafted blocks into hidden pages, and a page still
 *     holding a part ⟦like this⟧ cannot be shown to visitors.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { aiAllowance, aiLeft, aiMonthKey } from "@/lib/ai";
import { POST as AI } from "@/app/api/store/ai/route";
import { POST as FUNNELS } from "@/app/api/store/page-funnels/route";
import { POST as SITE_PAGE } from "@/app/api/store/site-page/route";
import { FUNNEL_TYPES, funnelType } from "@/lib/funnel-types";
import { readPage } from "@/lib/sales-page-store";
import { siteKey } from "@/lib/site-page-rules";
import { MAX_FLOW_NAME } from "@/lib/flows";
import {
  FUNNEL_AI_CALLS,
  FUNNEL_RESEARCH_JOBS,
  followUpMoment,
  funnelDiagnostics,
  funnelDraftJobs,
  isFunnelAiDraft,
  isFunnelResearch,
  jobsForCall,
  knownNumbers,
  readFunnelBlockCopy,
  readResearch,
  withoutInventedNumbers,
} from "@/lib/funnel-ai-rules";
import { type FunnelFacts, writeFunnelDraft } from "@/lib/funnel-ai";
import { SEQUENCE_NAME_MAX, readMailSaveError, sequenceFlowFrom } from "@/lib/funnel-ai-sequence";
import { productLink } from "@/lib/checkout-recovery";
import { WRITING_JOB_MICRO_USD, WRITING_JOB_REFERENCE, aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const asked: { system: string; content: string; max: number }[] = [];
const replies: { pages: string; emails: string; research: string; status: number } = { pages: "{}", emails: "{}", research: "{}", status: 200 };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  const body = JSON.parse(String(init?.body)) as { system: string; max_tokens: number; messages: { content: string }[] };
  asked.push({ system: body.system, content: body.messages[0].content, max: body.max_tokens });
  if (replies.status !== 200) return new Response("overloaded", { status: replies.status });
  const text = body.system.includes("emails that go out by themselves") ? replies.emails : body.system.includes("You summarize who") ? replies.research : replies.pages;
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;

  part("Its weight is its requests' bounds, said before it runs");
  is("a request is weighed by its spending hold against the priced writing job, rounded up", [
    jobsForCall({ outputTokens: WRITING_JOB_REFERENCE.shape.maxTokens, inputBytes: WRITING_JOB_REFERENCE.shape.inputBytes }),
    jobsForCall({ outputTokens: WRITING_JOB_REFERENCE.shape.maxTokens + 1, inputBytes: WRITING_JOB_REFERENCE.shape.inputBytes }),
    jobsForCall({ outputTokens: 100, inputBytes: 100 }),
    Number.isNaN(jobsForCall({ outputTokens: 0, inputBytes: 1 })),
  ], [1, 2, 1, true]);
  is("the weight covers the hold askModel reserves", Object.values(FUNNEL_AI_CALLS).every((call) => jobsForCall(call) * WRITING_JOB_MICRO_USD >= aiRequestHoldMicroUsd(WRITING_JOB_REFERENCE.model, { inputBytes: call.inputBytes, blocks: 1, media: null, maxTokens: call.outputTokens })!), true);
  is("the draft: pages 2, emails 1; the research 1", [funnelDraftJobs(false), funnelDraftJobs(true), FUNNEL_RESEARCH_JOBS], [2, 3, 1]);
  is("every request stays inside the central request limits", Object.values(FUNNEL_AI_CALLS).every((call) => call.outputTokens <= 6_000 && call.inputBytes <= 65_536), true);

  part("Honesty checks");
  const known = knownNumbers("Course: $99.00", "6 lessons");
  is("a price's whole units count as given", [known.has("99"), known.has("9900"), known.has("6")], [true, true, true]);
  is("a sentence with a number nobody gave goes, whole", withoutInventedNumbers("Six lessons, $99. Join 5,000 students. Start today.", known), "Six lessons, $99. Start today.");
  is("numbers in a placeholder or an address are not claims", withoutInventedNumbers("⟦Add your 10 years⟧ here.\nhttps://marktmorgen.com/@a/p/x123", known), "⟦Add your 10 years⟧ here.\nhttps://marktmorgen.com/@a/p/x123");
  const lead = funnelType("lead-magnet")!;
  const apply = funnelType("application")!;
  is("block copy only where the page has that block", [
    JSON.stringify(readFunnelBlockCopy({ thanks: { sub: "Next", steps: { heading: "Next", items: [{ title: "Check your inbox", detail: "" }] }, cta: "Go" } }, lead)),
    readFunnelBlockCopy({ thanks: { faq: [{ q: "Q", a: "A" }] } }, lead),
    readFunnelBlockCopy({ thanks: { cta: "⟦Write it⟧" } }, lead),
    readFunnelBlockCopy({ thanks: { sub: "x".repeat(301) } }, lead),
    readFunnelBlockCopy({ nope: {} }, lead),
    JSON.stringify(readFunnelBlockCopy(undefined, lead)),
  ], [JSON.stringify({ thanks: { sub: "Next", steps: { heading: "Next", items: [{ title: "Check your inbox", detail: "" }] }, cta: "Go" } }), null, null, null, null, "{}"]);
  is("the follow-up starts where the journey gives an address", FUNNEL_TYPES.map((type) => [type.id, followUpMoment(type, Object.fromEntries(type.slots.map((slot) => [slot.key, "id-" + slot.key])))?.trigger ?? null]), [["lead-magnet", "product"], ["training", "product"], ["challenge", "product"], ["launch", "product"], ["book", "product"], ["first-purchase", "product"], ["application", "form"], ["quiz", "form"], ["bundle", "product"]]);
  is("a small sample is said to be one; a larger one is counted, not explained", funnelDiagnostics({ proof: "", products: [{ title: "A", described: false, draft: true, free: false, views: 4, checkouts: 0 }, { title: "B", described: true, draft: false, free: false, views: 120, checkouts: 6 }], unanswered: 2 }).map((d) => d.code), ["no_proof", "thin_product", "draft_product", "small_sample", "traffic", "unanswered"]);

  part("Drafting a funnel");
  const OWNER = "aifunnel@example.com";
  await claimHandle(OWNER, "aifunnel", "Pixel Studio", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_AiFunnel01", subscriptionId: "sub_AiFunnel01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Pricing Checklist", "A one-page checklist for pricing design work.", "0", null);
  const course = await addProduct(OWNER, "Pricing Course", "Six lessons on pricing and pitching.", "99", null);
  const extra = await addProduct(OWNER, "Proposal Templates", "Three proposal templates.", "19", null);
  if (!guide.ok || !course.ok || !extra.ok) throw new Error("no products");
  const session = await openSession(OWNER);
  const post = (route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) =>
    route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const products = { freebie: guide.product.id, offer: course.product.id };
  let store = (await storeForEmail(OWNER))!;
  const start = await aiLeft(store);

  const wrong = await (await post(AI, "ai", { kind: "funnel", type: "lead-magnet", products: { freebie: course.product.id, offer: guide.product.id }, audience: "Designers" })).json();
  is("a product that does not fit its step is refused before anything is counted or asked", [wrong.error, asked.length, await aiLeft(store)], ["slot_free", 0, start]);

  replies.pages = `Here it is:\n${JSON.stringify({
    pages: {
      thanks: {
        headline: "You're in: check your inbox",
        intro: "Your checklist is on its way. ⟦Add one sentence about who you are⟧\nJoin 5,000 designers who priced better.",
        sub: "The checklist and the course, step by step.",
        steps: { heading: "What happens next", items: [{ title: "Open the email", detail: "It has your checklist." }, { title: "Rated 4.9 by 300 buyers", detail: "" }] },
        cta: "See the course for $99",
        faq: [{ q: "Not on this page", a: "Dropped" }],
      },
      nowhere: { headline: "Unknown page" },
    },
    offers: [
      { kind: "bump", for: course.product.id, offer: extra.product.id, why: "Templates to send with the prices from the course." },
      { kind: "after", for: guide.product.id, offer: extra.product.id, why: "A free product cannot be followed by a paid offer." },
      { kind: "bump", for: course.product.id, offer: "invented", why: "Not a product." },
    ],
    missing: ["Add a picture of the checklist."],
  })}`;
  replies.emails = JSON.stringify({ emails: [
    { waitDays: 0, subject: "Your checklist", body: `Here it is.\n\n${productLink(store, guide.product.id)}\n\nhttps://evil.example.com/steal\n\nPixel` },
    { waitDays: 2, subject: "How to use it", body: "Start with the first line. 87% of designers skip it." },
    { waitDays: 3, subject: "The course", body: `The Pricing Course is $99.\n\n${productLink(store, course.product.id)}` },
  ] });
  const drafted = await (await post(AI, "ai", { kind: "funnel", type: "lead-magnet", products, audience: "New freelance designers", offer: "A checklist, then a course", proof: "", notes: "", emails: true })).json();
  store = (await storeForEmail(OWNER))!;
  if (!drafted.ok) throw new Error(`no draft: ${JSON.stringify(drafted)}`);
  const value = drafted.value;
  is("two requests, at their bounds, and three of the month's jobs taken", [asked.length, asked.map((a) => a.max).sort(), drafted.left, await aiLeft(store)], [2, [3_000, 4_500], start - 3, start - 3]);
  is("the result is the shape the studio checks before using any of it", isFunnelAiDraft(value, lead), true);
  is("drafted from the store's own records, with the rules said in full", [asked[0].content.includes("Six lessons on pricing and pitching."), asked[0].content.includes("Price: $99"), asked[0].system.includes("write no proof at all"), asked[0].system.includes("American English")], [true, true, true, true]);
  is("an invented number is removed with its sentence; a placeholder is kept for the creator", value.pageCopy.thanks.intro, "Your checklist is on its way. ⟦Add one sentence about who you are⟧");
  is("block copy only for the page's own blocks, and no price in the button", [value.blockCopy.thanks.sub, value.blockCopy.thanks.steps.items.map((i: { title: string }) => i.title), value.blockCopy.thanks.cta, "faq" in value.blockCopy.thanks, "nowhere" in value.pageCopy], ["The checklist and the course, step by step.", ["Open the email"], "See the course", false, false]);
  is("offers only from the store's products, after a paid one-off step", value.offers.map((o: { kind: string; for: string; offer: string }) => [o.kind, o.for, o.offer]), [["bump", course.product.id, extra.product.id]]);
  is("the follow-up starts on the free product, with only the store's links and no invented numbers", [value.sequence.trigger, value.sequence.productId, value.sequence.steps.length, value.sequence.steps[0].body.includes("evil.example.com"), value.sequence.steps[0].body.includes(productLink(store, guide.product.id)), value.sequence.steps[1].body], ["product", guide.product.id, 3, false, true, "Start with the first line."]);
  is("what only the creator can add is listed, and what the records show", [value.missing, value.diagnostics.map((d: { code: string }) => d.code)], [["Add a picture of the checklist."], ["no_proof", "small_sample", "small_sample"]]);

  part("Admission");
  asked.length = 0;
  redis.run(["SET", aiMonthKey(store, new Date())!, aiAllowance(store) - 2]);
  const short = await (await post(AI, "ai", { kind: "funnel", type: "lead-magnet", products, audience: "Designers", emails: true })).json();
  is("not enough uses left for its weight: refused before any request", [short.error, asked.length, await aiLeft(store)], ["used", 0, 2]);
  const enough = await (await post(AI, "ai", { kind: "funnel", type: "lead-magnet", products, audience: "Designers", emails: false })).json();
  is("without the emails it weighs two, and fits", [enough.ok, asked.length, await aiLeft(store)], [true, 1, 0]);
  redis.run(["SET", aiMonthKey(store, new Date())!, 0]);
  asked.length = 0;
  replies.status = 500;
  const failed = await (await post(AI, "ai", { kind: "funnel", type: "lead-magnet", products, audience: "Designers", emails: true })).json();
  is("a provider failure keeps every started job counted", [failed.error, asked.length, await aiLeft(store)], ["failed", 2, aiAllowance(store) - 3]);
  replies.status = 200;
  const facts: FunnelFacts = { type: lead, picked: products, products: [], candidates: [], unanswered: Array.from({ length: 100 }, (_, i) => ({ productId: course.product.id, question: `Question ${i} ${"q".repeat(190)}`, at: 0 })), storeLink: "https://marktmorgen.com/@aifunnel", creator: "Pixel", storeName: "Pixel Studio" };
  const before = await aiLeft(store);
  asked.length = 0;
  const long = await writeFunnelDraft(store, facts, { audience: "Designers", offer: "", proof: "", notes: "" }, false);
  is("a request longer than its bound is refused before it is counted or sent", [long.ok ? "ran" : long.reason, asked.length, await aiLeft(store)], ["long", 0, before]);

  part("Research from the store's own records");
  asked.length = 0;
  replies.research = JSON.stringify({
    audience: "New freelance designers who want to price their work. The market is worth $4 billion.",
    positioning: "A checklist first, then a course on pricing and pitching.",
    claims: [
      { text: "The course has six lessons on pricing and pitching.", source: "P2" },
      { text: "It costs $99.", source: "P2" },
      { text: "It sold 1,200 copies.", source: "P2" },
      { text: "Competitors charge more.", source: "W1" },
    ],
    uncertainty: ["Only two products have descriptions."],
  });
  const researched = await (await post(AI, "ai", { kind: "funnel-research", type: "lead-magnet", products, audience: "New freelance designers" })).json();
  if (!researched.ok) throw new Error(`no research: ${JSON.stringify(researched)}`);
  const r = researched.value;
  is("one request, one of the month's jobs, no web search", [asked.length, isFunnelResearch(r), r.webSearch, researched.left], [1, true, false, before - 1]);
  is("a sentence with a number no source holds is dropped", r.audience, "New freelance designers who want to price their work.");
  is("claims kept only where their own source holds them", r.claims.map((c: { text: string; source: string }) => [c.text, c.source]), [["The course has six lessons on pricing and pitching.", "P2"], ["It costs $99.", "P2"]]);
  is("every source is the store's, dated by the store", r.sources.map((s: { id: string; date: string }) => [s.id, /^\d{4}-\d{2}-\d{2}$/.test(s.date)]), [["A1", true], ["P1", true], ["T1", true], ["P2", true], ["T2", true]]);
  is("it says what it cannot tell, first in the store's own words", [r.uncertainty[0].startsWith("Only your store's own records"), r.uncertainty.includes("Only two products have descriptions.")], [true, true]);
  is("an unreadable answer is not shown", readResearch(null, [], []), null);

  part("Created from the draft");
  const created = await (await post(FUNNELS, "page-funnels", { action: "from-type", type: "lead-magnet", name: "Checklist funnel", products, pageCopy: value.pageCopy, formDrafts: value.formDrafts, blockCopy: value.blockCopy })).json();
  store = (await storeForEmail(OWNER))!;
  const page = await readPage(store.statsId, siteKey(created.pages[0].id));
  const kinds = page.blocks.map((b) => b.kind);
  const hero = page.blocks[0];
  const steps = page.blocks.find((b) => b.kind === "steps");
  const cta = page.blocks.find((b) => b.kind === "cta");
  is("saved into the hidden page's own blocks, the funnel disabled", [created.ok, created.funnel.on, page.hidden, kinds, hero.kind === "hero" ? hero.sub : "", steps?.kind === "steps" ? steps.items.length : 0, cta?.kind === "cta" ? cta.label : ""], [true, false, true, ["hero", "text", "steps", "cta"], "The checklist and the course, step by step.", 1, "See the course"]);
  const badBlocks = await (await post(FUNNELS, "page-funnels", { action: "from-type", type: "lead-magnet", name: "Bad", products, blockCopy: { thanks: { faq: [{ q: "Q", a: "A" }] } } })).json();
  is("drafted blocks a page does not have are refused before anything is made", [badBlocks.error, (await storeForEmail(OWNER))!.sitePages.length], ["page_copy", 1]);

  const shown = await (await post(SITE_PAGE, "site-page", { action: "save", id: created.pages[0].id, page: { ...page, hidden: false } })).json();
  is("a page still holding a part ⟦like this⟧ cannot be shown to visitors", shown.error, "placeholder");
  const scheduled = await (await post(SITE_PAGE, "site-page", { action: "save", id: created.pages[0].id, page: { ...page, hidden: true, showFrom: Math.floor(Date.now() / 1000) + 3_600 } })).json();
  is("nor scheduled to show by itself", scheduled.error, "placeholder");
  const kept = await (await post(SITE_PAGE, "site-page", { action: "save", id: created.pages[0].id, page: { ...page, hidden: true } })).json();
  is("kept hidden, it saves", kept.ok, true);
  const written = { ...page, hidden: false, blocks: page.blocks.map((b) => (b.kind === "text" ? { ...b, body: "Your checklist is on its way. I have priced design work since 2019." } : b)) };
  const out = await (await post(SITE_PAGE, "site-page", { action: "save", id: created.pages[0].id, page: written })).json();
  is("once replaced, it can be shown", out.ok, true);

  const application = await (await post(FUNNELS, "page-funnels", { action: "from-type", type: "application", name: "Apply", products: {} })).json();
  is("the setup says which form each page made", [Object.keys(application.forms), /^[a-z0-9]{10}$/.test(application.forms.apply)], [["apply"], true]);

  part("The follow-up, saved switched off through the Email Studio");
  is("a sequence's name fits the Email Studio's", SEQUENCE_NAME_MAX, MAX_FLOW_NAME);
  const flow = sequenceFlowFrom(value.sequence, "Checklist funnel", created);
  is("named after the funnel, started by the free product, switched off", [flow?.name, flow?.trigger, flow?.productId, flow?.active, flow?.steps.length], ["Follow-up: Checklist funnel", "product", guide.product.id, false, 3]);
  const formFlow = sequenceFlowFrom({ trigger: "form", productId: null, formSlot: "apply", steps: value.sequence.steps }, "Apply", application);
  is("a form's sequence names the form the setup confirmed, and none without it", [formFlow?.formId === application.forms.apply, sequenceFlowFrom({ trigger: "form", productId: null, formSlot: "apply", steps: [] }, "Apply", { ok: true })], [true, null]);
  is("only a complete confirmation is a save", [readMailSaveError(true, { ok: true, flows: [] }), readMailSaveError(false, { ok: false, error: "placeholder" }).includes("⟦like this⟧"), readMailSaveError(true, {}).includes("could not be confirmed")], ["saved", true, true]);
  is("the drafted application form leaves subscribing to the visitor", isFunnelAiDraft({ ...value, type: "application", pageCopy: {}, blockCopy: {}, formDrafts: { apply: { fields: [{ type: "email", label: "Email", required: true }], offerList: true } }, sequence: null }, apply), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
