/**
 * A shipment's done-mark is written only while its store is live (#5258, #5010 row 127, Codex
 * X4-20261119-2249): markShipped reads the store and the paid order, then wrote nl:ship:done:<session> with a plain
 * SET NX EX (markNeverActivated, markWithoutQueuedMail). A request held up after those checks, while the store was
 * erased or marked erasing, still wrote the tracking for 400 days and, on the never-activated path, went on to email
 * the buyer. The mark is now taken in one step with the store's fence (lib/store-live-cache.ts
 * claimOnceWhileStoreLive, the rule of lib/live-fence.ts): a store gone, erasing, whose id key now names another ref,
 * or from before ids and replaced (or with no statsId, or a record that does not parse) gets nothing written, no email, and the answer "unknown".
 *
 * The request is paused right before the mark's write (the pipeline is held on the batch that writes the mark), the
 * store's state is changed, and production markShipped resumes. Synthetic store, order, buyer and providers; in-memory
 * Redis. The whole studio route (POST /api/store/shipped) is measured against the studio unit's commands (coordinator
 * 964c).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as shippedRoute } from "@/app/api/store/shipped/route";
import { SHIPMENT_MARK_COMMANDS, doneKey, markShipped } from "@/lib/shipments";
import { TAKE_SCRIPTS } from "@/lib/redis-memory-take";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { installSesMailFixture } from "./ses-mail-fixture";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const OWNER = "ship-erase@example.test";
const OTHER = "ship-erase-other@example.test";
let row: Record<string, unknown> = {};
const stripe = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname.includes("/checkout/sessions/")) return new Response(JSON.stringify(row), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;
globalThis.fetch = stripe;
process.env.STRIPE_SECRET_KEY = "sk_test_shipment_erasure_only_a_stand_in";

/** The batch that writes the done-mark: the plain SET of before, or any EVAL naming the mark's key. */
const writesMark = (commands: Command[], session: string) =>
  commands.some((c) => (c[0] === "SET" && c[1] === doneKey(session)) || (c[0] === "EVAL" && c.slice(3).includes(doneKey(session))));

async function shop(withId: boolean): Promise<Store> {
  redis.clear();
  if (!(await claimHandle(OWNER, "shiperase", "Fictional Ships", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1ShipErase0001", true);
  await setSubscription(OWNER, { customerId: "cus_shiperase01", subscriptionId: "sub_shiperase01", active: true, tier: "pro", period: paidPeriod() });
  const made = (await storeForEmail(OWNER))!;
  if (!made.sid || !made.statsId) throw new Error("unexpected store shape");
  // A store kept from before ids has no sid: it is fenced on its owner's record and its statsId (tests/store-claim-live).
  return withId ? made : { ...made, sid: "", extra: false };
}

const STATES = ["live", "other-erasing", "erased", "erasing", "moved", "replaced", "unparsable", "no-statsid"] as const;
type State = (typeof STATES)[number];
const allowed = (state: State) => state === "live" || state === "other-erasing";

/** What happens to the store while the request is held, right before the mark's write. */
async function interleave(store: Store, state: State): Promise<void> {
  const owner = await ownerKey(storeRef(store));
  if (state === "other-erasing") redis.run(["HSET", ERASING_KEY, await erasingField(OTHER), String(Date.now())]);
  if (state === "erasing") redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]);
  if (state === "erased") {
    // closeStoreRecord deletes the id key and the record together.
    if (store.sid) redis.run(["DEL", storeIdCommand(store.sid)[1]]);
    redis.run(["DEL", owner]);
  }
  if (state === "moved") redis.run(["SET", storeIdCommand(store.sid)[1], "someone-else@example.test"]);
  if (state === "replaced") {
    // The owner made a new store under the same address after the old one was erased: another statsId.
    const record = JSON.parse(String(redis.run(["GET", owner]))) as Record<string, unknown>;
    redis.run(["SET", owner, JSON.stringify({ ...record, statsId: "replacementStats000001" })]);
  }
  if (state === "unparsable") redis.run(["SET", owner, "not json"]);
}

// The never-activated one-shot path with and without a usable address (markNeverActivated), and the active path's
// two calls of markWithoutQueuedMail: no usable address, and a full mail pool (the outbox answers "full").
const PATHS = ["legacy-mail", "legacy-no-mail", "active-no-recipient", "active-full"] as const;
const fullPool = async (commands: Command[]) => commands.map((c) => (c[0] === "EVAL" ? ["full"] : null));

async function main(): Promise<void> {
  const real = redis.pipeline.bind(redis);
  const sender = installSesMailFixture({ fallback: stripe });
  sender.configure();
  try {
    for (const withId of [true, false]) {
      for (const state of STATES) {
        if (state === "moved" && !withId) continue; // only a store with an id has an id key to repoint
        if ((state === "replaced" || state === "unparsable" || state === "no-statsid") && withId) continue; // only a store from before ids is told by its statsId
        for (const path of PATHS) {
          part(`Held before the mark: ${withId ? "store with an id" : "store from before ids"}, ${state}, ${path}`);
          const fresh = await shop(withId);
          // A store from before ids with no statsId cannot be told from its owner's next one.
          const store = state === "no-statsid" ? { ...fresh, statsId: null } : fresh;
          const session = `cs_test_shiperase${withId ? "id" : "lg"}${state.replace(/-/g, "")}${path.replace(/-/g, "")}`.slice(0, 60);
          row = {
            id: session, status: "complete", payment_status: "paid",
            metadata: { store: store.handle, ship: "yes", title: "Fictional Lamp" },
            customer_details: { email: path === "legacy-mail" || path === "active-full" ? "buyer@example.test" : "not an address" },
          };
          let held = false;
          redis.pipeline = (async (commands: Command[]) => {
            if (!held && writesMark(commands, session)) {
              held = true;
              await interleave(store, state);
            }
            return real(commands);
          }) as typeof redis.pipeline;
          const before = sender.sent.length;
          const runtime = path === "active-no-recipient"
            ? { lifecycle: "active" as const, policy: shipmentPolicy(), pipeline: shipmentOutboxFixture().pipeline }
            : path === "active-full" ? { lifecycle: "active" as const, policy: shipmentPolicy(), pipeline: fullPool } : {};
          let result: Awaited<ReturnType<typeof markShipped>>;
          try {
            result = await markShipped(store, session, "https://example.test/track/synthetic-parcel", undefined, runtime);
          } finally {
            redis.pipeline = real;
          }
          const kept = redis.run(["GET", doneKey(session)]);
          if (state === "no-statsid") is("with no statsId to tell the store by, no write of the mark is even sent", held, false);
          else is("the request was held right before the mark's write", held, true);
          if (allowed(state)) {
            is("a live store marks the order shipped", [result.ok, result.ok && result.shipped.tracking], [true, "https://example.test/track/synthetic-parcel"]);
            is("its mark and tracking are kept, for 400 days", [kept !== null, Number(redis.run(["TTL", doneKey(session)]))], [true, 400 * 86_400]);
            is("the buyer is emailed only on the path that emails", sender.sent.length - before, path === "legacy-mail" ? 1 : 0);
            const again = await markShipped(store, session, "https://example.test/track/second", undefined, runtime);
            is("a second press keeps the first mark and sends nothing more", [again.ok && again.shipped.tracking, again.ok && again.emailed, sender.sent.length - before], ["https://example.test/track/synthetic-parcel", false, path === "legacy-mail" ? 1 : 0]);
          } else {
            is("the answer is unknown, never shipped", result.ok ? "shipped" : result.reason, "unknown");
            is("no mark and no tracking are written", kept, null);
            is("no email is sent to the buyer", sender.sent.length - before, 0);
          }
        }
      }
    }
  } finally {
    redis.pipeline = real;
  }

  part("Any answer to the fenced mark other than the script's own codes is unknown: no mark confirmed, no email");
  {
    try {
      const store = await shop(true);
      const replies: unknown[] = [null, undefined, "OK", false, true, 2, -3, "1", {}, [], [null], ["OK"], [2], [-3], ["1"], [1, 1], [-2], Array(1)];
      for (const reply of replies) {
        const session = `cs_test_shipereasereply${replies.indexOf(reply).toString().padStart(4, "0")}`;
        row = { id: session, status: "complete", payment_status: "paid", metadata: { store: store.handle, ship: "yes" }, customer_details: { email: "buyer@example.test" } };
        const before = sender.sent.length;
        redis.pipeline = (async (commands: Command[]) => writesMark(commands, session) ? reply : real(commands)) as typeof redis.pipeline;
        let result: Awaited<ReturnType<typeof markShipped>>;
        try {
          result = await markShipped(store, session, "");
        } finally {
          redis.pipeline = real;
        }
        is(`reply ${JSON.stringify(reply) ?? "undefined"}: unknown, nothing sent`, [result.ok ? "shipped" : result.reason, sender.sent.length - before], ["unknown", 0]);
      }
      const session = "cs_test_shipereaselostack0001";
      row = { id: session, status: "complete", payment_status: "paid", metadata: { store: store.handle, ship: "yes" }, customer_details: { email: "buyer@example.test" } };
      redis.pipeline = (async (commands: Command[]) => {
        if (writesMark(commands, session)) {
          await real(commands);
          throw new Error("synthetic lost answer");
        }
        return real(commands);
      }) as typeof redis.pipeline;
      const before = sender.sent.length;
      let lost: Awaited<ReturnType<typeof markShipped>>;
      try {
        lost = await markShipped(store, session, "https://example.test/track/lost");
      } finally {
        redis.pipeline = real;
      }
      is("a mark whose answer was lost is unknown and sends nothing; it is never deleted", [lost.ok, sender.sent.length - before, JSON.parse(String(redis.run(["GET", doneKey(session)]))).tracking], [false, 0, "https://example.test/track/lost"]);
      const retried = await markShipped(store, session, "https://example.test/track/retry");
      is("a retry finds that mark and still sends nothing", [retried.ok && retried.shipped.tracking, retried.ok && retried.emailed, sender.sent.length - before], ["https://example.test/track/lost", false, 0]);
    } finally {
      redis.pipeline = real;
    }
  }

  part("The whole studio request that marks an order shipped stays inside the studio unit's commands (coordinator 964c)");
  {
    try {
      const envelope = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
      const measure = async (session: string, email: string, label: string) => {
        const store = (await storeForEmail(OWNER))!;
        row = { id: session, status: "complete", payment_status: "paid", metadata: { store: store.handle, ship: "yes" }, customer_details: { email } };
        const cookie = await openSession(OWNER);
        const sent: Command[] = [];
        let bytes = 0;
        redis.pipeline = (async (commands: Command[]) => {
          sent.push(...commands);
          const replies = await real(commands);
          bytes += Buffer.byteLength(JSON.stringify(commands)) + Buffer.byteLength(JSON.stringify(replies) ?? "");
          return replies;
        }) as typeof redis.pipeline;
        let status = 0;
        let body: Record<string, unknown> = {};
        try {
          const response = await shippedRoute(new NextRequest("https://marktmorgen.com/api/store/shipped", {
            method: "POST",
            headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${cookie}` },
            body: JSON.stringify({ session, tracking: "https://example.test/track/route" }),
          }));
          status = response.status;
          body = await response.json() as Record<string, unknown>;
        } finally {
          redis.pipeline = real;
        }
        // Billed as Upstash bills a script, one plus every redis.call in its text (an upper bound: every branch
        // counted), padded with the whole take allowance and lockedUntil's worst case, as tests/mail-draft-after-erasure does.
        const billed = sent.reduce((sum, c) => sum + (c[0] === "EVAL" ? 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length : 1), 0);
        const measured = billed + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
        const marks = sent.filter((c) => (c[0] === "EVAL" && c.slice(3).includes(doneKey(session))) || (c[0] === "SET" && c[1] === doneKey(session)));
        console.log("SHIPMENT_ROUTE", label, JSON.stringify({ status, billed, measured, envelope, bytes, mark: marks.map((c) => c[0]) }));
        // UNIT_COST.studio's fifty kilobytes through the database (tests/plan-cost-registry.ts).
        is(`${label}: its bytes through the database (${bytes}) stay within the studio unit's 50,000`, bytes <= 50_000, true);
        return { status, body, measured, marks };
      };
      await shop(true);
      const first = await measure("cs_test_shipereaseroute0001", "buyer@example.test", "first-with-email");
      is("the first press marks it shipped and emails the buyer (200)", [first.status, first.body.ok, first.body.emailed, first.marks.length], [200, true, true, 1]);
      is(`its billed commands, padded (${first.measured}), stay within the studio unit's ${envelope}`, first.measured <= envelope, true);
      const again = await measure("cs_test_shipereaseroute0001", "buyer@example.test", "second-press");
      is("a second press reads the kept mark (200), nothing more sent", [again.status, again.body.ok, again.body.emailed], [200, true, false]);
      is(`its billed commands, padded (${again.measured}), stay within the studio unit's ${envelope}`, again.measured <= envelope, true);
      const noMail = await measure("cs_test_shipereaseroute0002", "not an address", "first-no-recipient");
      is("an order with no usable address is marked without an email (200)", [noMail.status, noMail.body.ok, noMail.body.emailed], [200, true, false]);
      is(`its billed commands, padded (${noMail.measured}), stay within the studio unit's ${envelope}`, noMail.measured <= envelope, true);
      // The mark's own EVAL, replayed on lib/redis-memory.ts's twin of the script with every inner call counted (the
      // mark is held now, so the replay takes the longest branch and writes nothing): the EVAL and its HGET, GET, SET.
      const mark = first.marks.find((c) => c[0] === "EVAL")!;
      const count = Number(mark[2]);
      const args = mark.slice(3).map(String);
      let inner = 0;
      const replay = TAKE_SCRIPTS[/^-- marktmorgen:([a-z-]+:v\d+)\n/.exec(String(mark[1]))?.[1] ?? ""];
      const answer = replay?.((c) => { inner += 1; return redis.run(c); }, args.slice(0, count), args.slice(count));
      is("the mark's EVAL is the store's claim fence, billed as SHIPMENT_MARK_COMMANDS (EVAL + HGET + GET + SET)", [answer, 1 + inner, SHIPMENT_MARK_COMMANDS], [0, 4, 4]);    } finally {
      redis.pipeline = real;
    }
  }

  sender.restore();
  globalThis.fetch = stripe;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
