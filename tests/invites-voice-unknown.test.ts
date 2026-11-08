/**
 * A read that failed is named, never shown as none (rule 24; inventory group F
 * item 9 and its LEVE note on lib/customer-voice.ts):
 *
 *   - the partnerships other creators offered (lib/partner-invites.ts
 *     waitingFor) are read in their exact shape: a reply in an unknown shape
 *     throws UnknownReplyError instead of meaning "no offers", and the
 *     affiliates page says the offers could not be loaded just now instead of
 *     showing nothing;
 *   - the customer-voice report (lib/customer-voice.ts) names every list
 *     whose read failed: gatherVoice says which, the model is told the texts
 *     are not everything customers said, the kept summary carries the names,
 *     and the studio and the reviews page say them; with too few texts while a
 *     list is unread, nothing is asked or counted and the creator is told why.
 *
 * Synthetic data only; Redis is the in-memory stub, the model a stand-in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { offerPartnership, waitingFor } from "@/lib/partner-invites";
import { UnknownReplyError } from "@/lib/redis-reply";
import { MIN_TEXTS, gatherVoice, makeVoice, type VoiceSummary } from "@/lib/customer-voice";
import { keepAnswer } from "@/lib/answers";
import { saveReview } from "@/lib/reviews";
import { countSearchMiss } from "@/lib/stats";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { aiMonthKey } from "@/lib/ai";
import { CustomerVoice } from "@/components/customer-voice";
import { ReviewThemes } from "@/components/review-themes";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const systems: string[] = [];
const prompts: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as { system?: unknown; messages: { content: string }[] };
    systems.push(typeof body.system === "string" ? body.system : JSON.stringify(body.system));
    prompts.push(body.messages[0].content);
    const ids = [...body.messages[0].content.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ themes: [{ title: "Wants it printable", ids }] }) }] }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

redis.clear();
process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

const ANA = "ana.invites@example.com";
const OFFER = { sid: "st_harbor", storeName: "Harbor Kitchen", handle: "harbor", share: { percent: 30, products: ["prodaaaaaa"] }, titles: ["The Sourdough Course"] };

/** Runs `body` with every pipeline that touches a key starting with one of `prefixes` answered by `answer`. */
async function withReads<T>(prefixes: string[], answer: (commands: unknown[][]) => unknown, body: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: unknown[][]) => {
    const touched = commands.some((c) => prefixes.some((p) => c.slice(1).some((arg) => typeof arg === "string" && arg.startsWith(p))));
    return touched ? answer(commands) : original.call(redis, commands as never);
  }) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = original;
  }
}

// ---- partnership offers ----------------------------------------------------

test("offers in their exact shape are read; none is a confirmed none", async () => {
  const made = await offerPartnership(ANA, OFFER);
  assert.equal(made.ok, true);
  const waiting = await waitingFor(ANA);
  assert.deepEqual(waiting.map((w) => w.storeName), ["Harbor Kitchen"]);
  assert.deepEqual(await waitingFor("nobody.invited@example.com"), [], "a key that is not there is no offers, legitimately");
});

for (const [label, reply] of [
  ["no reply at all", []],
  ["a null where the hash should be", [null]],
  ["a word where the hash should be", ["OK"]],
  ["a number where the hash should be", [3]],
  ["a field without its value", [["a1b2c3d4e5f6"]]],
  ["a value that is not text", [["a1b2c3d4e5f6", 7]]],
] as const) {
  test(`offers answered with ${label} are unknown, never "none"`, async () => {
    await withReads(["nl:"], () => [...reply], async () => {
      await assert.rejects(() => waitingFor(ANA), UnknownReplyError);
    });
  });
}

test("the affiliates page says the offers could not be loaded, never shows them as none", () => {
  const page = readFileSync(join(process.cwd(), "app/studio/affiliates/page.tsx"), "utf8");
  assert.doesNotMatch(page, /waitingFor\([^)]*\)\)?\.catch\(\(\) => \[\]\)/, "a failed read is not an empty list");
  assert.match(page, /offers === null \?/, "the page draws its own state for an unread list");
  const at = page.indexOf("offers === null ?");
  const note = page.slice(at, at + 700);
  assert.match(note, /role="status"/, "said to assistive technology");
  assert.match(note, /could not be loaded just now/, "in plain words");
  assert.match(note, /Nothing was changed/, "and that nothing was lost");
});

// ---- what customers are saying ---------------------------------------------

async function voiceStore(owner: string, handle: string, questions: string[], searches: string[]) {
  await claimHandle(owner, handle, `${handle} store`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Meal Planner", "", "19");
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const now = Date.now();
  for (const [i, q] of questions.entries()) await keepAnswer(store, `${handle}${i}`, "x", { productId: made.product.id, question: q, now: now - i * 86_400_000 });
  for (const [i, text] of ["I wish it came as a PDF to print", "Lovely recipes, easy to follow"].entries()) {
    const saved = await saveReview(statsId, { productId: made.product.id, email: `${handle}buyer${i}@example.com`, reference: `cs_test_${handle}rev${i}000000`, pi: `pi_${handle}rev${i}`, rating: 4 + i, text, name: `Buyer ${i}` }, ROOM);
    if (saved.state !== "created") throw new Error(`no review: ${saved.state}`);
  }
  for (const words of searches) await countSearchMiss(statsId, [words]);
  return { store: (await storeForEmail(owner))!, statsId, now };
}

const failing = () => {
  throw new Error("Redis did not answer (synthetic)");
};

test("a list whose read failed is named by gatherVoice, the rest still read", async () => {
  const { store, statsId, now } = await voiceStore("owner.gather@example.com", "gather", ["Is there a printable version?", "Can I print the planner?"], ["printable"]);
  const whole = await gatherVoice(store, now);
  assert.deepEqual(whole.unread, [], "everything read: nothing named");
  assert.deepEqual(whole.items.map((i) => i.source).sort(), ["question", "question", "review", "review", "search"]);
  const partial = await withReads([`nl:rev:all:${statsId}`], failing, () => gatherVoice(store, now));
  assert.deepEqual(partial.unread, ["review"], "the reviews could not be read, and that is said");
  assert.deepEqual(partial.items.map((i) => i.source).sort(), ["question", "question", "search"], "what could be read is still there");
  const two = await withReads([`nl:rev:all:${statsId}`, `nl:stats:${statsId}:`], failing, () => gatherVoice(store, now));
  assert.deepEqual(two.unread, ["review", "search"]);
});

test("a summary made while a list was unread names it, and the model is not told the texts are complete", async () => {
  const questions = ["Is there a printable version?", "Can I print the planner?", "Does it come as a PDF?", "Is there a print layout?"];
  const { store, statsId, now } = await voiceStore("owner.made@example.com", "made", questions, ["printable", "pdf", "print version", "large print"]);
  const before = systems.length;
  const made = await withReads([`nl:rev:all:${statsId}`], failing, () => makeVoice(store, now));
  if (!made.ok) throw new Error(`no summary: ${made.reason}`);
  assert.deepEqual(made.summary.unread, ["review"], "kept with the summary, so every screen that shows it can say so");
  assert.equal(made.summary.read.review, undefined);
  assert.equal(systems.length, before + 1, "asked once");
  const system = systems.at(-1)!;
  assert.match(system, /could not be read/i, "the model is told some lists are missing");
  assert.match(system, /not everything customers said/i, "and that the texts are not complete");
  assert.doesNotMatch(system, /You are given numbered texts: words members wrote when canceling, questions a product page could not answer, reviews, and words searched/, "never the old sentence listing every kind as given");
});

test("too few texts while a list is unread: nothing asked, nothing counted, and the reason is the unread list", async () => {
  const { store, statsId, now } = await voiceStore("owner.few@example.com", "few", ["Is there a printable version?"], []);
  const before = systems.length;
  const result = await withReads([`nl:rev:all:${statsId}`], failing, () => makeVoice(store, now));
  assert.deepEqual(result, { ok: false, reason: "unread", unread: ["review"], texts: 1 });
  assert.equal(systems.length, before, "no model call");
  const key = aiMonthKey(store, new Date(now));
  assert.equal(Number((await redis.pipeline([["GET", key ?? ""]]))[0] ?? 0), 0, "no AI job counted");
  assert.ok(MIN_TEXTS > 1);
});

test("a whole read with enough texts still keeps no names of unread lists", async () => {
  const questions = ["Is there a printable version?", "Can I print the planner?", "Does it come as a PDF?", "Is there a print layout?"];
  const { store, now } = await voiceStore("owner.whole@example.com", "whole", questions, ["printable", "pdf"]);
  const made = await makeVoice(store, now);
  if (!made.ok) throw new Error(`no summary: ${made.reason}`);
  assert.deepEqual(made.summary.unread, []);
  assert.doesNotMatch(systems.at(-1)!, /could not be read/i, "nothing said missing when nothing is");
});

const SUMMARY: VoiceSummary = {
  at: 1,
  month: new Date().toISOString().slice(0, 7),
  read: { question: 4, search: 4 },
  themes: [{ title: "Wants it printable", count: 8, sources: { question: 4, search: 4 }, examples: [{ source: "question", text: "Is there a printable version?", n: 1 }] }],
  reviewThemes: [],
  other: 0,
  unread: ["review", "search"],
};

test("the studio names the lists that could not be read in the summary", () => {
  const html = renderToStaticMarkup(createElement(CustomerVoice, { initial: SUMMARY }));
  assert.match(html, /role="status"[^>]*>[^<]*Reviews and searches with no result could not be read/, "named, in words, as a status");
  const whole = renderToStaticMarkup(createElement(CustomerVoice, { initial: { ...SUMMARY, unread: [] } }));
  assert.doesNotMatch(whole, /could not be read/, "nothing said when everything was read");
  const old = renderToStaticMarkup(createElement(CustomerVoice, { initial: { ...SUMMARY, unread: undefined } }));
  assert.doesNotMatch(old, /could not be read/, "a summary kept before this is shown as before");
  const studio = readFileSync(join(process.cwd(), "components/customer-voice.tsx"), "utf8");
  assert.match(studio, /unread: "Some of what customers said could not be read just now/, "the screen's words for the refusal");
});

test("the reviews page says reviews could not be read instead of 'no review themes'", () => {
  const html = renderToStaticMarkup(createElement(ReviewThemes, { voice: { ...SUMMARY, unread: ["review"] }, studioHome: "/studio?store=x" }));
  assert.doesNotMatch(html, /None of this month/, "never 'none' for reviews that were not read");
  assert.match(html, /Reviews could not be read when this summary was made/);
  const read = renderToStaticMarkup(createElement(ReviewThemes, { voice: { ...SUMMARY, unread: [] }, studioHome: "/studio?store=x" }));
  assert.match(read, /None of this month/, "a confirmed none stays a none");
});

test("the route answers the unread refusal as unavailable, with the names", () => {
  const route = readFileSync(join(process.cwd(), "app/api/store/voice/route.ts"), "utf8");
  assert.match(route, /done\.reason === "unread"/);
  assert.match(route, /unread: done\.unread/);
});
