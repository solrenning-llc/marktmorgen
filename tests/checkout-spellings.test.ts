/**
 * #5125, "checkoutsOf casing" (coordinator c414, f474, 80ec, f2e3, 1b74 and e109, 22 November 2026): each paid
 * checkout's address, as its buyer typed it, is kept for the copy of their data, so Stripe can be asked for that
 * spelling too. Checked against the stand-in Redis; nothing real is reached.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { ORDER_ENTRY_BYTES, ORDER_KEY_BYTES, ORDER_WRITE_IF_SAME } from "@/lib/order-data";
import { DATA_ROOM_BYTES, DATA_STEP_BYTES, NON_PAYING_DATA_ROOM_BYTES, ORDER_DATA_BYTES, ORDER_RESERVE_WINDOWS, ORDER_SPELLING_BYTES, dataWords } from "@/lib/store-data-rules";
import { ORDERS_INCLUDED, TRIAL_ORDERS } from "@/lib/order-rules";
import { SPELLING_MOST_BYTES, SPELLING_ORDER_COMMANDS, SPELLING_TRIES, SPELLING_TRY_COMMANDS, forgetSpellingsPerson, keepSpellings, spellingField, spellingOf, spellingsKey, spellingsOf } from "@/lib/checkout-spellings";
import { entriesKey } from "@/lib/preorders";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "spellings-owner@example.com";
const HANDLE = "spellshop";
process.env.STRIPE_SECRET_KEY ??= "sk_test_checkout_spellings_only";
/** The store's paid checkouts as its Stripe lists them, by the address exactly as asked; `down` makes Stripe not answer. */
const SESSIONS: { id: string; email: string; meta: Record<string, string> }[] = [];
let down = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (down) return json({ error: { message: "down (test)" } }, 500);
  if (url.hostname !== "api.stripe.com" || url.pathname !== "/v1/checkout/sessions") return json({ error: { message: "no stand-in" } }, 404);
  const asked = url.searchParams.get("customer_details[email]") ?? "";
  const data = SESSIONS.filter((s) => s.email === asked).map((s) => ({ id: s.id, status: "complete", payment_status: "paid", payment_intent: null, metadata: s.meta, customer_details: { email: s.email } }));
  return json({ object: "list", data, has_more: false });
}) as typeof fetch;

const paid = (email: unknown, store = HANDLE, payment = "paid") => ({ id: "cs_test_" + "a".repeat(24), status: "complete", payment_status: payment, metadata: { store }, customer_details: { email } });

async function main() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Spell Shop", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const sid = store.statsId!;

  part("Which spelling a paid checkout leaves");
  {
    is("mixed case, trimmed", spellingOf(store, paid("  Ada@Example.COM ")), "Ada@Example.COM");
    is("all lower case: nothing, the copy asks for it anyway", spellingOf(store, paid("ada@example.com")), null);
    is("another store's checkout: nothing", spellingOf(store, paid("Ada@Example.COM", "othershop")), null);
    is("not paid: nothing", spellingOf(store, paid("Ada@Example.COM", HANDLE, "unpaid")), null);
    is("no address: nothing", spellingOf(store, paid(null)), null);
    is("an address with a line break: nothing", spellingOf(store, paid("Ada@Example.com\nBob@Example.com")), null);
    is("longer than any address: nothing", spellingOf(store, paid("A".repeat(SPELLING_MOST_BYTES) + "@x.com")), null);
    is("one of the longest: kept", spellingOf(store, paid("A".repeat(SPELLING_MOST_BYTES - 6) + "@x.com")), "A".repeat(SPELLING_MOST_BYTES - 6) + "@x.com");
  }

  part("Kept once an address, read back exactly");
  {
    is("two spellings of Ada and Bob's one kept", await keepSpellings(store, [paid("Ada@Example.COM"), paid("ADA@example.com"), paid("Bob@Example.com"), paid("lee@example.com")]), 3);
    is("Ada's spellings, as typed, under any spelling of hers", (await spellingsOf(sid, "ada@EXAMPLE.com")).sort(), ["ADA@example.com", "Ada@Example.COM"]);
    is("Bob's", await spellingsOf(sid, "bob@example.com"), ["Bob@Example.com"]);
    is("Lee typed lower case: none kept", await spellingsOf(sid, "lee@example.com"), []);
    is("the same checkouts again add nothing", await keepSpellings(store, [paid("Ada@Example.COM"), paid("Bob@Example.com")]), 0);
    is("one hash for the store, a field an address", redis.run(["HLEN", spellingsKey(sid)]), 2);
    is("the field is the address's SHA-256 in lower case", redis.run(["HEXISTS", spellingsKey(sid), spellingField("ADA@EXAMPLE.COM")]), 1);
    is("kept as long as the store is: no expiry", redis.run(["TTL", spellingsKey(sid)]), -1);
    // The copy of their data holds their spellings, and only theirs.
    const scope = (email: string) => ({ store, statsId: sid, email }) as unknown as ErasureScope;
    is("the copy's plan says it is copied", COPY_PLAN["lib/checkout-spellings.ts"]?.how, "copied");
    is("Ada's copy holds her spellings", ((await COPIERS["lib/checkout-spellings.ts"](scope("ada@example.com"))) as { typedAtCheckout: string }[]).map((r) => r.typedAtCheckout).sort(), ["ADA@example.com", "Ada@Example.COM"]);
    is("and none of Bob's", JSON.stringify(await COPIERS["lib/checkout-spellings.ts"](scope("ada@example.com"))).includes("Bob@"), false);
    is("Lee's copy: none", await COPIERS["lib/checkout-spellings.ts"](scope("lee@example.com")), []);
  }

  part("At the person's erasure: deleted, unless it still leads to a pre-order kept on purpose");
  {
    await setStripeAccount(OWNER, "acct_1SpellingsShop", true);
    const live = (await storeForEmail(OWNER))!;
    // Bob paid a pre-order typing "Bob@Example.com"; it is kept on purpose after his erasure (lib/person-data.ts).
    const PRE = "cs_test_" + "b".repeat(24);
    SESSIONS.push({ id: PRE, email: "Bob@Example.com", meta: { store: HANDLE, preorder: "yes", product: "preprodspell1" } });
    redis.run(["HSET", entriesKey(sid, "preprodspell1"), PRE, JSON.stringify({ to: "Bob@Example.com", at: 1_790_000_000, pi: "" })]);
    is("Bob's spelling stays: his kept pre-order is found through it", await forgetSpellingsPerson(live, "bob@example.com"), 0);
    is("and is still there to read", await spellingsOf(sid, "bob@example.com"), ["Bob@Example.com"]);
    // Ada has no pre-order: hers go at once.
    is("Ada's spellings go", await forgetSpellingsPerson(live, "ada@example.com"), 1);
    is("none left", await spellingsOf(sid, "ada@example.com"), []);
    is("a person with none: nothing to do", await forgetSpellingsPerson(live, "nobody@example.com"), 0);
    // Once Bob's pre-order is gone (delivered and past its time, or refunded and past it), his spelling goes too.
    redis.run(["DEL", entriesKey(sid, "preprodspell1")]);
    is("Bob's goes once no kept pre-order leads to it", await forgetSpellingsPerson(live, "bob@example.com"), 1);
    // Stripe not answering is never "no kept pre-order": the spelling stays and the erasure is made again.
    await keepSpellings(store, [paid("Cy@Example.com")]);
    down = true;
    try {
      is("Stripe not answering: the erasure fails and the spelling stays", await forgetSpellingsPerson(live, "cy@example.com").then(() => "done", (e) => (e instanceof UnknownReplyError ? "unknown" : String(e))), "unknown");
    } finally {
      down = false;
    }
    is("still there for the erasure made again", await spellingsOf(sid, "cy@example.com"), ["Cy@Example.com"]);
    is("nothing was added or renewed at the erasure", redis.run(["TTL", spellingsKey(sid)]), -1);
  }

  part("Unknown is never 'no other spelling'");
  {
    const real = redis.pipeline.bind(redis);
    const bent = async (reply: unknown, run: () => Promise<unknown>) => {
      redis.pipeline = (async (commands: unknown[][]) => {
        const replies = (await real(commands as never)) as unknown[];
        return commands.map((c, i) => (c[0] === "HGET" && c[1] === spellingsKey(sid) ? reply : replies[i]));
      }) as typeof redis.pipeline;
      try {
        return await run().then(() => "read", (error) => (error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`));
      } finally {
        redis.pipeline = real;
      }
    };
    for (const [what, reply] of [["no reply", undefined], ["a number", 3], ["a list", ["Ada@Example.COM"]], ["an empty text", ""], ["an empty line", "Ada@Example.COM\n"], ["a line longer than an address", "A".repeat(SPELLING_MOST_BYTES + 1)]] as const) {
      is(`${what}: the read fails`, await bent(reply, () => spellingsOf(sid, "ada@example.com")), "unknown");
      is(`${what}: the write fails, never written over`, await bent(reply, () => keepSpellings(store, [paid("Ada@Example.COM")])), "unknown");
    }
    is("nothing there is none", await bent(null, () => spellingsOf(sid, "nobody@example.com")), "read");
    // Another writer changes the field between every read and write: after SPELLING_TRIES the page is left for the next run.
    let writes = 0;
    redis.pipeline = (async (commands: unknown[][]) => {
      if (commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:order-write-if-same:v1")) {
        writes += 1;
        return [[-2]];
      }
      return real(commands as never);
    }) as typeof redis.pipeline;
    try {
      is("changed each time: unknown, never taken as kept", await keepSpellings(store, [paid("Zed@Example.com")]).then(() => "kept", (e) => (e instanceof UnknownReplyError ? "unknown" : String(e))), "unknown");
      is("tried SPELLING_TRIES times", writes, SPELLING_TRIES);
    } finally {
      redis.pipeline = real;
    }
  }

  part("The five-minute sweep keeps every paid checkout's spelling before anything else of the page");
  {
    const sweep = readFileSync("lib/checkout-sweep.ts", "utf8");
    const walk = sweep.indexOf('await walkDay(store, "complete"');
    const paidAt = sweep.indexOf("const paid = rows.filter((row) => isSettled(row)", walk);
    const keepAt = sweep.indexOf("await keepSpellings(store, paid);", walk);
    const nextStep = sweep.indexOf("observeCheckoutTaxPage(store, paid", walk);
    is("in the completed walk, right after its paid checkouts are known and before the rest", walk > 0 && paidAt > walk && keepAt > paidAt && nextStep > keepAt, true);
    is("not caught there: a write not confirmed keeps the walk's place on this page", /keepSpellings\(store, paid\)\.catch/.test(sweep), false);
  }

  part("Priced: the commands in the orders line, the bytes inside ORDER_DATA_BYTES, the room grown by the reserve's");
  {
    const calls = (ORDER_WRITE_IF_SAME.match(/redis\.call\(|pcall\(redis\.call/g) ?? []).length;
    is("a try's commands hold its HGET, the EVAL and every call its script can make", SPELLING_TRY_COMMANDS >= 2 + calls, true);
    is("an order's commands: every try", SPELLING_ORDER_COMMANDS, SPELLING_TRIES * SPELLING_TRY_COMMANDS);
    // lib/order-data.ts at its most: the hash made new (its name and ORDER_KEY_BYTES) and a new field (the SHA-256, the
    // longest spelling, ORDER_ENTRY_BYTES), a quarter more, rounded up to its step.
    const keyName = spellingsKey("0".repeat(32)).length;
    const most = Math.ceil(((keyName + ORDER_KEY_BYTES + 64 + SPELLING_MOST_BYTES + ORDER_ENTRY_BYTES) * 5) / 4 / DATA_STEP_BYTES) * DATA_STEP_BYTES;
    is("ORDER_SPELLING_BYTES is what the room is charged for it at the most", ORDER_SPELLING_BYTES >= most, true);
    is("ORDER_DATA_BYTES grew by it", ORDER_DATA_BYTES, 4_608 + ORDER_SPELLING_BYTES);
    for (const tier of ["creator", "pro", "scale"] as const) {
      const before = { creator: 18, pro: 135, scale: 250 }[tier] * 1_000_000;
      is(`the ${tier} room grew by its reserve's spellings, so what it keeps besides is what it was`, DATA_ROOM_BYTES[tier] - before, ORDER_RESERVE_WINDOWS * ORDERS_INCLUDED[tier] * ORDER_SPELLING_BYTES);
    }
    is("a trial's room grew by its orders' spellings", NON_PAYING_DATA_ROOM_BYTES.trial - 10_000_000, ORDER_RESERVE_WINDOWS * TRIAL_ORDERS * ORDER_SPELLING_BYTES);
    is("a store with no plan, or an ended one, holds no orders: unchanged", [NON_PAYING_DATA_ROOM_BYTES.none, NON_PAYING_DATA_ROOM_BYTES.ended], [5_000_000, 5_000_000]);
    // The printed figures, pending the owner's decision (coordinator e109): each only up.
    is("the printed rooms", [dataWords(DATA_ROOM_BYTES.creator), dataWords(DATA_ROOM_BYTES.pro), dataWords(DATA_ROOM_BYTES.scale), dataWords(NON_PAYING_DATA_ROOM_BYTES.trial)], ["18.3 MB", "135.6 MB", "252 MB", "10.1 MB"]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
