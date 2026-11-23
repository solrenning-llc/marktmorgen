/**
 * C5-20261119-1050-wb (privacy, MEDIUM; Claude 4, accepted by the coordinator), with Codex X7's MEDIUM on #4877: a
 * membership's come-back mark, `nl:wb:<account>:<subscription>`, is a pseudonymous id of the member's subscription
 * (lib/person-data.ts says these marks are the member's and are erased), but the erasure deleted only the once-marks:
 *
 *   1. a mark from before the erasure lived its 90 days after the erasure reported done;
 *   2. a run after the erasure made the mark again, and kept it when no unsubscribe token was found;
 *   3. (X7) a run that found the person erased at the offer's claim let the mark go, and when both releases failed the
 *      mark stayed: every later run found it taken and skipped the membership before reading who it was.
 *
 * Now the mark is taken only while the address has no deletion print, and noted for erasure in the same step
 * (WINBACK_MARK), so an erased person never gets one and the erasure deletes every one made before it.
 * Stripe and the sender are stand-ins; every address and id is synthetic.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import { forgetWinbackPerson, sendWinBacks } from "@/lib/winback-send";
import { forgetNoted, notesKey } from "@/lib/erasure-index";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const OWNER = "wb-mark-erasure@example.com";

type Sent = { to: string[] };
const handed: Sent[] = [];
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    handed.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    return answer({ object: "list", data: events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte), has_more: false });
  }
  if (path === "/customers/search") return answer({ object: "search_result", data: [], has_more: false });
  if (path === "/customers") return answer({ object: "list", data: [...customers].filter(([, e]) => e === url.searchParams.get("email")).map(([id, email]) => ({ id, object: "customer", email })), has_more: false });
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return answer({ id: customer[1], email: customers.get(customer[1]) ?? null });
  if (path === "/subscriptions") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

function ended(id: string, customer: string, meta: Record<string, string>): void {
  events.push({
    id: `evt_${id}`,
    type: "customer.subscription.deleted",
    created: nowS - 8 * DAY,
    data: { object: { id, customer, ended_at: nowS - 8 * DAY, metadata: meta, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } },
  });
}

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
const data = () => (redis as unknown as { data: Map<string, unknown> }).data;
const keysWith = (part: string) => [...data().keys()].filter((k) => k.includes(part));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_wb_mark_erasure_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  console.error = () => {};

  /** A store with one ended membership of `email`; `agreed` false leaves no list token, so nothing can be sent. */
  async function world(label: string, email: string, sub: string, cus: string, agreed: boolean) {
    redis.clear();
    handed.length = 0;
    events.length = 0;
    const made = await claimHandle(OWNER, "wbmarkerase", "Harbor Kitchen", "");
    if (!made.ok) throw new Error(`no store (${label})`);
    await ensureStatsId(OWNER);
    await ensureListId(OWNER);
    await setStripeAccount(OWNER, "acct_1TestWbMark", true);
    await setSubscription(OWNER, { customerId: "cus_WbMarkOwner", subscriptionId: "sub_WbMarkOwner", active: true, tier: "pro", period: paidPeriod() });
    const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
    if (!club.ok) throw new Error("no product");
    await setProductLink(OWNER, club.product.id, "https://example.com/club");
    await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
    const store = (await storeForEmail(OWNER))!;
    customers.set(cus, email);
    if (agreed) await upsertContact(store.listId as string, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);
    ended(sub, cus, { store: "wbmarkerase", product: club.product.id });
    // The erasure's steps that touch come-back data, in its order (lib/person-erasure.ts): the deletion print first,
    // then the once-marks (lib/winback-send.ts) and the address's noted records (lib/erasure-index.ts).
    const erase = async () => {
      await real([suppressCommand(store.listId as string, email)]);
      await forgetWinbackPerson(store.statsId, [club.product.id], email);
      await forgetNoted(store.statsId as string, email);
    };
    return { store, erase };
  }

  part("1. A mark from before the erasure is gone once the erasure reports done (an offer sent)");
  {
    const email = "ann@example.com";
    const { erase } = await world("sent then erased", email, "sub_AnnMarkSent0001", "cus_AnnMark0001", true);
    const first = await sendWinBacks(Date.now() + 30_000, now);
    is("the offer went once, and its membership's mark was kept", [first.sent, keysWith("sub_AnnMarkSent0001").length], [1, 1]);
    await erase();
    is("after the erasure no key keeps the subscription's id", keysWith("sub_AnnMarkSent0001"), []);
  }

  part("1b. A mark from before the erasure is gone once the erasure reports done (no token found, nothing sent)");
  {
    const email = "bo@example.com";
    const { erase } = await world("kept without a token, then erased", email, "sub_BoMarkNoToken01", "cus_BoMark00001", false);
    const first = await sendWinBacks(Date.now() + 30_000, now);
    is("nothing was sent", [first.sent, handed.length], [0, 0]);
    await erase();
    is("after the erasure no key keeps the subscription's id", keysWith("sub_BoMarkNoToken01"), []);
  }

  part("2. A run after the erasure leaves no mark, including when no token is found");
  {
    const email = "cy@example.com";
    const { erase } = await world("erased, then a run with no token", email, "sub_CyMarkErased01", "cus_CyMark00001", false);
    await erase();
    const run = await sendWinBacks(Date.now() + 30_000, now);
    is("nothing was sent", [run.sent, handed.length], [0, 0]);
    is("no key keeps the subscription's id", keysWith("sub_CyMarkErased01"), []);
  }

  part("2b. A run after the erasure leaves no mark when the list token is still found");
  {
    const email = "di@example.com";
    const { erase } = await world("erased, then a run with a token", email, "sub_DiMarkErased01", "cus_DiMark00001", true);
    await erase();
    const run = await sendWinBacks(Date.now() + 30_000, now);
    is("nothing was sent", [run.sent, handed.length], [0, 0]);
    is("no key keeps the subscription's id", keysWith("sub_DiMarkErased01"), []);
  }

  // Codex X7 on #4877 (MEDIUM, privacy): with Redis failing every release of the mark on the first run, a healthy
  // run after it must still leave nothing with the subscription's id.
  part("3. X7: every release of the mark fails on the first run, then one healthy run: no key keeps the subscription's id");
  {
    const email = "eve@example.com";
    const { erase } = await world("releases fail, then a healthy run", email, "sub_EveMarkStuck01", "cus_EveMark0001", true);
    await erase();
    redis.pipeline = (async (commands: Commands) => {
      const releasing = commands.length === 1 && commands[0]?.[0] === "EVAL" && commands[0].some((x) => String(x).includes("sub_EveMarkStuck01")) &&
        !String(commands[0][1]).startsWith("-- marktmorgen:winback-mark:");
      if (releasing) throw new Error("synthetic redis failure on every release of the mark");
      return real(commands);
    }) as typeof redis.pipeline;
    await sendWinBacks(Date.now() + 30_000, now).finally(() => { redis.pipeline = real; });
    await sendWinBacks(Date.now() + 30_000, now);
    is("nothing was ever sent to the erased person", handed.filter((m) => m.to.includes(email)).length, 0);
    is("no key keeps the subscription's id", keysWith("sub_EveMarkStuck01"), []);
  }

  part("4. Control: nobody erased, the offer goes once, its mark is noted for erasure and holds the next run back");
  {
    const email = "flo@example.com";
    const { store } = await world("control", email, "sub_FloMarkKept001", "cus_FloMark0001", true);
    const first = await sendWinBacks(Date.now() + 30_000, now);
    const second = await sendWinBacks(Date.now() + 30_000, now);
    is("sent once over two runs", [first.sent, second.sent, handed.filter((m) => m.to.includes(email)).length], [1, 0, 1]);
    const notes = data().get(notesKey(store.statsId as string, email));
    const noted = Array.isArray(notes) ? (notes as { member?: unknown }[]).map((n) => n.member) : [];
    is("the membership's mark is among the address's erasure notes", noted.some((k) => String(k).includes("sub_FloMarkKept001")), true);
  }

  part("5. The address's notes of another type: nothing is marked or sent, and nothing is written over them");
  {
    const email = "gil@example.com";
    const { store } = await world("notes of another type", email, "sub_GilMarkWrong01", "cus_GilMark0001", true);
    await real([["SET", notesKey(store.statsId as string, email), "not a sorted set"]]);
    const run = await sendWinBacks(Date.now() + 30_000, now);
    is("nothing was sent", [run.sent, handed.length], [0, 0]);
    is("no key keeps the subscription's id", keysWith("sub_GilMarkWrong01"), []);
    is("the notes key was left as it was", data().get(notesKey(store.statsId as string, email)), "not a sorted set");
  }
  part("6. Redis stopping the mark's script at its note: no mark without its note, nothing sent; the next run sends once, noted");
  {
    const email = "hal@example.com";
    const { store } = await world("stopped at the note", email, "sub_HalMarkHalf001", "cus_HalMark0001", true);
    const run = redis.run.bind(redis);
    let stopped = 0;
    redis.run = ((c: (string | number)[]) => {
      if (c[0] === "ZADD" && String(c[3]).includes("sub_HalMarkHalf001")) { stopped += 1; throw new Error("synthetic Redis error inside the mark's script"); }
      return run(c);
    }) as typeof redis.run;
    const first = await sendWinBacks(Date.now() + 30_000, now).finally(() => { redis.run = run; });
    is("the script was stopped at the note, and nothing was sent", [stopped, first.sent, handed.length], [1, 0, 0]);
    is("no mark was left without its note", keysWith("sub_HalMarkHalf001"), []);
    const second = await sendWinBacks(Date.now() + 30_000, now);
    const notes = data().get(notesKey(store.statsId as string, email));
    const noted = Array.isArray(notes) ? (notes as { member?: unknown }[]).map((n) => n.member) : [];
    is("the next run sends once, and its mark is noted", [second.sent, handed.length, noted.some((k) => String(k).includes("sub_HalMarkHalf001"))], [1, 1, true]);
  }
  done();
}
void main().catch((error) => { console.error(error); process.exit(1); });
