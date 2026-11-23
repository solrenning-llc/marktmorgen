/**
 * #4268 (board #5427, row #4404): a sign-up confirmation from the store page's box (lib/store-join.ts confirmJoin)
 * whose link was read before the person's erasure must not finish after it. Before the fix it called upsertContact
 * with no fence, as the person's own yes "given now", which put the erased address back on the creator's list as
 * someone who agreed and lifted the erasure print. The write is now fenced by its own link, as lib/waitlist.ts
 * confirmSpot: the erasure deletes the link (its erasure note), so a write that lands after it is refused in the same
 * step. A fresh yes, given by a link made after the erasure, still joins and lifts the print.
 * The app's clock runs 5 seconds ahead of Redis's here: the confirmation lands seconds after the erasure, as it does
 * for real, so its unfenced "given now" is later than the erasure print and the old code lifted it.
 * Synthetic only (in-memory Redis stand-in, no email sent).
 */
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, ensureListId, ensureStatsId, setJoin, setSubscription, storeForEmail } from "@/lib/store";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
import { erasePerson } from "@/lib/person-erasure";
import { askToJoin, confirmJoin } from "@/lib/store-join";
import { ERASURE_SECONDS } from "@/lib/waitlist";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "join-race-owner@example.com";
const PERSON = "join-race-person@example.com";
const sent: string[] = [];
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
/** Moves the app's clock and Redis's together, keeping the app 5 seconds ahead. */
const later = (ms: number) => {
  skew += ms;
  advance(ms);
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_join_only";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com") {
      sent.push(String((JSON.parse(String(init?.body)) as { text?: string }).text ?? ""));
      return new Response(JSON.stringify({ id: "email_1" }));
    }
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  }) as typeof fetch;
  await claimHandle(OWNER, "joinrace", "Join Race", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_JoinRace01", subscriptionId: "sub_JoinRace01", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  await setJoin(OWNER, { on: true, heading: "Notes", line: "" });
  const store = (await storeForEmail(OWNER))!;
  // Redis's clock stops 5 seconds behind the app's (the stand-in's clock is set, not running, from here on).
  advance(-5_000);
  const leads = leadsKey(store.listId!);
  const print = () => redis.run(["HEXISTS", suppressedKey(store.listId!), suppressionPrint(store.listId!, PERSON)]);
  const tokenIn = (text: string) => text.match(/join\?token=([0-9a-f]{48})/)?.[1] ?? "";
  let ip = 0;
  const ask = async () => {
    ip += 1;
    is("(control) the person asks to join from the store page", await askToJoin({ store, email: PERSON, ip: `4.4.4.${ip}`, origin: "https://marktmorgen.com" }), "sent");
    return tokenIn(sent[sent.length - 1]);
  };
  const erase = () => erasePerson(store, PERSON, { kind: "team", who: OWNER, role: "owner" });
  const isLink = (c: (string | number)[][]) => c[0]?.[0] === "GET" && String(c[0]?.[1]).startsWith("nl:join:t:");

  /** Runs the erasure once, when the first pipeline `when` matches is sent: just before it runs, or just after it was answered. */
  async function withErasureAt(when: (commands: (string | number)[][]) => boolean, timing: "before" | "after", run: () => Promise<unknown>) {
    const original = redis.pipeline.bind(redis);
    let erasure: { ok: boolean } | null = null;
    const hook = (async (commands: (string | number)[][]) => {
      const matched = !erasure && when(commands);
      const eraseNow = async () => {
        redis.pipeline = original;
        erasure = await erase();
        redis.pipeline = hook;
      };
      if (matched && timing === "before") await eraseNow();
      const replies = await original(commands);
      if (matched && timing === "after") await eraseNow();
      return replies;
    }) as typeof redis.pipeline;
    redis.pipeline = hook;
    const result = await run().catch((error: unknown) => ({ ok: "threw", error: String(error) }));
    redis.pipeline = original;
    return { result, erasure: erasure as { ok: boolean } | null };
  }

  part("an erasure completes between reading the link and writing the contact");
  await upsertContact(store.listId!, PERSON, { agreed: true, explicit: true, source: "free", sid: store.sid }, ROOM);
  redis.run(["HDEL", leads, PERSON]);
  let token = await ask();
  let run = await withErasureAt(isLink, "after", () => confirmJoin(token, store));
  is("(control) the erasure completed while the confirmation was in flight", run.erasure?.ok, true);
  is("the confirmation does not report a join", (run.result as { ok: unknown }).ok, false);
  is("the erased address is not on the list", redis.run(["HGET", leads, PERSON]), null);
  is("the erasure print is still in place", print(), 1);

  part("an erasure completes at the contact write's first read");
  redis.run(["HDEL", suppressedKey(store.listId!), suppressionPrint(store.listId!, PERSON)]);
  later((ERASURE_SECONDS + 2) * 1000);
  token = await ask();
  run = await withErasureAt((c) => c[0]?.[0] === "HGET" && c[0]?.[1] === leads && c.length === 3, "before", () => confirmJoin(token, store));
  is("(control) the erasure completed while the confirmation was in flight", run.erasure?.ok, true);
  is("the confirmation does not report a join", (run.result as { ok: unknown }).ok, false);
  is("the erased address is not on the list", redis.run(["HGET", leads, PERSON]), null);
  is("the erasure print is still in place", print(), 1);

  part("a fresh yes, by a link made after the erasure, still joins and lifts the print");
  later((ERASURE_SECONDS + 2) * 1000);
  token = await ask();
  is("the new link joins", (await confirmJoin(token, store)).ok, true);
  is("the address is on the list, as it asked again", typeof redis.run(["HGET", leads, PERSON]), "string");
  is("its own new yes lifted the print", print(), 0);
  Date.now = realNow;
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
