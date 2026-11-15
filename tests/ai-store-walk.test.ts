/**
 * 219 [OP5], unit 8, first part: the AI store draft, measured.
 *
 * A signed-in creator with a store walks the real routes of the studio's
 * "Draft your store with AI" card, on the in-memory Redis, with the model
 * simulated (nothing real is called):
 *
 *   1. describes what they make and for whom (POST /api/store/ai, kind setup);
 *   2. keeps what they chose (POST /api/store/setup).
 *
 * Each step is one action of the person; a field counts as required when the
 * route refuses the same request without it. The choices on the review screen
 * between the two steps are counted from the draft itself: one line under the
 * name, keep or not for each product drafted, keep or not for the questions.
 * After step 2 the route answers what is still missing before anything can
 * sell (unit 7). What was measured is compared with the record in
 * docs/ai-store-builder.md, so the record cannot drift from the code.
 *
 * It does not measure a person's time (item 202). The plan here is a synthetic
 * fixture: paid plans are not on sale (PLANS_ON_SALE false), and nothing kept
 * goes on sale: every product stays a hidden draft.
 */
import { readFileSync, existsSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as askLink } from "@/app/api/auth/request/route";
import { POST as openLink } from "@/app/api/auth/callback/route";
import { POST as claim } from "@/app/api/store/claim/route";
import { POST as ai } from "@/app/api/store/ai/route";
import { POST as keep } from "@/app/api/store/setup/route";
import { SESSION_COOKIE } from "@/lib/auth";
import { setSubscription, storeForEmail } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { canSell } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

const ORIGIN = "https://marktmorgen.com";
let modelCalls = 0;
const DRAFT = {
  bios: ["Weeknight dinners for busy parents.", "Cook once, eat all week.", "Sunday batch cooking, made simple."],
  products: [
    { title: "Sunday Meal Planner", summary: "A week of dinners planned in one page.", kind: "download", price: "12" },
    { title: "Batch Cooking Course", summary: "Ten short lessons.", kind: "course", price: "49" },
  ],
  faq: [{ q: "How do I get the planner?", a: "As a download after paying." }],
  questions: [],
};
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.anthropic.com/")) {
      modelCalls += 1;
      return Response.json({ content: [{ type: "text", text: JSON.stringify(DRAFT) }], usage: { input_tokens: 900, output_tokens: 400 } });
    }
    return new Response("{}", { status: 404 });
  },
});
mail.configure();

const EMAIL = "ai-walker@example.com";
let session = "";
const sameSite = () => ({ origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin" });
const asJson = (url: string, body: unknown, withSession = false) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...sameSite(), ...(withSession ? { cookie: `${SESSION_COOKIE}=${session}` } : {}) },
    body: JSON.stringify(body),
  });
const asForm = (url: string, fields: Record<string, string>) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...sameSite() }, body: new URLSearchParams(fields) });

type Step = { step: number; action: string; required: string[] };
const walk: Step[] = [];

async function main(): Promise<void> {
  redis.clear();

  part("Before the walk: signed in, with a store (measured in docs/signup-to-ready-measured.md)");
  await askLink(asJson(`${ORIGIN}/api/auth/request`, { email: EMAIL, website: "" }));
  const link = /https:\/\/marktmorgen\.com\/signin\/confirm\?\S+/.exec(mail.sent.at(-1)?.text ?? "")?.[0] ?? "";
  const opened = await openLink(asForm(`${ORIGIN}/api/auth/callback`, { token: link ? new URL(link).searchParams.get("token") ?? "" : "" }));
  session = /nl_session=([0-9a-f]{64})/.exec(opened.headers.get("set-cookie") ?? "")?.[1] ?? "";
  await claim(asJson(`${ORIGIN}/api/store/claim`, { handle: "aiwalker", name: "AI Walker" }, true));
  // The writing help needs a plan; plans are not on sale, so this one is a synthetic fixture.
  await setSubscription(EMAIL, { customerId: "cus_AiWalk0001", subscriptionId: "sub_AiWalk0001", active: true, tier: "pro", period: paidPeriod() });
  is("signed in, with a store", [session.length, (await storeForEmail(EMAIL))?.handle], [64, "aiwalker"]);

  part("1. Describe what you make");
  const aiUrl = `${ORIGIN}/api/store/ai`;
  const empty = await ai(asJson(aiUrl, { kind: "setup", about: "" }, true));
  is("without a word about what they make: refused, and the model is not asked", [empty.ok, modelCalls], [false, 0]);
  const drafted = await ai(asJson(aiUrl, { kind: "setup", about: "I teach busy parents to batch cook on Sundays.", notes: "A planner for $12 and a course at 49 dollars." }, true));
  const draft = (await drafted.json()) as { ok?: boolean; value?: { bios: string[]; products: unknown[]; faq: unknown[] } };
  is("with it: one model call, and a draft to review", [draft.ok, modelCalls, draft.value?.bios.length, draft.value?.products.length], [true, 1, 3, 2]);
  walk.push({ step: 1, action: "Describe what you make", required: ["about"] });

  part("Between the steps: the choices on the review screen");
  const choices = 1 + (draft.value?.products.length ?? 0) + (draft.value?.faq.length ? 1 : 0);
  is("one line, keep or not for each product, keep or not for the questions", choices, 4);

  part("2. Keep what you chose");
  const kept = await keep(asJson(`${ORIGIN}/api/store/setup`, { bio: DRAFT.bios[1], products: DRAFT.products, faq: DRAFT.faq }, true));
  const answer = (await kept.json()) as { ok?: boolean; done?: { products: number; pages: number }; steps?: { id: string }[] };
  is("kept: two hidden drafts, each with its sales page", [answer.ok, answer.done?.products, answer.done?.pages], [true, 2, 2]);
  const store = (await storeForEmail(EMAIL))!;
  is("nothing went live", (await readListings(store)).map((listing) => listing.hidden), [true, true]);
  is("so the store cannot sell", canSell(store), false);
  is("no other model call", modelCalls, 1);
  walk.push({ step: 2, action: "Keep what you chose", required: [] });
  const missing = answer.steps?.length ?? -1;
  is("and it says what is still missing: Stripe, then each product", answer.steps?.map((step) => step.id.split(":")[0]), ["stripe", "product", "product"]);

  part("The record matches the walk");
  const recordPath = "docs/ai-store-builder.md";
  const record = existsSync(recordPath) ? readFileSync(recordPath, "utf8") : "";
  const section = record.split("## Measured")[1] ?? "";
  const rows = [...section.matchAll(/^\| (\d) \| ([^|]+) \| ([^|]+) \|/gm)].map((row) => ({
    step: Number(row[1]),
    action: row[2].trim(),
    required: row[3].trim() === "none" ? [] : row[3].split(",").map((field) => field.trim().replace(/`/g, "")),
  }));
  is("one row per step, with its action and required fields", rows, walk);
  is("the totals it states", [section.includes(`**${walk.length} actions**`), section.includes(`**${choices} choices**`), section.includes(`**${missing} steps still missing**`)], [true, true, true]);
  is("it says nothing goes live and no person's time was measured", [/hidden draft/.test(section), /not measured/i.test(section)], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
