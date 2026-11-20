/**
 * CX-123 rule 24, lot L7 (Claude 4 on #2714): putting a paid order on the creator's list (lib/buyer-list.ts) decides
 * from Redis marks whether the order is already there and whether this run is the one doing it. A mark answered in an
 * unknown shape is never "not on the list yet" nor "ours": nothing is done on it this run, the run says it failed, and
 * the next run, on a whole reading, does it once. Replies the stand-in never gives by itself are injected for one
 * command only, after it ran (or instead of it, for a write that did not land).
 */
import { listOrder, listedAlready } from "@/lib/buyer-list";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

let sessions: unknown = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

/** The reply to the first pipeline whose first command is `name` on a key starting `prefix`, replaced after it ran. */
async function withReply(name: string, prefix: string, reply: (real: unknown) => unknown, run: () => Promise<unknown>, landed = true): Promise<void> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!used && commands[0]?.[0] === name && String(commands[0]?.[1] ?? "").startsWith(prefix)) {
      used = true;
      const answer = landed ? await real(commands) : undefined;
      return reply(answer);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_conditions_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_conditions_only_a_stand_in";

  const OWNER = "l7-list@example.com";
  await claimHandle(OWNER, "lsevenlist", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLsevList1", true);
  await setSubscription(OWNER, { customerId: "cus_LsevList01", subscriptionId: "sub_LsevList01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const course = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!course.ok) throw new Error("no product");
  await setProductLink(OWNER, course.product.id, "https://example.com/course");
  const store = (await storeForEmail(OWNER))!;
  const order = (id: string, email: string) => ({ sessionId: id, email, news: true, created: Math.floor(Date.now() / 1000), products: [{ id: course.product.id, title: "Weeknight Course" }] });

  part("Already on the list? Only an exact 0 or 1 says");
  redis.run(["SET", "nl:listed:cs_test_lsevenlisted0000001", "done"]);
  const ids = ["cs_test_lsevenlisted0000001", "cs_test_lsevennotyet00000001"];
  is("an exact reading", await listedAlready(ids), [true, false]);
  let read: (boolean | null)[] = [];
  await withReply("EXISTS", "nl:listed:", () => [1, undefined], async () => (read = await listedAlready(ids)));
  is("a reply missing for one: that one is unknown", read, [true, null]);
  await withReply("EXISTS", "nl:listed:", () => ["1", 0], async () => (read = await listedAlready(ids)));
  is("a count as text: unknown", read, [null, false]);
  await withReply("EXISTS", "nl:listed:", (real) => [...(real as unknown[]), 0], async () => (read = await listedAlready(ids)));
  is("more replies than were asked: all unknown", read, [null, null]);

  part("Is this run the one putting it on the list? Only OK, or our own value read back");
  let said = "";
  await withReply("SET", "nl:listed:", () => ["QUEUED"], async () => (said = await listOrder(store, order("cs_test_lsevenoddnotland0001", "ann@example.com"))), false);
  is("a claim answered oddly that did not land: nothing done this time", said, "skip");
  said = await listOrder(store, order("cs_test_lsevenoddnotland0001", "ann@example.com"));
  is("the next try does it", said, "done");
  await withReply("SET", "nl:listed:", () => ["QUEUED"], async () => (said = await listOrder(store, order("cs_test_lsevenoddlanded00001", "bob@example.com"))));
  is("a claim answered oddly that did land with our own value: ours, and done", said, "done");
  is("and never twice", await listOrder(store, order("cs_test_lsevenoddlanded00001", "bob@example.com")), "already");

  part("A run that fails lets go only of its own claim (Revisor 1 on #2719)");
  {
    const real = redis.pipeline.bind(redis);
    let tripped = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const first = String(commands[0]?.[1] ?? "");
      if (!tripped && !first.startsWith("nl:listed:")) {
        // This run's claim ran out while it worked, another run took it, and this run then fails.
        tripped = true;
        redis.run(["SET", "nl:listed:cs_test_lsevenslowrun000001", "another-run"]);
        throw new Error("a stand-in failure while putting the order on the list");
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const errors = console.error;
    console.error = () => {};
    try {
      said = await listOrder(store, order("cs_test_lsevenslowrun000001", "dee@example.com"));
    } finally {
      redis.pipeline = real;
      console.error = errors;
    }
    is("the failing run says skip, and the other run's claim is left alone", [said, redis.run(["GET", "nl:listed:cs_test_lsevenslowrun000001"])], ["skip", "another-run"]);
  }

  part("The sweep: a mark it cannot read is not 'not listed', and the run says it failed");
  sessions = [{
    id: "cs_test_lsevensweep00000001", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 600, amount_total: 4900, currency: "usd",
    customer_details: { email: "cy@example.com" }, metadata: { store: "lsevenlist", product: course.product.id, news: "yes" },
  }];
  let counts = { listed: -1, failed: -1 };
  await withReply("EXISTS", "nl:listed:", () => [undefined], async () => (counts = await sweepCheckouts(Date.now() + 20_000)));
  is("unknown: not put on the list this run, and counted as failed", [counts.listed, counts.failed >= 1], [0, true]);
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("the next whole reading puts it on the list, once", counts.listed, 1);
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("and not again", counts.listed, 0);
  done();
}

void main();
