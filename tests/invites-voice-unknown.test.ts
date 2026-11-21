/**
 * A read that failed is named, never shown as none (rule 24; inventory group F
 * item 9 and its LEVE note on lib/customer-voice.ts):
 *
 *   - the partnerships other creators offered (lib/partner-invites.ts
 *     waitingFor) are read in their exact shape: a reply in an unknown shape
 *     throws UnknownReplyError instead of meaning "no offers", and the
 *     affiliates page says the offers could not be loaded just now instead of
 *     showing nothing;
 *   - the customer-voice report (lib/customer-voice.ts) is made only from
 *     every list read whole: gatherVoice names each list whose read failed,
 *     and then nothing is asked, counted or kept (the summary stands for the
 *     whole month); the creator is told which lists could not be read and can
 *     try again for the complete report.
 *
 * Synthetic data only; Redis is the in-memory stub, the model a stand-in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { offerPartnership, waitingFor } from "@/lib/partner-invites";
import { UnknownReplyError } from "@/lib/redis-reply";
import { MIN_TEXTS, gatherVoice, makeVoice } from "@/lib/customer-voice";
import { keepAnswer } from "@/lib/answers";
import { saveReview } from "@/lib/reviews";
import { countSearchMiss } from "@/lib/stats";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { aiMonthKey } from "@/lib/ai";
import * as voiceScreen from "@/components/customer-voice";
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

// A row this code never wrote, beside a whole one (Claude 2 on #3174): unknown, never skipped, so no offer is
// hidden and offerPartnership's cap is never checked against one row too few.
const OTHER_ID = "ffffffffffff";
for (const [label, field, row] of [
  ["text that is not JSON", OTHER_ID, "not json {"],
  ["a row with no valid share", OTHER_ID, JSON.stringify({ ...OFFER, id: OTHER_ID, share: { percent: "lots" }, at: 1 })],
  ["a row with a bad id", OTHER_ID, JSON.stringify({ ...OFFER, id: "nope", at: 1 })],
  ["a row with no store", OTHER_ID, JSON.stringify({ ...OFFER, id: OTHER_ID, sid: "", at: 1 })],
  ["a row kept under another offer's id", "eeeeeeeeeeee", JSON.stringify({ ...OFFER, id: OTHER_ID, at: 1 })],
] as const) {
  test(`an offer row that is ${label}, beside a whole one, is unknown, never skipped`, async () => {
    if (!(await waitingFor(ANA)).length) assert.equal((await offerPartnership(ANA, OFFER)).ok, true);
    const original = redis.pipeline;
    redis.pipeline = (async (commands: unknown[][]) => {
      const replies = (await original.call(redis, commands as never)) as unknown[];
      return commands.map((c, i) => (c[0] === "HGETALL" ? [...(replies[i] as string[]), field, row] : replies[i]));
    }) as typeof redis.pipeline;
    try {
      await assert.rejects(() => waitingFor(ANA), UnknownReplyError);
    } finally {
      redis.pipeline = original;
    }
    assert.equal((await waitingFor(ANA)).length, 1, "control: the whole row alone is read");
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

test("enough texts but a list unread: nothing asked, nothing counted, nothing kept, and the list is named", async () => {
  const questions = ["Is there a printable version?", "Can I print the planner?", "Does it come as a PDF?", "Is there a print layout?"];
  const { store, statsId, now } = await voiceStore("owner.made@example.com", "made", questions, ["printable", "pdf", "print version", "large print"]);
  const before = systems.length;
  const result = await withReads([`nl:rev:all:${statsId}`], failing, () => makeVoice(store, now));
  assert.deepEqual(result, { ok: false, reason: "unread", unread: ["review"], texts: 8 }, "a partial report is never made: it would stand for the whole month");
  assert.equal(systems.length, before, "no model call");
  const key = aiMonthKey(store, new Date(now));
  assert.equal(Number((await redis.pipeline([["GET", key ?? ""]]))[0] ?? 0), 0, "no AI job counted");
  assert.equal((await redis.pipeline([["EXISTS", `nl:voice:${statsId}:${new Date(now).toISOString().slice(0, 7)}`]]))[0], 0, "nothing kept for the month");
  const later = await makeVoice(store, now);
  if (!later.ok) throw new Error(`no summary once read again: ${later.reason}`);
  assert.equal(later.summary.read.review, 2, "tried again once the list reads, the report is whole");
  assert.equal(systems.length, before + 1, "and only then is the model asked");
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

test("a whole read with enough texts is sorted as before", async () => {
  const questions = ["Is there a printable version?", "Can I print the planner?", "Does it come as a PDF?", "Is there a print layout?"];
  const { store, now } = await voiceStore("owner.whole@example.com", "whole", questions, ["printable", "pdf"]);
  const made = await makeVoice(store, now);
  if (!made.ok) throw new Error(`no summary: ${made.reason}`);
  assert.deepEqual(made.summary.read, { question: 4, review: 2, search: 2 });
  assert.match(systems.at(-1)!, /You are given numbered texts: words members wrote when canceling, questions a product page could not answer, reviews, and words searched for on the store that found nothing\./, "the model is told what it was given, all of it");
});

test("the studio names the lists that could not be read when it refuses", () => {
  const unreadWords = (voiceScreen as unknown as { unreadWords?: (u: string[]) => string }).unreadWords;
  assert.equal(typeof unreadWords, "function", "the naming is the screen's own, exported to be checked");
  if (!unreadWords) return;
  assert.equal(unreadWords(["search", "review"]), "Reviews and searches with no result");
  assert.equal(unreadWords(["cancel"]), "Members leaving");
  assert.equal(unreadWords(["cancel", "question", "review"]), "Members leaving, unanswered questions and reviews");
  const studio = readFileSync(join(process.cwd(), "components/customer-voice.tsx"), "utf8");
  assert.match(studio, /unread: "Some of what customers said could not be read just now/, "the screen's words for the refusal");
  assert.match(studio, /No AI job was used/, "and that nothing was spent");
  assert.match(studio, /Not read: \$\{named\}/, "with the names beside them");
});

test("the route answers the unread refusal as unavailable, with the names", () => {
  const route = readFileSync(join(process.cwd(), "app/api/store/voice/route.ts"), "utf8");
  assert.match(route, /done\.reason === "unread"/);
  assert.match(route, /unread: done\.unread/);
});
