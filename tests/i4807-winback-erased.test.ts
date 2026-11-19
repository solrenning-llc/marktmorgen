/**
 * Issue #4807 (erasure, MEDIUM; Codex G, transcribed by Claude 2): a come-back offer run that had read the person
 * before their erasure went on after it completed: it made the once-mark again, wrote a grant holding the address and
 * emailed the erased person. Now the once-mark, the grant and its erasure note are written in one step only while the
 * address has no deletion print, and the print is read again just before the email: an erasure first sends nothing
 * and keeps nothing of them. Reproduction transcribed from the issue; Stripe and the sender are stand-ins.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import { ERASED_LINK_COMMANDS, UNWRITTEN_LINK_COMMANDS, forgetWinbackPerson, sendWinBacks } from "@/lib/winback-send";
import { forgetNoted } from "@/lib/erasure-index";
import { WINBACK_OFFER_COMMANDS } from "@/lib/winback";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const OWNER = "wb-erased@example.com";

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
  // Main's customersOf also asks Stripe's customer search (R43): nobody else under the address here.
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
const winbackKeys = () => [...data().keys()].filter((k) => k.startsWith("nl:wb:"));
const holdingAddress = (email: string) => winbackKeys().filter((k) => JSON.stringify(data().get(k)).includes(email));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_wb_i4807_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  console.error = () => {};

  async function world(label: string, email: string, sub: string, cus: string) {
    redis.clear();
    handed.length = 0;
    events.length = 0;
    const made = await claimHandle(OWNER, "wberased", "Harbor Kitchen", "");
    if (!made.ok) throw new Error(`no store (${label})`);
    await ensureStatsId(OWNER);
    await ensureListId(OWNER);
    await setStripeAccount(OWNER, "acct_1TestWbErased", true);
    await setSubscription(OWNER, { customerId: "cus_WbErasedOwner", subscriptionId: "sub_WbErasedOwner", active: true, tier: "pro", period: paidPeriod() });
    const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
    if (!club.ok) throw new Error("no product");
    await setProductLink(OWNER, club.product.id, "https://example.com/club");
    await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
    const store = (await storeForEmail(OWNER))!;
    customers.set(cus, email);
    await upsertContact(store.listId as string, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);
    ended(sub, cus, { store: "wberased", product: club.product.id });
    const erase = async () => {
      await real([suppressCommand(store.listId as string, email)]);
      await forgetWinbackPerson(store.statsId, [club.product.id], email);
      await forgetNoted(store.statsId as string, email);
    };
    return { store, erase };
  }

  part("The erasure completes between the run's token read and its once-mark (the issue's reproduction)");
  {
    const email = "ann@example.com";
    const { erase } = await world("before the mark", email, "sub_AnnErased00001", "cus_AnnErased01");
    let fired = false;
    redis.pipeline = (async (commands: Commands) => {
      const marking = commands.some((c) => (c[0] === "SET" && String(c[1]).startsWith("nl:wb:once:")) || (c[0] === "EVAL" && c.some((x) => String(x).startsWith("nl:wb:once:"))));
      if (!fired && marking) { fired = true; await erase(); }
      return real(commands);
    }) as typeof redis.pipeline;
    await sendWinBacks(Date.now() + 30_000, now);
    redis.pipeline = real;
    is("the run reached the mark after the erasure", fired, true);
    is("no email reached the erased person", handed.filter((m) => m.to.includes(email)).length, 0);
    is("no once-mark was made again", winbackKeys().filter((k) => k.startsWith("nl:wb:once:")).length, 0);
    is("no come-back key keeps the address", holdingAddress(email), []);
    // Codex X7 on #4877 (MEDIUM, privacy): the membership's mark, a pseudonymous id of the erased person's
    // subscription, is let go too when the claim answers "erased", never kept for its 90 days.
    is("no come-back key keeps their subscription's id", winbackKeys().filter((k) => k.includes("sub_AnnErased00001")), []);
  }

  part("The erasure completes after the once-mark and grant, before the email");
  {
    const email = "bea@example.com";
    const { erase } = await world("before the email", email, "sub_BeaErased00001", "cus_BeaErased01");
    let fired = false;
    globalThis.fetch = ((inner) => (async (input: string | URL | Request, init?: RequestInit) => {
      if (!fired && new URL(String(input)).hostname === "api.resend.com") { fired = true; await erase(); }
      return inner(input, init);
    }) as typeof fetch)(globalThis.fetch);
    // The erasure must win even when it lands after the grant: it runs as the email is about to go, here at the
    // last read before the send (or at the send itself, where it is too late and the test fails).
    const before = redis.pipeline;
    let readsAfterGrant = 0;
    redis.pipeline = (async (commands: Commands) => {
      const result = await real(commands);
      if (!fired && winbackKeys().some((k) => k.startsWith("nl:wb:link:"))) {
        readsAfterGrant += 1;
        if (readsAfterGrant === 1) { fired = true; await erase(); }
      }
      return result;
    }) as typeof redis.pipeline;
    await sendWinBacks(Date.now() + 30_000, now);
    redis.pipeline = before;
    is("the erasure ran after the grant was written", fired, true);
    is("no email reached the person erased before the send", handed.filter((m) => m.to.includes(email)).length, 0);
    is("nothing of them kept", holdingAddress(email), []);
  }

  // C5-20261119-0900-4807, condition 1: on main's path the link is written after the once-mark, in a step of its own.
  // An erasure that completes between the two finds no link to delete; the link is then written with the address,
  // and the print read again before the email must take it back, or the address outlives the erasure.
  part("The erasure completes after the once-mark and before the link is written: the link is taken back");
  {
    const email = "eve@example.com";
    const { erase } = await world("before the link", email, "sub_EveErased00001", "cus_EveErased01");
    let fired = false;
    redis.pipeline = (async (commands: Commands) => {
      if (!fired && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:wb:link:"))) { fired = true; await erase(); }
      return real(commands);
    }) as typeof redis.pipeline;
    const result = await sendWinBacks(Date.now() + 30_000, now);
    redis.pipeline = real;
    is("the erasure ran just before the link was written", fired, true);
    is("no email reached them", [result.sent, handed.filter((m) => m.to.includes(email)).length], [0, 0]);
    is("no come-back key keeps the address", holdingAddress(email), []);
    is("and no once-mark is left of them", winbackKeys().filter((k) => k.startsWith("nl:wb:once:")).length, 0);
  }

  // Condition 1, its DEL read exactly (rule 24): a reply other than 0 or 1 stops the store's run, so the offers after it
  // wait for the next run, as after a link not written as asked.
  part("The link's DEL after a late erasure answered in another shape: nothing sent, and the store's run stops");
  {
    const gus = "gus@example.com";
    const fay = "fay@example.com";
    const { store } = await world("odd DEL", gus, "sub_GusLater00001", "cus_GusLater0001");
    const product = String((events[0] as { data?: { object?: { metadata?: Record<string, string> } } } | undefined)?.data?.object?.metadata?.product);
    customers.set("cus_FayErased001", fay);
    await upsertContact(store.listId as string, fay, { agreed: true, explicit: true, source: "buyer" }, ROOM);
    ended("sub_FayErased00001", "cus_FayErased001", { store: "wberased", product });
    const eraseFay = async () => {
      await real([suppressCommand(store.listId as string, fay)]);
      await forgetWinbackPerson(store.statsId, [product], fay);
      await forgetNoted(store.statsId as string, fay);
    };
    let fired = false;
    let oddDel = false;
    redis.pipeline = (async (commands: Commands) => {
      if (!fired && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:wb:link:"))) { fired = true; await eraseFay(); }
      if (fired && !oddDel && commands.length === 1 && commands[0]?.[0] === "DEL" && String(commands[0]?.[1]).startsWith("nl:wb:link:")) {
        oddDel = true;
        await real(commands);
        return [5];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const first = await sendWinBacks(Date.now() + 30_000, now);
    redis.pipeline = real;
    is("fay was erased just before her link, and its DEL answered 5", [fired, oddDel], [true, true]);
    is("nothing was sent on that run, to fay or to gus after her", [first.sent, handed.filter((m) => m.to.includes(fay)).length, handed.filter((m) => m.to.includes(gus)).length], [0, 0, 0]);
    const second = await sendWinBacks(Date.now() + 30_000, now);
    is("the next run sends gus's offer once, and never fay's", [second.sent, handed.filter((m) => m.to.includes(gus)).length, handed.filter((m) => m.to.includes(fay)).length], [1, 1, 0]);
    is("nothing keeps fay's address", holdingAddress(fay), []);
    // Priced with the links not written (come-back-unwritten-links): one such offer a run, never dearer than that one.
    is(`a late erasure's offer (${ERASED_LINK_COMMANDS} commands) costs no more than a link not written (${UNWRITTEN_LINK_COMMANDS})`, ERASED_LINK_COMMANDS <= UNWRITTEN_LINK_COMMANDS, true);
  }

  part("The dearest offer that is sent, every script's own command counted (3rjdf on #4807): inside WINBACK_OFFER_COMMANDS");
  {
    const email = "dee@example.com";
    const { store } = await world("dearest", email, "sub_DeeDear00001", "cus_DeeDear0001");
    const key = leadsKey(store.listId as string);
    const run = redis.run.bind(redis);
    let commands = 0;
    let casRounds = 0;
    let sentClaim = false;
    let offerClaim = false;
    redis.run = ((c: (string | number)[]) => {
      commands += 1;
      // The unsubscribe token's contact write (CAS_HSET): the row changes just before it twice (two rounds lost, the
      // most that still hand out a token), and on the third the script runs but its answer is lost (read back).
      if (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:contact-cas-hset:")) {
        casRounds += 1;
        if (casRounds <= 2) {
          const raw = run(["HGET", key, email]);
          if (typeof raw === "string") run(["HSET", key, email, `${raw} `]);
        } else {
          run(c);
          return ["lost"];
        }
      }
      // The membership's claim and the offer's claim each answered in another shape after landing: read back.
      if (!sentClaim && c[0] === "SET" && String(c[1]).startsWith("nl:wb:acct_")) { sentClaim = true; run(c); return "QUEUED"; }
      if (!offerClaim && c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:winback-claim:")) { offerClaim = true; run(c); return "QUEUED"; }
      return run(c);
    }) as typeof redis.run;
    const result = await sendWinBacks(Date.now() + 30_000, now).finally(() => { redis.run = run; });
    console.log(`  the dearest offer sent: ${commands} commands (${casRounds} contact writes tried)`);
    is("contested as meant: three contact writes, both claims read back", [casRounds, sentClaim, offerClaim], [3, true, true]);
    is("and still sent once", [result.sent, handed.filter((m) => m.to.includes(email)).length], [1, 1]);
    is(`at most WINBACK_OFFER_COMMANDS (${WINBACK_OFFER_COMMANDS})`, commands <= WINBACK_OFFER_COMMANDS, true);
  }

  part("Control: nobody erased, the offer goes once with its mark and link");
  {
    const email = "cal@example.com";
    await world("control", email, "sub_CalKept000001", "cus_CalKept0001");
    // Every command counted, a script's own too (the in-memory Redis runs each through run()).
    const run = redis.run.bind(redis);
    let commands = 0;
    redis.run = ((c: (string | number)[]) => { commands += 1; return run(c); }) as typeof redis.run;
    const result = await sendWinBacks(Date.now() + 30_000, now).finally(() => { redis.run = run; });
    console.log(`  one store's run with one offer sent: ${commands} commands`);
    is(`at most WINBACK_OFFER_COMMANDS (${WINBACK_OFFER_COMMANDS}), with one left for the once-mark's read-back`, commands + 1 <= WINBACK_OFFER_COMMANDS, true);
    is("sent once", [result.sent, handed.filter((m) => m.to.includes(email)).length], [1, 1]);
    is("the once-mark and the link are kept", [winbackKeys().filter((k) => k.startsWith("nl:wb:once:")).length, winbackKeys().filter((k) => k.startsWith("nl:wb:link:")).length], [1, 1]);
  }
  done();
}
void main().catch((error) => { console.error(error); process.exit(1); });
