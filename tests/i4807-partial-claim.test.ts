/** #4807, Codex X4 (X4-20261119-0801-fix-branch-4807, MEDIUM): A partially executed Redis claim must not recover an earlier once-mark as proof of a complete erasure index.
 * Full worker with synthetic providers; Redis commands before the error remain applied, as in real Lua. */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import { forgetWinbackPerson, sendWinBacks } from "@/lib/winback-send";
import { forgetNoted } from "@/lib/erasure-index";
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

  part("A script failure after the once-mark cannot be recovered as a fully indexed grant");
  const email="partial-index@example.com";
  await world("partial claim",email,"sub_PartialIndex0001","cus_PartialIndex01");
  const run=redis.run.bind(redis);let interrupted=0;
  redis.run=((c:(string|number)[])=>{
    if(c[0]==="ZADD"&&String(c[1]).startsWith("nl:erase:ix:")&&String(c[3]).startsWith("nl:wb:link:")){interrupted+=1;throw Error("synthetic Redis WRONGTYPE at erasure index");}
    return run(c);
  }) as typeof redis.run;
  await sendWinBacks(Date.now()+30_000,now).finally(()=>{redis.run=run;});
  is("the script reached the failing index operation",interrupted,1);
  is("no email relies on a claim whose grant was not indexed",handed.filter(m=>m.to.includes(email)).length,0);
  is("no address-bearing grant exists outside its erasure index",holdingAddress(email),[]);
  done();
}
void main().catch(error=>{console.error(error);process.exit(1)});
