/**
 * CX-123 rule 24 (Claude 6 audit, round 6, finding 3): the come-back offer (lib/winback-send.ts) goes once per ended
 * membership. sendEmail answers false both when the email was refused and when it is not known (the provider may
 * have taken it and the reply been lost), so false keeps the membership's mark, the once-a-while mark and the
 * offer's link, as lib/trial-nudges.ts keeps its mark: the person is never written to twice, and the link in an email
 * that may have arrived keeps working. Stripe and the sender are played by a stand-in for `fetch`; ids are synthetic.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { readWinBack, sendWinBacks } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const OWNER = "wb-uncertain@example.com";

type Sent = { to: string[]; text?: string };
/** Every email handed to the sender, whatever it answered. */
const handed: Sent[] = [];
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();
/** How the sender answers: "ok", a 500 (not known whether it went), or a dropped connection. */
let sender: "ok" | "500" | "drop" = "ok";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    handed.push(JSON.parse(String(init?.body)) as Sent);
    if (sender === "drop") throw new TypeError("synthetic: the connection dropped after the request went out");
    if (sender === "500") return new Response(JSON.stringify({ message: "synthetic server error" }), { status: 500 });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    return answer({ object: "list", data: events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte), has_more: false });
  }
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

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_wb_uncertain_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  const made = await claimHandle(OWNER, "wbunsure", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestWbUnsure", true);
  await setSubscription(OWNER, { customerId: "cus_WbUnsureOwner", subscriptionId: "sub_WbUnsureOwner", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const meta = { store: "wbunsure", product: club.product.id };
  for (const name of ["ann", "bob", "cat"]) {
    const id = `cus_${name[0].toUpperCase()}${name.slice(1)}Unsure01`;
    customers.set(id, `${name}@example.com`);
    await upsertContact(store.listId as string, `${name}@example.com`, { agreed: true, explicit: true, source: "buyer" }, ROOM);
  }
  const cus = (name: string) => [...customers.entries()].find(([, email]) => email === `${name}@example.com`)![0];
  const to = (address: string) => handed.filter((e) => e.to[0] === address);
  const tokenOf = (mail: Sent | undefined) => String(mail?.text ?? "").match(/[?&]back=([0-9a-f]{40})/)?.[1] ?? "";
  const run = () => sendWinBacks(Date.now() + 30_000, now);

  part("Healthy control: sent once, its link works, and never again");
  ended("sub_AnnUnsure0001", cus("ann"), meta);
  sender = "ok";
  is("the first run sends Ann's offer", (await run()).sent, 1);
  is("Ann was written to once", to("ann@example.com").length, 1);
  is("its link opens the offer", (await readWinBack(store, club.product.id, tokenOf(to("ann@example.com")[0])))?.email, "ann@example.com");
  await run();
  is("the next run does not write to Ann again", to("ann@example.com").length, 1);

  for (const [who, how] of [["bob", "500"], ["cat", "drop"]] as const) {
    part(`The sender answered ${how === "500" ? "a server error" : "nothing (a dropped connection)"}: not known whether it went`);
    ended(`sub_${who[0].toUpperCase()}${who.slice(1)}Unsure0001`, cus(who), meta);
    sender = how;
    is(`the first run counts ${who}'s offer as not sent`, (await run()).sent, 0);
    is(`${who}'s offer was handed to the sender once`, to(`${who}@example.com`).length, 1);
    const token = tokenOf(to(`${who}@example.com`)[0]);
    is("the email carried a link", token.length, 40);
    sender = "ok";
    await run();
    is(`the next run does not write to ${who} a second time`, to(`${who}@example.com`).length, 1);
    is("the link in the email that may have arrived still opens the offer", (await readWinBack(store, club.product.id, token))?.email, `${who}@example.com`);
  }
  done();
}
void main().catch((error) => { console.error(error); process.exit(1); });
