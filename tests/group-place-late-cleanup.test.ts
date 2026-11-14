/**
 * Codex C2's proposed HIGH on #2872 (6768174519, at b4c1916c): an open's cleanup took its address's mark off with
 * an unconditional HDEL. One that timed out at transport and landed later deleted the mark of the open that came
 * after it, which had taken the place for good: two paid places ended with three owners and two marks listed.
 *
 * Now each open writes its own token into the mark (o), an open that picks up an earlier open's mark claims it by
 * compare-and-set before anything is handed over, and a cleanup deletes the mark only while it is still exactly the
 * one that open wrote (one script, PLACE_DROP): an earlier request can never delete a later open's place.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { settleGroup, startGroup, takePlace } from "@/lib/group-buy";
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

  part("A cleanup that lands late never deletes the place of the open that came after it");
  const g = await paidGroup(2);
  const ana = await g.link("ana@example.com");
  const marks = `nl:grp:${g.id}:m`;
  // A: its mark lands, the count's answer is of another shape, and its first cleanup times out in transport, to land later.
  let late: Command[] | null = null;
  let stage: "count" | "cleanup" | "off" = "count";
  redis.pipeline = (async (commands: Command[]) => {
    const onMarks = commands.some((c) => c[1] === marks || (c[0] === "EVAL" && c[3] === marks));
    if (stage === "count" && commands.some((c) => c[0] === "HLEN" && c[1] === marks) && commands.some((c) => c[0] === "HSETNX")) {
      const replies = await real(commands);
      stage = "cleanup";
      return replies.map((r, i) => (commands[i][0] === "HLEN" ? UNKNOWN : r)) as never;
    }
    if (stage === "cleanup" && onMarks && commands.length === 1 && (commands[0][0] === "HDEL" || commands[0][0] === "EVAL")) {
      late = commands;
      stage = "off";
      throw new Error("timed out (stand-in)");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const first = await take(ana);
  restore();
  is("A: not done (the count was not known)", first, "threw");
  is("A's late cleanup is in flight", late !== null, true);
  // B: the same address's link opened again, and the place taken for good.
  is("B: the place is taken", await take(ana), "taken");
  is("B owns the product", (await owns("ana@example.com")).includes(product.id), true);
  // A's cleanup lands now.
  if (late) await real(late);
  is("B's place is still listed after A's late cleanup", (await members(g.id)).held.includes("ana@example.com"), true);
  // Two more addresses try the group of two.
  const bea = await take(await g.link("bea@example.com"));
  const cai = await take(await g.link("cai@example.com"));
  const owners = (await Promise.all(["ana@example.com", "bea@example.com", "cai@example.com"].map(owns))).filter((p) => p.includes(product.id)).length;
  is("never more owners than places paid for", owners <= 2, true);
  is("one more takes the last place, the other is told it is full", [bea, cai].sort(), ["full", "taken"]);
  is("and the list holds exactly the two owners", (await members(g.id)).held.length, 2);

  done();
}

void main();
