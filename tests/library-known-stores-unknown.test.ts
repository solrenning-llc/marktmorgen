/**
 * storesKnownFor (lib/buyer-library.ts) reads its SUNION in the exact shape
 * (CX-123 rule 24, rule 30): one list of strings, or UnknownReplyError. An
 * out-of-shape reply was read as "no store knows this address", and its two
 * callers acted on that in silence:
 *
 *   - lib/erasure-request.ts: a person asking to be deleted from every store
 *     got no deletion link and left no line in the log (the page says "sent"
 *     either way, by design, so the log is the only trace there is);
 *   - lib/person-copy.ts: the person's copy of their data left out the note
 *     that they are in the store's library.
 *
 * Now an unknown reading is never "none": the every-store ask leaves a line in
 * the log, an ask from one store whose own list holds the address still gets
 * its link, and the copy fails whole rather than leave a part out. Controls: a
 * healthy reply and a confirmed empty one. Synthetic stores; one reply
 * injected per case; no network. Turned from the proof on #2910.
 *
 * The same rule for its sibling read (rule 30): whether the store's own list
 * holds the address, knows() in lib/erasure-request.ts, read HEXISTS as
 * `Number(held) === 1`, so a missing or out-of-shape reply was "not on the
 * list" and a one-store ask was dropped in silence, and a string "1" was read
 * as on it. Only an exact 0 or 1 is an answer; anything else is logged.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { rememberBuyers, storesKnownFor } from "@/lib/buyer-library";
import { leadsKey } from "@/lib/contacts";
import { erasureScope } from "@/lib/person-erasure";
import { copyPerson } from "@/lib/person-copy";
import { POST as eraseRoute } from "@/app/api/privacy/erase/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let inject: (() => unknown) | null = null;
let injectList: (() => unknown) | null = null;
/** Only the library's SUNION (its keys start nl:lib:), never another module's. */
const isLibraryRead = (batch: Command[]) => batch.some((c) => c[0] === "SUNION" && String(c[1]).startsWith("nl:lib:"));
redis.pipeline = (async (batch: Command[]) => {
  if (inject && isLibraryRead(batch)) return inject();
  if (injectList && batch.some((c) => c[0] === "HEXISTS" && String(c[1]).startsWith("nl:store:leads:"))) return injectList();
  return real(batch);
}) as typeof redis.pipeline;

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    sent.push(String((JSON.parse(String(init?.body)) as { to?: unknown }).to));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

const logged: string[] = [];
for (const level of ["error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    original(...args);
  };
}

async function paidStore(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1${handle.replace(/[^a-z]/g, "").padEnd(14, "x").slice(0, 14)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/[^a-z0-9]/g, "")}`, subscriptionId: `sub_${handle.replace(/[^a-z0-9]/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

let ip = 0;
/** One ask, each from its own network address so the hourly limit per network address never decides it. */
async function ask(email: string, handle?: string): Promise<void> {
  ip += 1;
  const body = new URLSearchParams({ action: "ask", email, scope: handle ? "store" : "all", ...(handle ? { store: handle } : {}) });
  await eraseRoute(
    new NextRequest("https://marktmorgen.com/api/privacy/erase", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${ip}` },
      body,
    }),
  );
  // What the route leaves for after its answer.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** What a read came to: the ids, or "unknown" when it threw UnknownReplyError. */
const reading = (email: string) => storesKnownFor(email).then((ids) => ids, (error: unknown) => (error instanceof Error && error.name === "UnknownReplyError" ? "unknown" : `threw ${String(error)}`));

/** Whether the copy for this person came whole with the library note, came without it, or failed. */
async function copied(store: Store, email: string): Promise<string> {
  try {
    const copy = await copyPerson((await erasureScope(store, email))!);
    return copy.sections.some((s) => s.module === "lib/buyer-library.ts") ? "with the library note" : "without the library note";
  } catch {
    return "refused";
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_library_known_only";
  const shop = await paidStore("lib-known-shop");
  const KNOWN = "bought-at-shop@example.com";
  const NOBODY = "nobody-anywhere@example.com";
  // One address per ask below, each known to the store, so the hourly limit per address never decides it.
  const everyStore = ["all-a@example.com", "all-b@example.com", "all-c@example.com", "all-d@example.com"];
  const listed = ["list-a@example.com", "list-b@example.com", "list-c@example.com", "list-d@example.com"];
  const unlisted = ["none-a@example.com", "none-b@example.com", "none-c@example.com", "none-d@example.com"];
  await rememberBuyers(shop.sid, [KNOWN, ...everyStore]);
  for (const email of listed) await redis.pipeline([["HSET", leadsKey(shop.listId!), email, JSON.stringify({ at: 1_790_000_000 })]]);

  part("Control: a healthy reply");
  is("the address is known to the store", await reading(KNOWN), [shop.sid]);
  is("the copy carries the library note", await copied(shop, KNOWN), "with the library note");
  let from = sent.length;
  await ask(KNOWN);
  is("asked for every store, the known address is emailed its link", sent.slice(from), [KNOWN]);

  part("Control: a confirmed empty reply");
  is("an address nobody knows is known to no store", await reading(NOBODY), []);
  inject = () => [[]];
  is("an injected empty set is 'none', never unknown", await reading(KNOWN), []);
  is("and the copy is made, without the note", await copied(shop, KNOWN), "without the library note");
  inject = null;
  from = sent.length;
  let before = logged.length;
  await ask(NOBODY);
  is("asked for every store, nobody's address is sent nothing and nothing is logged", [sent.length - from, logged.length - before], [0, 0]);

  const cases: [string, () => unknown][] = [
    ["the stores answered as a string", () => ["x"]],
    ["a number among the stores", () => [[shop.sid, 7]]],
    ["no reply at all", () => []],
    ["the whole pipeline answered as something else", () => "OK"],
  ];
  for (const [name, reply] of cases) {
    part(`Unknown: ${name}`);
    inject = reply;
    is("storesKnownFor says the reading is unknown, never 'no store knows it'", await reading(KNOWN), "unknown");
    is("the copy is refused whole, never handed over without the library note", await copied(shop, KNOWN), "refused");
    from = sent.length;
    before = logged.length;
    await ask(everyStore.shift()!);
    is("asked for every store, the ask leaves a line in the log, never dropped in silence", logged.length > before, true);
    from = sent.length;
    const onList = listed.shift()!;
    await ask(onList, shop.handle);
    is("asked from the store whose list holds the address, the link is still emailed", sent.slice(from), [onList]);
    from = sent.length;
    before = logged.length;
    await ask(unlisted.shift()!, shop.handle);
    is("asked from the store for an address not on its list, nothing is sent and the unknown is logged", [sent.length - from, logged.length > before], [0, true]);
    inject = null;
  }

  // The store's own list (knows() in lib/erasure-request.ts), with a healthy library read: the controls are the
  // one-store asks above (an address on the list is emailed, one that is not is sent nothing).
  const hexists: [string, () => unknown][] = [
    ["the list answered as a string", () => ["1"]],
    ["the list answered with a count that is not 0 or 1", () => [2]],
    ["the list answered null", () => [null]],
    ["no reply at all", () => []],
  ];
  for (const [index, [name, reply]] of hexists.entries()) {
    part(`Unknown store list: ${name}`);
    const asked = `list-unknown-${index}@example.com`;
    await redis.pipeline([["HSET", leadsKey(shop.listId!), asked, JSON.stringify({ at: 1_790_000_000 })]]);
    injectList = reply;
    from = sent.length;
    before = logged.length;
    await ask(asked, shop.handle);
    injectList = null;
    is("asked from the store, nothing is sent on an unknown list reading and the unknown is logged", [sent.length - from, logged.length > before], [0, true]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
