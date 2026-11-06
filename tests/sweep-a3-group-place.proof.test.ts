/**
 * Sweep A3 proof (CX-123 rule 24), synthetic only: the in-memory Redis double and an email stand-in. lib/group-buy.ts:
 *
 * 1. takePlace, lines 465-469: the INCR that counts places is read with `Number(count) > group.people`. An answer in
 *    an unknown shape is NaN, which is never greater, so the place is handed over (grantImported, line 488) past the
 *    number paid for: the file's own promise "Never one place more than was paid for" fails, and the product is
 *    given away for nothing.
 * 2. askPlace, lines 361-373: the places count (`Number(takenRaw) || 0`) and the per-purchase daily email count
 *    (`Number(sentRaw) > group.people * 3 + 10`) read an unknown answer as 0 / NaN: the cap that keeps the link from
 *    being used to fill strangers' inboxes is skipped: a place link is written and the email handed to the sender.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { askPlace, placesTaken, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const emails: { to: string[] }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as { to: string[] });
    return new Response(JSON.stringify({ id: "e" }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_sweep_a3_groups_only";
  process.env.RESEND_API_KEY = "re_test_sweep_a3_groups_only";
  const OWNER = "sweepa3group@example.com";
  await claimHandle(OWNER, "sweepgroup", "Sweep Group", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSweepGrp01", true);
  await setSubscription(OWNER, { customerId: "cus_SweepGrp00001", subscriptionId: "sub_SweepGrp00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const started = await startGroup(store, product, "2");
  if (!started.ok) throw new Error("no group");
  const id = started.group.id;
  const base = "https://marktmorgen.com/@sweepgroup";
  const from = '"Sweep Group" <hello@marktmorgen.com>';
  const session = { id: "cs_test_" + "p".repeat(24), created: 1_900_000_000, amount_total: 9800, currency: "usd", payment_intent: "pi_SweepGrp000001", metadata: { store: "sweepgroup", product: product.id, group: id, people: "2" }, customer_details: { email: "buyer@example.com" } };
  if ((await settleGroup({ store, session, product, base, from })) !== "settled") throw new Error("not settled");
  store = (await storeForEmail(OWNER))!;
  const token = async (email: string) => {
    const t = Buffer.from(email.padEnd(32, "x").slice(0, 32)).toString("hex");
    await real([["SET", `nl:grp:take:${t}`, JSON.stringify({ g: id, e: email }), "EX", 3600]]);
    return t;
  };
  const take = async (email: string) => (await takePlace({ store, token: await token(email), recordStart: async () => {} })).outcome;

  part("1. takePlace: healthy control (2 places paid for)");
  is("two taken, the third told full", [await take("ana@example.com"), await take("ben@example.com"), await take("cy@example.com"), await placesTaken(id)], ["taken", "taken", "full", 2]);
  is("nothing handed to the third", (await importedFor({ ...store, pastBuyers: true }, "cy@example.com")).length, 0);

  part("1. DEFECT: the INCR of the places answers in an unknown shape (the count still moves)");
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    return commands.length === 1 && commands[0][0] === "INCR" && String(commands[0][1]).endsWith(":n") ? [{ unexpected: true }] : replies;
  }) as typeof redis.pipeline;
  const third = await take("dee@example.com");
  redis.pipeline = real;
  is("DEFECT: a third place is taken on a purchase paid for two", third, "taken");
  is("DEFECT: and the product is handed to that address", (await importedFor({ ...store, pastBuyers: true }, "dee@example.com")).map((p) => p.productId), [product.id]);

  part("2. askPlace: healthy control, the day's email cap (2 x 3 + 10 = 16) reached");
  // Whether the cap was passed is read from what askPlace does after it: it writes the place's link (SET
  // nl:grp:take:...) and then hands the email to the sender. The email transport itself is not stood in here.
  const links: string[] = [];
  const watching = (unknownMail: boolean) => {
    redis.pipeline = (async (commands: Command[]) => {
      for (const c of commands) if (c[0] === "SET" && String(c[1]).startsWith("nl:grp:take:")) links.push(String(c[2]));
      const replies = await real(commands);
      return unknownMail && commands.length === 1 && commands[0][0] === "INCR" && String(commands[0][1]).endsWith(":mail") ? [{ unexpected: true }] : replies;
    }) as typeof redis.pipeline;
  };
  await real([["SET", `nl:grp:${id}:mail`, "16", "EX", 86_400], ["SET", `nl:grp:${id}:n`, "0"]]);
  const ask = (email: string) => askPlace({ store, id, email, product, base, from, ordersLink: async () => null });
  watching(false);
  const healthy = await ask("eve@example.com");
  redis.pipeline = real;
  is("slow: no link written, nothing handed to the sender", [healthy, links.length], ["slow", 0]);

  part("2. DEFECT: the INCR of the day's emails answers in an unknown shape (the count still moves)");
  watching(true);
  const asked = await ask("fay@example.com");
  redis.pipeline = real;
  is("DEFECT: past the cap it is not 'slow': a link for fay is written and the email is handed to the sender", [asked === "slow", links.some((l) => l.includes("fay@example.com"))], [false, true]);
  is("the day's count did move past the cap (18 after the two asks), which the code could not read", (await real([["GET", `nl:grp:${id}:mail`]]))[0], "18");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
