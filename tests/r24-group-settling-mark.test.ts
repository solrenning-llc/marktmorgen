/**
 * A purchase for several people is settled on a once-only mark that is ours (lib/group-buy.ts, settleGroup; rule 24).
 *
 * Before: only a nil reply to the `:settling` mark was "already being settled"; a reply cut short or of another
 * shape went on to settle, and its closing DEL took away the mark of the run that really held it. Now the mark is
 * taken with claimMark: "taken" is already, "unknown" settles nothing and throws (the confirmation is tried again),
 * and the mark is let go only while it holds this run's own value.
 *
 * Synthetic store, Stripe and email stand-ins only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readGroup, settleGroup, startGroup } from "@/lib/group-buy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
let settlingReply: unknown[] | null = null;
redis.pipeline = (async (b: Batch) => {
  if (settlingReply && b.length === 1 && b[0][0] === "SET" && String(b[0][1]).endsWith(":settling")) return settlingReply;
  return original(b);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_groups_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;

  for (const [label, reply] of [["no reply", []], ["a number", [7]], ["two replies", ["OK", "OK"]]] as [string, unknown[]][]) {
    part(`The settling mark answered as ${label}`);
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no purchase for several");
    const id = started.group.id;
    const session = {
      id: "cs_test_" + id.slice(0, 24).padEnd(24, "t"),
      created: 1_900_000_000,
      amount_total: 9800,
      currency: "usd",
      payment_intent: "pi_Group" + id.slice(0, 8),
      metadata: { store: "harbor", product: product.id, group: id, people: "2" },
      customer_details: { email: "buyer@example.com" },
    };
    const before = emails.length;
    settlingReply = reply;
    const outcome = await settleGroup({ store, session, product, base: "https://marktmorgen.com/@harbor", from: "hello@marktmorgen.com" }).then(
      (o) => o,
      () => "threw",
    );
    settlingReply = null;
    is("unknown: nothing settled, tried again later", outcome, "threw");
    is("not written as paid", Boolean((await readGroup(id))?.paid), false);
    is("no receipt sent", emails.length - before, 0);
    is("settled once the mark answers", await settleGroup({ store, session, product, base: "https://marktmorgen.com/@harbor", from: "hello@marktmorgen.com" }), "settled");
  }

  part("Another run holds the mark");
  const started = await startGroup(store, product, "2");
  if (!started.ok) throw new Error("no purchase for several");
  const id = started.group.id;
  await original([["SET", `nl:grp:${id}:settling`, "theirs", "EX", 300]]);
  const keys = await original([["EXISTS", `nl:grp:${id}:settling`]]);
  is("(the mark's key is the one settleGroup uses)", keys[0], 1);
  const session = {
    id: "cs_test_" + id.slice(0, 24).padEnd(24, "u"),
    created: 1_900_000_000,
    amount_total: 9800,
    currency: "usd",
    payment_intent: "pi_GroupX" + id.slice(0, 8),
    metadata: { store: "harbor", product: product.id, group: id, people: "2" },
    customer_details: { email: "buyer@example.com" },
  };
  is("already", await settleGroup({ store, session, product, base: "https://marktmorgen.com/@harbor", from: "hello@marktmorgen.com" }), "already");
  is("their mark is left as it is", (await original([["GET", `nl:grp:${id}:settling`]]))[0], "theirs");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
