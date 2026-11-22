/**
 * What customers are saying (lib/customer-voice.ts; added 12 October 2026).
 * Checked:
 *
 *   - the four lists are read together, from the last 90 days, without names,
 *     with addresses, phone numbers and links taken out;
 *   - the model only sorts: a number it was not handed, a text already in a
 *     theme, a theme of one text and a name with a figure are dropped; counts
 *     and examples come from the texts themselves;
 *   - what members wrote when leaving is counted but never quoted, and a
 *     person's erasure deletes every month a summary may be kept for
 *     (tests/voice-erasure.test.ts has the erasure itself);
 *   - made only with enough to read, once a calendar month, as one of the
 *     month's AI jobs, and given back unchanged after that.
 */
import { KEEP_SECONDS, LOCK_SECONDS, MIN_TEXTS, cleanVoice, keptMonths, gatherVoice, makeVoice, readVoice, themesFrom, voicePrompt, type VoiceItem } from "@/lib/customer-voice";
import { keepAnswer } from "@/lib/answers";
import { saveReview } from "@/lib/reviews";
import { countSearchMiss } from "@/lib/stats";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { aiMonthKey } from "@/lib/ai";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { mock } from "node:test";

// The checks pass one moment (`now` below) to the code, which still reads the clock itself in places: a run crossing
// 00:00 UTC (any day) between the two failed "questions, reviews and searches, never the old question" and "fewer
// than 8 texts: nothing asked, nothing counted". Only Date is stopped, for the whole run; timers and
// performance.now() run as usual.
mock.timers.enable({ apis: ["Date"], now: Date.now() });

let reply: string | null = null;
const prompts: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push(body.messages[0].content);
    if (reply === null) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

  part("Nobody named in what is sent");
  is(
    "addresses, links and phone numbers taken out",
    cleanVoice(("Write to me at pat.smith@example.com or " + ("+" + "1 (415) 555-0199") + ", see https://example.com/x")),
    "Write to me at [email] or [number], see [link]",
  );

  part("The model only sorts");
  const items: VoiceItem[] = [
    { id: 1, source: "question", text: "Is there a printable version?", n: 1, product: "Meal Planner" },
    { id: 2, source: "review", text: "Great, but I wish I could print it", n: 1, stars: 4 },
    { id: 3, source: "search", text: "printable", n: 5 },
    { id: 4, source: "cancel", text: "Too expensive for what I use", n: 1 },
    { id: 5, source: "cancel", text: "Costs too much each month", n: 1 },
    { id: 6, source: "review", text: "Loved the recipes", n: 1, stars: 5 },
  ];
  const sorted = themesFrom(
    {
      themes: [
        { title: "Wants a printable version", ids: [1, 2, 3, 99] },
        { title: "Price feels high", ids: [4, 5, 1] },
        { title: "Loved by 9 in 10", ids: [6, 2] },
        { title: "Just one", ids: [6] },
      ],
    },
    items,
  );
  is("a number not handed is dropped, and each text counted once, a search as often as it was made", sorted.themes.map((t) => [t.title, t.count, t.sources]), [
    ["Wants a printable version", 7, { question: 1, review: 1, search: 5 }],
    ["Price feels high", 2, { cancel: 2 }],
  ]);
  is("the examples are the customers' own words, the most repeated first", sorted.themes[0].examples.map((e) => e.text), ["printable", "Is there a printable version?", "Great, but I wish I could print it"]);
  is("a name with a figure and a theme of one are dropped; the rest is counted apart", sorted.other, 1);
  is("what members wrote when leaving is counted, never quoted: nobody beside it can be checked against the deleted", [sorted.themes[1].count, sorted.themes[1].examples], [2, []]);
  is("nothing usable, nothing said", themesFrom({ themes: "x" }, items).themes, []);
  const prompt = voicePrompt(items);
  is("handed by number, with where each came from", [prompt.includes("[3] (words searched for on the store that found nothing, searched 5 times) printable"), prompt.includes("[1] (a visitor's question the page could not answer, about Meal Planner)")], [true, true]);

  part("The months a person's erasure deletes");
  const nov5 = Date.UTC(2026, 10, 5);
  is("every month a summary kept now may be of, from 70 days back", keptMonths(nov5), ["2026-11", "2026-10", "2026-09", "2026-08"]);
  is("one written on the last day of the oldest is still among them", keptMonths(Date.UTC(2026, 7, 31, 23) + KEEP_SECONDS * 1000 - 1).at(-1), "2026-08");
  is("a reading begun on the last second of a month writes that month's key up to its lock's time later, kept 70 days from then", keptMonths(Date.UTC(2026, 8, 1) + (KEEP_SECONDS + LOCK_SECONDS) * 1000 - 1).at(-1), "2026-08");
  is("and none older than it can be kept", keptMonths(Date.UTC(2026, 9, 1) + (KEEP_SECONDS + LOCK_SECONDS + 60) * 1000).at(-1), "2026-10");

  part("Read together, from the last 90 days");
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Meal Planner", "", "19");
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const now = Date.now();
  for (const [i, q] of ["Is there a printable version?", "Can I print the planner?", "Does it work in metric?"].entries()) {
    await keepAnswer(store, `h${i}`, "x", { productId: made.product.id, question: q, now: now - i * 86_400_000 });
  }
  await keepAnswer(store, "old", "x", { productId: made.product.id, question: "An old question from long ago", now: now - 120 * 86_400_000 });
  for (const [i, text] of ["I wish it came as a PDF to print", "Lovely recipes, easy to follow", "Mail me at pat@example.com for more"].entries()) {
    await saveReview(statsId, { productId: made.product.id, email: `buyer${i}@example.com`, reference: `cs_test_rev${i}0000000000`, pi: `pi_rev${i}`, rating: 4 + (i % 2), text, name: `Buyer ${i}` }, ROOM);
  }
  await countSearchMiss(statsId, ["printable"]);
  await countSearchMiss(statsId, ["printable"]);
  const { items: gathered } = await gatherVoice(store, now);

  part("Provider errors are not copied into server logs (through the real reads)");
  {
    // Every Redis read fails with customers' words in its error (Claude 3 M LEVE on #3733: the
    // check now drives gatherVoice instead of calling logVoiceFailure directly).
    const realPipeline = redis.pipeline.bind(redis);
    const originalConsoleError = console.error;
    const logged: unknown[][] = [];
    redis.pipeline = (async () => { throw new Error("buyer@example.test wrote private health details"); }) as typeof redis.pipeline;
    console.error = (...args: unknown[]) => { logged.push(args); };
    let failedReads: string[] = [];
    try {
      failedReads = (await gatherVoice(store, now)).unread;
    } finally {
      redis.pipeline = realPipeline;
      console.error = originalConsoleError;
    }
    const text = logged.flat().map((value) => (value instanceof Error ? `${value.message}\n${value.stack}` : String(value))).join("\n");
    is("the failed lists are named", failedReads.length > 0, true);
    is("something was logged for them", logged.length > 0, true);
    is("the log never carries what customers wrote", text.includes("buyer@example.test") || text.includes("health details"), false);
    is("every line is a fixed label alone", logged.every((args) => args.length === 1 && typeof args[0] === "string"), true);
  }
  is("questions, reviews and searches, never the old question", gathered.map((g) => `${g.source}|${g.text}|${g.n}`).sort(), [
    "question|Can I print the planner?|1",
    "question|Does it work in metric?|1",
    "question|Is there a printable version?|1",
    "review|I wish it came as a PDF to print|1",
    "review|Lovely recipes, easy to follow|1",
    "review|Mail me at [email] for more|1",
    "search|printable|2",
  ]);
  is("and never who wrote them", JSON.stringify(gathered).includes("Buyer") || JSON.stringify(gathered).includes("buyer0"), false);

  part("Only with enough to read");
  is(`fewer than ${MIN_TEXTS} texts: nothing asked, nothing counted`, [await makeVoice(store, now), prompts.length], [{ ok: false, reason: "few", texts: 7 }, 0]);
  await countSearchMiss(statsId, ["gluten free"]);
  reply = JSON.stringify({ themes: [{ title: "Wants a printable version", ids: gathered.filter((g) => /print|PDF/.test(g.text)).map((g) => g.id) }, { title: "Metric units", ids: [gathered.find((g) => /metric/.test(g.text))!.id] }] });
  const first = await makeVoice(store, now);
  if (!first.ok) throw new Error(`no summary: ${first.reason}`);
  is("made, as one of the month's AI jobs", [first.fresh, first.summary.themes.map((t) => [t.title, t.count]), first.summary.read, Number((await redis.pipeline([["GET", aiMonthKey(store, new Date(now))!]]))[0])], [
    true,
    [["Wants a printable version", 5]],
    { question: 3, review: 3, search: 3 },
    1,
  ]);
  const again = await makeVoice(store, now);
  is("once a month: asked again, the same summary, nothing more counted", [again.ok && again.fresh, prompts.length, Number((await redis.pipeline([["GET", aiMonthKey(store, new Date(now))!]]))[0])], [false, 1, 1]);
  is("read back for the studio", (await readVoice(store, now))?.themes[0].title, "Wants a printable version");
  const nextMonth = new Date(now);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 2);
  is("next month, last month's is shown until a new one is read", (await readVoice(store, nextMonth.getTime()))?.month, new Date(now).toISOString().slice(0, 7));

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
