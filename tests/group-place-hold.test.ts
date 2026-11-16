/**
 * A place's hold let go only while it is this run's own (Claude 6 on #2872; CX-123 rules 24, 25 and 30), synthetic
 * only: the in-memory Redis double and an email stand-in; no Stripe, no real email.
 *
 * The same place link opened twice at once (a double click): run A holds the link and is handed the product; run B
 * comes while A holds it. B must never delete A's record of the place: the list of who took a place is what a full
 * refund walks (revokeRefundedGroups, HGETALL), so with A's record gone a refund would leave A the product. Beside it,
 * the healthy control and the cases where the hold is B's own (its HSETNX landed, answered unknown; the places count
 * answered unknown), which are let go so the link works again.
 *
 * Rule 23, after the main was merged in: the main's design holds places by marks counted with HLEN, and lets one open
 * of an address's link run at a time (lib/group-buy.ts takePlace, the opening hold). So B is refused by that hold
 * (it throws: the page says "We could not finish opening your place", placeNotice "opening") instead of reading an
 * HSETNX of 0; the count is the HLEN of the marks, not an INCR of ":n"; a place is given back by an HDEL of the mark,
 * not by a script beside a DECR; and there is no "pending" outcome: a leftover mark is the address's own, picked up
 * and given back when its link is opened again.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { placeNotice, placesTaken, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const UNKNOWN = { unexpected: true };
const restore = () => {
  redis.pipeline = real;
};
/** What a call came to: its outcome, or "threw" when it refused by throwing. */
const outcome = <T extends { outcome: string }>(p: Promise<T>): Promise<string> => p.then((v) => v.outcome, () => "threw");

globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

/** A place's mark taken off: an HDEL, or since Codex C2's review of #2872 the compare-and-delete script (PLACE_DROP). */
const dropsMark = (c: (string | number)[], marks: string) =>
  (c[0] === "HDEL" && c[1] === marks) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:group-place-drop:v1") && c[3] === marks);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_group_place_hold_only";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  const OWNER = "groupplacehold@example.com";
  await claimHandle(OWNER, "placehold", "Place Hold", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPlHold01", true);
  await setSubscription(OWNER, { customerId: "cus_PlaceHold0001", subscriptionId: "sub_PlaceHold0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Glaze Guide", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  let n = 0;
  const base = "https://marktmorgen.com/@placehold";
  const from = '"Place Hold" <hello@marktmorgen.com>';
  /** A purchase for `people`, paid and settled, and a link maker for its places. */
  const paidGroup = async (people: number) => {
    const started = await startGroup(store, product, String(people));
    if (!started.ok) throw new Error("no group");
    n += 1;
    const session = {
      id: "cs_test_" + String(n).padStart(24, "h"),
      created: Math.floor(Date.now() / 1000),
      amount_total: 4900 * people,
      currency: "usd",
      payment_intent: `pi_PlaceHold${String(n).padStart(6, "0")}`,
      metadata: { store: "placehold", product: product.id, group: started.group.id, people: String(people) },
      customer_details: { email: "payer@example.com" },
    };
    if ((await settleGroup({ store, product, base, from, session })) !== "settled") throw new Error("not settled");
    store = (await storeForEmail(OWNER))!;
    const id = started.group.id;
    const link = async (email: string) => {
      const t = Buffer.from((id.slice(-6) + email).padEnd(32, "x").slice(0, 32)).toString("hex");
      await real([["SET", `nl:grp:take:${t}`, JSON.stringify({ g: id, e: email }), "EX", 3600]]);
      return t;
    };
    return { id, link };
  };
  const take = (token: string) => outcome(takePlace({ store, token, recordStart: async () => {} }));
  const owns = async (email: string) => (await importedFor({ ...store, pastBuyers: true }, email)).map((p) => p.productId);
  /** The places' list as a refund reads it (HGETALL): its flat length, and the addresses held. */
  const members = async (id: string) => {
    const [flat] = (await real([["HGETALL", `nl:grp:${id}:m`]])) as [string[]];
    return { length: flat.length, held: flat.filter((_, i) => i % 2 === 1).map((v) => (JSON.parse(v) as { e: string }).e) };
  };
  const isHold = (id: string) => (c: Command) => c[0] === "HSETNX" && c[1] === `nl:grp:${id}:m`;
  /** The opening hold of a place's link (lib/group-buy.ts takePlace): one open of an address's link at a time. */
  const isOpening = (id: string) => (c: Command) => c[0] === "SET" && String(c[1]).startsWith(`nl:grp:${id}:t:`);
  /**
   * The same link opened twice at once (a double click): A takes the link's opening hold first, then B opens it while
   * A still holds it, and A writes its mark only once B has had its answer, so B decides while A's run is going.
   */
  const doubleClick = async (id: string, token: string) => {
    let openings = 0;
    let aOpened: () => void = () => {};
    const aHolds = new Promise<void>((resolve) => {
      aOpened = resolve;
    });
    let bTried: () => void = () => {};
    const bDone = new Promise<void>((resolve) => {
      bTried = resolve;
    });
    redis.pipeline = (async (commands: Command[]) => {
      if (commands.some(isHold(id))) await bDone;
      const replies = await real(commands);
      if (commands.some(isOpening(id))) {
        openings += 1;
        if (openings === 1) aOpened();
      }
      return replies;
    }) as typeof redis.pipeline;
    const a = take(token);
    await aHolds;
    const b = await take(token);
    bTried();
    const both = [await a, b];
    restore();
    return both;
  };

  part("Healthy control: one open of the link takes the place, and the list holds it");
  const healthy = await paidGroup(2);
  const healthyLink = await healthy.link("ana@example.com");
  is("taken, the product handed over, one place counted", [await take(healthyLink), await owns("ana@example.com"), await placesTaken(healthy.id)], ["taken", [product.id], 1]);
  is("the list a refund walks holds that place", await members(healthy.id), { length: 2, held: ["ana@example.com"] });
  is("opened again it is 'already', the list unchanged", [await take(healthyLink), (await members(healthy.id)).length], ["already", 2]);

  part("Double click: A holds the link and takes the place; B opens it meanwhile");
  const twice = await paidGroup(2);
  const twiceLink = await twice.link("ben@example.com");
  // Rule 23: B is refused by the link's opening hold (the main), not by an HSETNX answering 0 in an unknown shape.
  // Expectations unchanged.
  is("A takes the place, B refuses (a temporary error)", await doubleClick(twice.id, twiceLink), ["taken", "threw"]);
  is("A holds the product, one place counted", [await owns("ben@example.com"), await placesTaken(twice.id)], [[product.id], 1]);
  is("A's record of the place is still in the list a refund walks: B never deletes it", await members(twice.id), { length: 2, held: ["ben@example.com"] });
  is("the link opened again is 'already', never a second place", [await take(twiceLink), await placesTaken(twice.id)], ["already", 1]);

  part("B's own hold: its HSETNX landed but answered in an unknown shape, so it lets go of its own record");
  const own = await paidGroup(2);
  const ownLink = await own.link("cy@example.com");
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    return commands.map((c, i) => (isHold(own.id)(c) ? UNKNOWN : replies[i]));
  }) as typeof redis.pipeline;
  const ownFirst = await take(ownLink);
  restore();
  is("refused, nothing handed over, no place counted", [ownFirst, await owns("cy@example.com"), await placesTaken(own.id)], ["threw", [], 0]);
  is("its own record let go, so the list is empty", await members(own.id), { length: 0, held: [] });
  is("the same link takes its place on a later try", [await take(ownLink), await owns("cy@example.com")], ["taken", [product.id]]);

  part("The places count answers in an unknown shape: the run lets go of its own record");
  const counted = await paidGroup(2);
  const countedLink = await counted.link("dee@example.com");
  // Rule 23: the count is the HLEN of the marks on the main, not an INCR of ":n". Expectations unchanged.
  const isCount = (c: Command) => c[0] === "HLEN" && c[1] === `nl:grp:${counted.id}:m`;
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands.filter((c) => !isCount(c)));
    let k = 0;
    return commands.map((c) => (isCount(c) ? UNKNOWN : replies[k++]));
  }) as typeof redis.pipeline;
  const countedFirst = await take(countedLink);
  restore();
  is("refused, nothing handed over", [countedFirst, await owns("dee@example.com")], ["threw", []]);
  is("its own record let go", (await members(counted.id)).length, 0);
  is("the same link takes its place on a later try", await take(countedLink), "taken");

  part("Full: the run that finds no place left gives back only its own record and its count");
  const full = await paidGroup(2);
  is("two places, taken", [await take(await full.link("eve@example.com")), await take(await full.link("fay@example.com"))], ["taken", "taken"]);
  is("a third address is told full", await take(await full.link("gus@example.com")), "full");
  is("the list still holds the two places only, two counted", [await members(full.id), await placesTaken(full.id)], [{ length: 4, held: ["eve@example.com", "fay@example.com"] }, 2]);

  // Upstash runs each command of a pipeline on its own: the HDEL giving the mark back can fail while the HLEN beside it
  // is answered, and the whole call then throws (lib/redis.ts). The run must still say "full", never leave the address
  // a record that later reads as a place it was never given (Claude 6 on #2872).
  // Rule 23: on the main the give-back is the HDEL of the mark beside an HLEN, not a script beside a DECR.
  const isDropOf = (id: string) => (c: Command) => dropsMark(c, `nl:grp:${id}:m`);
  /** The give-back's HDEL fails, the rest of its pipeline lands; `always` fails it alone too (the retry). */
  const failDrop = (id: string, always: boolean) => {
    redis.pipeline = (async (commands: Command[]) => {
      const drop = commands.some(isDropOf(id));
      if (!drop || (!always && commands.length === 1)) return real(commands);
      await real(commands.filter((c) => !isDropOf(id)(c)));
      throw new Error("Redis error: ERR script failed");
    }) as typeof redis.pipeline;
  };

  part("Full, and the give-back's HDEL fails while its HLEN lands: the run retries the HDEL alone");
  const failed = await paidGroup(2);
  is("two places, taken", [await take(await failed.link("hal@example.com")), await take(await failed.link("ivy@example.com"))], ["taken", "taken"]);
  const thirdLink = await failed.link("jo@example.com");
  failDrop(failed.id, false);
  const third = await take(thirdLink);
  restore();
  is("the third address is told full, nothing handed over", [third, await owns("jo@example.com")], ["full", []]);
  is("its record given back on the retry, two places counted", [await members(failed.id), await placesTaken(failed.id)], [{ length: 4, held: ["hal@example.com", "ivy@example.com"] }, 2]);
  is("opened again it is full again, never 'already'", await take(thirdLink), "full");

  part("Full, and the give-back's HDEL fails every time: the record left over never reads as a place");
  const stuck = await paidGroup(2);
  is("two places, taken", [await take(await stuck.link("kai@example.com")), await take(await stuck.link("lu@example.com"))], ["taken", "taken"]);
  const stuckLink = await stuck.link("max@example.com");
  failDrop(stuck.id, true);
  const stuckFirst = await take(stuckLink);
  const stuckAgain = await take(stuckLink);
  restore();
  // Rule 23: with every HDEL failing, the main says the open was not done (it throws), not "full" then "pending" (the
  // main has no "pending"); its mark is max's own, and once the HDEL works the link given back says "full".
  is("not done while the give-back fails, nothing handed over", [stuckFirst, stuckAgain, await owns("max@example.com")], ["threw", "threw", []]);
  is("opened again once Redis answers, it is full, never 'already', and nothing is handed over", [await take(stuckLink), await owns("max@example.com")], ["full", []]);
  is("no place counted past the two paid for", await placesTaken(stuck.id), 2);
  // Rule 23: the page's word for an open that was not done is the main's "opening" (placeNotice), not "unconfirmed".
  is("the page says the open was not finished, never 'expired' nor 'the place is yours'", placeNotice({ token: stuckLink, tokenValid: true, taken: null, threw: true, status: "" }), "opening");
  is(
    "that notice is in every buyer language, and is not the 'expired' one",
    Object.values(GIVING_WORDS).every((w) => Boolean(w.groupNotices.opening?.title && w.groupNotices.opening?.body) && w.groupNotices.opening.title !== w.groupNotices.expired.title),
    true,
  );

  part("Double click on a full purchase: A holds the link and is told full; B opens it meanwhile");
  const late = await paidGroup(2);
  is("two places, taken", [await take(await late.link("ned@example.com")), await take(await late.link("ola@example.com"))], ["taken", "taken"]);
  const lateLink = await late.link("pia@example.com");
  // Rule 23: B is refused by the link's opening hold (it throws) instead of reading "pending", which the main does not
  // have; still never "already" on a place A never got.
  is("A is told full; B is not done, never 'already' on a place A never got", await doubleClick(late.id, lateLink), ["full", "threw"]);
  is("nothing handed over, two places counted", [await owns("pia@example.com"), await placesTaken(late.id)], [[], 2]);
  is("opened again it is full, never 'already'", await take(lateLink), "full");

  part("Double click where A is handed the place: B opens it meanwhile");
  const pair = await paidGroup(2);
  const pairLink = await pair.link("quin@example.com");
  // Rule 23: B comes while A holds the link and is refused by its opening hold (it throws: "open the link again ... if
  // it was already yours, nothing changes") instead of "already"; opened again after A, it is "already".
  is("A takes the place; B, coming while A holds the link, is not done", await doubleClick(pair.id, pairLink), ["taken", "threw"]);
  is("opened again after A, it is 'already'", await take(pairLink), "already");
  is("one place counted, the product on the address", [await placesTaken(pair.id), await owns("quin@example.com")], [1, [product.id]]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
