/**
 * A place's hold let go only while it is this run's own (Claude 6 on #2872; CX-123 rules 24, 25 and 30), synthetic
 * only: the in-memory Redis double and an email stand-in; no Stripe, no real email.
 *
 * The same place link opened twice at once (a double click): run A holds the place and is handed the product; run B's
 * HSETNX really answers 0 but comes back in an unknown shape. B must never delete A's record of the place: the list
 * of who took a place is what a full refund walks (revokeRefundedGroups, HGETALL), so with A's record gone a refund
 * would leave A the product. Beside it, the healthy control and the cases where the hold is B's own (its HSETNX
 * landed, answered unknown; the places counter answered unknown), which are let go so the link works again.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { placesTaken, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
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

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_group_place_hold_only";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  const OWNER = "groupplacehold@example.com";
  await claimHandle(OWNER, "placehold", "Place Hold", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPlaceHold01", true);
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
  const isLook = (id: string) => (c: Command) => c[0] === "HEXISTS" && c[1] === `nl:grp:${id}:m`;

  part("Healthy control: one open of the link takes the place, and the list holds it");
  const healthy = await paidGroup(2);
  const healthyLink = await healthy.link("ana@example.com");
  is("taken, the product handed over, one place counted", [await take(healthyLink), await owns("ana@example.com"), await placesTaken(healthy.id)], ["taken", [product.id], 1]);
  is("the list a refund walks holds that place", await members(healthy.id), { length: 2, held: ["ana@example.com"] });
  is("opened again it is 'already', the list unchanged", [await take(healthyLink), (await members(healthy.id)).length], ["already", 2]);

  part("Double click: A holds the place; B's HSETNX answers 0 but comes back in an unknown shape");
  const twice = await paidGroup(2);
  const twiceLink = await twice.link("ben@example.com");
  // Both runs look first (HEXISTS, HEXISTS: nobody holds it), then A's HSETNX lands (1), then B's answers 0 and is
  // handed back unknown. A goes on and is handed the product; B refuses.
  let looks = 0;
  let holds = 0;
  let bothLooked: () => void = () => {};
  const looked = new Promise<void>((resolve) => {
    bothLooked = resolve;
  });
  let firstHeld: () => void = () => {};
  const aHeld = new Promise<void>((resolve) => {
    firstHeld = resolve;
  });
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.some(isHold(twice.id))) {
      await looked;
      const mine = ++holds;
      if (mine === 2) await aHeld;
      const replies = await real(commands);
      if (mine === 1) firstHeld();
      return mine === 2 ? commands.map((c, i) => (isHold(twice.id)(c) ? UNKNOWN : replies[i])) : replies;
    }
    const replies = await real(commands);
    if (commands.some(isLook(twice.id)) && ++looks === 2) bothLooked();
    return replies;
  }) as typeof redis.pipeline;
  const [a, b] = await Promise.all([take(twiceLink), take(twiceLink)]);
  restore();
  is("A takes the place, B refuses (a temporary error)", [a, b], ["taken", "threw"]);
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

  part("The places counter answers in an unknown shape: the run lets go of its own record");
  const counted = await paidGroup(2);
  const countedLink = await counted.link("dee@example.com");
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands.filter((c) => !(c[0] === "INCR" && c[1] === `nl:grp:${counted.id}:n`)));
    let k = 0;
    return commands.map((c) => (c[0] === "INCR" && c[1] === `nl:grp:${counted.id}:n` ? UNKNOWN : replies[k++]));
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
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
