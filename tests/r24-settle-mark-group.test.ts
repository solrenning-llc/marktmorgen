/**
 * A purchase for several people (lib/group-buy.ts, settleGroup) is settled
 * under a `:settling` mark claimed with this run's own value and read exactly
 * (CX-123 rule 24, lib/claim-mark.ts). That code is #2872's (Claude 5); these
 * checks are what #3275 adds on top of it, none of them in #2872's own tests
 * (tests/gift-group-exact.test.ts, gift-group-landed.test.ts,
 * group-place-hold.test.ts):
 *
 *   - the mark answered in every shape that is not "OK" or nil, both when the
 *     write was lost (unknown: nothing marked paid or sent, settled once on the
 *     next run) and when it landed (read back as this run's own: settled once);
 *   - a mark another run holds while that run marks the group paid: "already",
 *     nothing sent again;
 *   - another run's mark, written just before this run lets go of its own, is
 *     never deleted (compare and delete);
 *   - through the whole confirmation (lib/purchase-email.ts confirmPurchase):
 *     a mark that landed but could not be read back, and could not be let go,
 *     never leaves the confirmation's "sent" mark on a group not paid; the group
 *     is settled once after the mark runs out (Claude 2 and Claude 6, MEDIUM).
 *
 * Depends on #2872 (and #2992, stacked on it): on main before it, these fail.
 * Synthetic data and a stand-in for the sender only: no real account, payment,
 * buyer or email.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readGroup, settleGroup, startGroup } from "@/lib/group-buy";
import { UnknownReplyError } from "@/lib/redis-reply";
import { confirmPurchase } from "@/lib/purchase-email";
import { paidPeriod } from "./billing-period-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_r24_claim_exact";
// One of the synthetic sending keys the stand-in sender knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_groups_only";

const S = Math.floor(Date.now() / 1000);
let emails = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails += 1;
    return answer({ id: `email_r24claim${emails}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The replies that are not Redis's own "OK" or nil for a SET NX. `SHORT` stands for a reply with no slot at all. */
const SHORT = Symbol("short");
const ODD: [string, unknown][] = [
  ["no answer in its slot", undefined],
  ["an empty string", ""],
  ["an object", {}],
  ["a number", 1],
  ["a queued answer", "QUEUED"],
  ["a short reply", SHORT],
];

/**
 * Answers the one SET NX that `pick` names in the odd shape: "lost" without writing it, "landed" after writing it.
 * Every other command is the stand-in's own.
 */
async function oddClaim<T>(pick: (command: (string | number)[]) => boolean, reply: unknown, how: "lost" | "landed", run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "SET" && commands[0].includes("NX") && pick(commands[0])) {
      if (how === "landed") await original(commands);
      return reply === SHORT ? [] : [reply];
    }
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

/**
 * The SET NX that `pick` names lands but answers `reply`, and reading it back fails too (Claude 2 and Claude 6 on
 * #3275): claimMark says "unknown" although the mark is there. With `releaseFails`, letting it go fails as well.
 */
async function landedUnreadable<T>(pick: (command: (string | number)[]) => boolean, reply: unknown, releaseFails: boolean, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  let key = "";
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "SET" && commands[0].includes("NX") && pick(commands[0])) {
      key = String(commands[0][1]);
      await original(commands);
      return [reply];
    }
    if (key && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key) throw new Error("synthetic Redis outage");
    if (key && releaseFails && commands.length === 1 && commands[0][0] === "EVAL" && commands[0].includes(key)) throw new Error("synthetic Redis outage");
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

async function groups() {
  redis.clear();
  const OWNER = "r24claim-groups@example.com";
  await claimHandle(OWNER, "r24grp", "Groups", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_TestR24Group1", true);
  await setSubscription(OWNER, { customerId: "cus_R24Group01", subscriptionId: "sub_R24Group01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Bread Class", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/class");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  let n = 0;
  const newGroup = async () => {
    n += 1;
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no purchase for several");
    const id = started.group.id;
    const session = {
      id: `cs_test_r24grp${String(n).padStart(10, "0")}`, created: S, amount_total: 9800, currency: "usd",
      payment_intent: `pi_TestR24Grp${String(n).padStart(6, "0")}`,
      metadata: { store: "r24grp", product: product.id, group: id, people: "2" },
      customer_details: { email: "buyer@example.com" },
    };
    const settle = () => settleGroup({ store, session, product, base: "https://marktmorgen.com/@r24grp", from: '"Groups" <hello@marktmorgen.com>' });
    // The whole confirmation, as the thanks page and the sweep run it, on the checkout as Stripe gives it.
    const known = { ...session, status: "complete", payment_status: "paid" };
    const confirm = () => confirmPurchase(store, session.id, known as unknown as Parameters<typeof confirmPurchase>[2]);
    return { id, settle, confirm, sessionId: session.id };
  };
  const theMark = (id: string) => (command: (string | number)[]) => command[1] === `nl:grp:${id}:settling`;
  const failure = (run: () => Promise<unknown>) => run().then((value) => `resolved ${String(value)}`, (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`));

  part("Settling a purchase for several: healthy controls");
  {
    const { id, settle } = await newGroup();
    const before = emails;
    is("an OK mark: settled once, one receipt", [await settle(), Boolean((await readGroup(id))?.paid), emails - before], ["settled", true, 1]);
    is("settled again: already, nothing more sent", [await settle(), emails - before], ["already", 1]);
  }
  {
    const { id, settle } = await newGroup();
    const before = emails;
    // The other run marks the group paid between this run's first read and its claim.
    const original = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === "SET" && commands[0].includes("NX") && commands[0][1] === `nl:grp:${id}:settling`) {
        const [raw] = await original([["GET", `nl:grp:${id}`]]);
        await original([["SET", `nl:grp:${id}`, JSON.stringify({ ...JSON.parse(String(raw)), paid: Date.now() }), "EX", 3600]]);
        return [null];
      }
      return original(commands);
    }) as typeof redis.pipeline;
    const raced = await failure(settle).finally(() => {
      redis.pipeline = original;
    });
    is("a nil mark, the group paid by the other run: already, nothing sent again", [raced, emails - before], ["resolved already", 0]);
  }
  {
    const { id, settle } = await newGroup();
    // Another run takes the mark while this run is past its claim (its 300 seconds ran out, say): from the group's own
    // paid write on, nothing this run sends may delete it (Claude 2 LOW 2 on #3275: compare and delete, never DEL).
    const key = `nl:grp:${id}:settling`;
    const record = `nl:grp:${id}`;
    const original = redis.pipeline.bind(redis);
    let claimed = false;
    let taken = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "SET" && c[1] === key && c.includes("NX"))) claimed = true;
      else if (claimed && !taken && commands.some((c) => c[0] !== "GET" && c.includes(record))) {
        taken = true;
        await original([["SET", key, "another-run", "EX", 300]]);
      }
      return original(commands);
    }) as typeof redis.pipeline;
    const own = await failure(settle).finally(() => {
      redis.pipeline = original;
    });
    is("settled, and another run's mark is never deleted", [own, taken, (await redis.pipeline([["GET", key]]))[0]], ["resolved settled", true, "another-run"]);
  }

  for (const [label, reply] of ODD) {
    part(`Settling a purchase for several, the mark answered with ${label}`);
    const { id, settle } = await newGroup();
    const before = emails;
    const lost = await oddClaim(theMark(id), reply, "lost", () => failure(settle));
    is(`${label}, not written: an unknown reply, tried again later`, lost, "unknown");
    is(`${label}, not written: not marked paid, no receipt`, [Boolean((await readGroup(id))?.paid), emails - before], [false, 0]);
    is(`${label}: tried again with Redis answering as it should, settled once`, [await settle(), emails - before], ["settled", 1]);

    const landed = await newGroup();
    const landedBefore = emails;
    const ours = await oddClaim(theMark(landed.id), reply, "landed", landed.settle);
    is(`${label}, but the write landed (read back as this mark's own): settled once`, [ours, emails - landedBefore], ["settled", 1]);
  }

  // Claude 2 and Claude 6 on #3275 (MEDIUM): the mark lands, its reply, its read-back and letting it go all fail, and
  // the buyer reloads the thanks page within the mark's 300 seconds. The confirmation must never keep its "sent" mark
  // on a group not paid, and the group is settled once after the mark runs out.
  part("Through the confirmation: a landed mark not read back and not let go");
  {
    const { id, confirm, sessionId } = await newGroup();
    const before = emails;
    const confirmMark = async () => (await redis.pipeline([["GET", `nl:confirm:${sessionId}`]]))[0];
    const thrown = (run: () => Promise<unknown>) => run().then((value) => `resolved ${String(value)}`, () => "thrown");
    const first = await landedUnreadable(theMark(id), "QUEUED", true, () => failure(confirm));
    is("first run: unknown, not paid, no receipt, no confirmation mark", [first, Boolean((await readGroup(id))?.paid), emails - before, await confirmMark()], ["unknown", false, 0, null]);
    is("reloaded within 300 s: thrown, not paid, no receipt, no confirmation mark", [await thrown(confirm), Boolean((await readGroup(id))?.paid), emails - before, await confirmMark()], ["thrown", false, 0, null]);
    advance(301_000);
    is("after the mark ran out: settled once", [await thrown(confirm), Boolean((await readGroup(id))?.paid), emails - before], ["resolved sent", true, 1]);
    is("and confirmed again: already, nothing sent twice", [await thrown(confirm), emails - before], ["resolved already", 1]);
  }
}

async function main() {
  await groups();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
