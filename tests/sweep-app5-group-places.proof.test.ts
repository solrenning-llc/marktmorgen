/**
 * Sweep app5 proof (CX-123 rules 24 and 30), synthetic only: the in-memory Redis double, no network.
 *
 * app/[handle]/group/[group]/page.tsx:132 reads the places already taken with
 * `placesTaken(group.id).catch(() => 0)`, and lib/group-buy.ts:155-160 (`placesTaken`) reads its GET with
 * `Number(raw)`, an unknown shape being 0. Either way a purchase whose places are ALL taken is shown to whoever holds
 * the link as "2 of 2 places are still open", with the "Send me the link to my place" form. The person types an
 * address and asks for a place that does not exist (and, with the same unknown reply, askPlace sends the email: sweep
 * A3, part 2).
 *
 * Healthy control first; the checks named DEFECT pass while the defect is present.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { placesTaken, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import GroupPage from "@/app/[handle]/group/[group]/page";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app5_groups_only";
  const OWNER = "sweepapp5group@example.com";
  await claimHandle(OWNER, "sweepappgroup", "Sweep App Group", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSweepApp501", true);
  await setSubscription(OWNER, { customerId: "cus_SweepApp500001", subscriptionId: "sub_SweepApp500001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const started = await startGroup(store, product, "2");
  if (!started.ok) throw new Error("no group");
  const id = started.group.id;
  const session = { id: "cs_test_" + "q".repeat(24), created: 1_900_000_000, amount_total: 9800, currency: "usd", payment_intent: "pi_SweepApp500001", metadata: { store: "sweepappgroup", product: product.id, group: id, people: "2" }, customer_details: { email: "buyer@example.com" } };
  const settled = await settleGroup({ store, session, product, base: "https://marktmorgen.com/@sweepappgroup", from: '"Sweep" <hello@marktmorgen.com>' });
  if (settled !== "settled") throw new Error("not settled");
  store = (await storeForEmail(OWNER))!;
  for (const email of ["ana@example.com", "ben@example.com"]) {
    const t = Buffer.from(email.padEnd(32, "x").slice(0, 32)).toString("hex");
    await real([["SET", `nl:grp:take:${t}`, JSON.stringify({ g: id, e: email }), "EX", 3600]]);
    await takePlace({ store, token: t, recordStart: async () => {} });
  }
  const render = async () =>
    renderToStaticMarkup(await GroupPage({ params: Promise.resolve({ handle: "@sweepappgroup", group: id }), searchParams: Promise.resolve({}) }));
  const facts = (html: string) => ({ allTaken: html.includes("All 2 places have been taken."), open: /2 of 2 places are still open/.test(html), form: html.includes("Send me the link to my place") });
  const onTaken = (reply: () => unknown) => {
    redis.pipeline = (async (commands: Command[]) => {
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:grp:${id}:n`) return [reply()];
      return real(commands);
    }) as typeof redis.pipeline;
  };

  part("Healthy control: both places taken");
  is("placesTaken reads 2", await placesTaken(id), 2);
  is("the page says all places are taken and offers no form", facts(await render()), { allTaken: true, open: false, form: false });

  part("DEFECT 1: the GET of the places count answers in an unknown shape (lib/group-buy.ts:157-159)");
  onTaken(() => ({ unexpected: true }));
  is("DEFECT: placesTaken answers 0, as for a group nobody joined", await placesTaken(id), 0);
  is("DEFECT: the page says both places are still open and offers the form", facts(await render()), { allTaken: false, open: true, form: true });
  redis.pipeline = real;

  part("DEFECT 2: the read throws (Redis unreachable); the page's .catch(() => 0) (page.tsx:132)");
  onTaken(() => {
    throw new Error("synthetic: Redis unreachable");
  });
  is("DEFECT: the page still says both places are open and offers the form", facts(await render()), { allTaken: false, open: true, form: true });
  redis.pipeline = real;

  part("Control again after the stand-in is removed");
  is("all taken again", facts(await render()), { allTaken: true, open: false, form: false });
  done();
}

void main();
