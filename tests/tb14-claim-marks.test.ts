/**
 * The marks that hand over a gift and a pre-order once read only exact
 * replies (queue 388 [TB14] with C4-20261105-2115-TODOS-1; CX-123 rules 24
 * and 25; lib/claim-mark.ts).
 *
 * deliverGift (lib/gifts.ts) and handOverPreorder (lib/preorders.ts) took a
 * mark with SET NX and read anything but null as theirs: an unknown reply
 * handed the purchase over beside another run that held the mark. And each
 * let the mark go with a plain DEL, so a run whose mark had run out and been
 * taken by another deleted the other run's mark. Now:
 *
 *   - "OK", or a reply of another shape whose read-back holds this run's
 *     value, is ours, and the purchase is handed over once;
 *   - null, or a read-back holding another value, is somebody else's:
 *     nothing handed over; for a gift, "already" only once it is given, and
 *     otherwise an error, so the caller keeps no "sent" mark and the next
 *     run tries again (Claude 4 on #2726);
 *   - anything else is unknown: UnknownReplyError, nothing handed over and
 *     no "sent" mark (the caller reads it as Redis not answering, and the
 *     next run tries again);
 *   - the mark is let go only while it holds this run's own value.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, startGift } from "@/lib/gifts";
import { importedKey } from "@/lib/imported-purchases";
import { handOverPreorder, readPreorder } from "@/lib/preorders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

const setNx = (key: string) => (commands: (string | number)[][]) => commands.length === 1 && commands[0]?.[0] === "SET" && commands[0]?.[1] === key && commands[0]?.includes("NX");
const getOf = (key: string) => (commands: (string | number)[][]) => commands.length === 1 && commands[0]?.[0] === "GET" && commands[0]?.[1] === key;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_tb14_marks_only";
  process.env.RESEND_API_KEY = "re_test_tb14_marks_only";
  await claimHandle("owner@marks.example", "marksshop", "Marks Shop", "");
  await ensureStatsId("owner@marks.example");
  await setStripeAccount("owner@marks.example", "acct_1TestMarks0001", true);
  await setSubscription("owner@marks.example", { customerId: "cus_Marks00001", subscriptionId: "sub_Marks00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@marks.example", "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@marks.example", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@marks.example"))!;
  const product = (await readListing(store, made.product.id))!;
  const has = async (email: string) => typeof (await pipeline([["HGET", importedKey(store.statsId!, email), product.id]]))[0] === "string";

  part("deliverGift: the giving mark is read exactly");
  let n = 0;
  const gift = async () => {
    n += 1;
    const to = `friend${n}@marks.example`;
    const started = await startGift(store, product as Listing, { to, from: "Ana", message: "" });
    if (!started.ok) throw new Error("no gift");
    const key = `nl:gift:${started.gift.id}:giving`;
    const give = (recordStart: (email: string, id: string, start: number) => Promise<void> = async () => {}) => deliverGift({
      store,
      session: { id: `cs_test_marks${String(n).padStart(10, "0")}`, created: 1_900_000_000, amount_total: 2500, currency: "usd", payment_intent: `pi_marks${String(n).padStart(10, "0")}`, metadata: { store: "marksshop", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@marks.example" } } as never,
      product: product as Listing,
      base: "https://marktmorgen.com/@marksshop",
      from: '"Marks Shop" <hello@marktmorgen.com>',
      recordStart,
      ordersLink: async () => null,
    });
    return { to, key, give };
  };
  for (const [label, reply] of [["true", [true]], ["a number", [1]], ["an empty reply", []], ["not a list", { result: "OK" }]] as [string, unknown][]) {
    const g = await gift();
    rule = { when: (c) => setNx(g.key)(c) || getOf(g.key)(c), reply };
    is(`a giving mark answered as ${label}, not held after: unknown, nothing given`, [await outcome(() => g.give()), await has(g.to)], ["rejected: UnknownReplyError", false]);
    rule = null;
  }
  {
    // A SET answered as text, read back holding text that is not this run's value: somebody else's (lib/claim-mark.ts).
    const g = await gift();
    rule = { when: (c) => setNx(g.key)(c) || getOf(g.key)(c), reply: ["1"] };
    is("a giving mark answered as text, read back as another value: somebody else's, so not done here and not said as done", [await outcome(() => g.give()), await has(g.to)], ["rejected: Error", false]);
    rule = null;
  }
  {
    const g = await gift();
    await pipeline([["SET", g.key, "someone-else", "EX", 300]]);
    // Not "already" while the gift is not given (Claude 4 on #2726): confirmGift (lib/purchase-email.ts) keeps its "sent"
    // mark on "already", and if the other run then failed, the paid gift would never be given.
    is("a mark another run holds, the gift not given yet: thrown, nothing given, so the next run tries again", [await outcome(() => g.give()), await has(g.to)], ["rejected: Error", false]);
  }
  {
    const g = await gift();
    // The other run finished meanwhile: then it is "already".
    is("the gift given by another run", await g.give(), "given");
    await pipeline([["SET", g.key, "someone-else", "EX", 300]]);
    is("a mark another run holds, the gift given already: already", await g.give(), "already");
  }
  {
    const g = await gift();
    is("the mark free: given", [await g.give(), await has(g.to)], ["given", true]);
    is("and let go after", (await pipeline([["GET", g.key]]))[0], null);
  }
  {
    const g = await gift();
    // While this run gives, its mark runs out and another run takes it: this run must not delete the other's.
    const given = await g.give(async () => {
      await pipeline([["SET", g.key, "the-other-run", "EX", 300]]);
    });
    is("a mark taken over meanwhile is not deleted by this run", [given, (await pipeline([["GET", g.key]]))[0]], ["given", "the-other-run"]);
  }

  part("handOverPreorder: the giving mark is read exactly");
  const course = { ...(product as Listing), course: { modules: [] } } as unknown as Listing;
  let m = 0;
  const preorder = async () => {
    m += 1;
    const session = `cs_test_markspre${String(m).padStart(8, "0")}`;
    const to = `pre${m}@marks.example`;
    await pipeline([["HSET", `nl:pre:${store.statsId}:${product.id}`, session, JSON.stringify({ to, at: 1_900_000_000, pi: `pi_markspre${String(m).padStart(8, "0")}` })]]);
    return { session, to, key: `nl:pre:give:${session}` };
  };
  const deps = (recordStart: (email: string, id: string, start: number) => Promise<void> = async () => {}) => ({
    base: "https://marktmorgen.com/@marksshop",
    from: '"Marks Shop" <hello@marktmorgen.com>',
    ordersLink: async () => null,
    recordStart,
  });
  for (const [label, reply] of [["true", [true]], ["a number", [1]], ["an empty reply", []], ["not a list", { result: "OK" }]] as [string, unknown][]) {
    const p = await preorder();
    rule = { when: (c) => setNx(p.key)(c) || getOf(p.key)(c), reply };
    is(`a pre-order's mark answered as ${label}, not held after: unknown, nothing handed over`, [await outcome(() => handOverPreorder(store, course, p.session, deps())), await has(p.to)], ["rejected: UnknownReplyError", false]);
    rule = null;
  }
  {
    const p = await preorder();
    rule = { when: (c) => setNx(p.key)(c) || getOf(p.key)(c), reply: ["1"] };
    is("a pre-order's mark answered as text, read back as another value: somebody else's, thrown, nothing handed over", [await outcome(() => handOverPreorder(store, course, p.session, deps())), await has(p.to)], ["rejected: Error", false]);
    rule = null;
  }
  {
    const p = await preorder();
    await pipeline([["SET", p.key, "someone-else", "EX", 300]]);
    // As for a gift: confirmPreorder answers "given" for "already", so it is said only once the pre-order is given.
    is("a mark another run holds, not given yet: thrown, nothing handed over", [await outcome(() => handOverPreorder(store, course, p.session, deps())), await has(p.to)], ["rejected: Error", false]);
    is("and the other run's mark is left alone", (await pipeline([["GET", p.key]]))[0], "someone-else");
  }
  {
    const p = await preorder();
    is("the mark free: given", [await handOverPreorder(store, course, p.session, deps()), await has(p.to), Boolean((await readPreorder(store, product.id, p.session))?.given)], ["given", true, true]);
    is("and let go after", (await pipeline([["GET", p.key]]))[0], null);
  }
  {
    const p = await preorder();
    const given = await handOverPreorder(store, course, p.session, deps(async () => {
      await pipeline([["SET", p.key, "the-other-run", "EX", 300]]);
    }));
    is("a mark taken over meanwhile is not deleted by this run", [given, (await pipeline([["GET", p.key]]))[0]], ["given", "the-other-run"]);
  }

  done();
}

void main();
