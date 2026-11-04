/**
 * Telling a product's buyers it was updated (lib/product-updates.ts, added
 * 11 October 2026). What is checked:
 *
 *   - the buyers are read from the store's paid checkouts of the product, on
 *     its own or added at checkout, once each; a gift's buyer, another
 *     store's sale and an unpaid checkout are left out;
 *   - only on Pro, only for something bought once, only when somebody bought
 *     it, and once a week at most per product, however many presses;
 *   - the email says there is a new version, carries the creator's words and
 *     the store's orders page, in the store's language, from the creator's
 *     name, with a link to stop these emails;
 *   - nobody who pressed that stop, or left the creator's list, is written to,
 *     and it is counted in the store's month.
 */
import { advanceUpdate, buyersFrom, readUpdateStop, startUpdate, stopUpdates, updateText } from "@/lib/product-updates";
import { UPDATES_WORDS } from "@/lib/buyer-words/updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { upsertContact, unsubscribe, tokensFor } from "@/lib/contacts";
import { usedThisMonth } from "@/lib/mail";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { windowId } from "@/lib/allowance-window";
import { ROOM } from "./data-room";

const OWNER = "owner@example.com";
type Message = { to: string; subject: string; text: string; headers?: Record<string, string> };
const batches: Message[][] = [];
let sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (url.pathname === "/emails/batch") batches.push(JSON.parse(String(init?.body)) as Message[]);
    return new Response(JSON.stringify({ id: "email_1", data: [] }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  if (path === "/checkout/sessions") return list(sessions);
  return list([]);
}) as typeof fetch;

const paid = (id: string, email: string, meta: Record<string, string>, over: Record<string, unknown> = {}) => ({
  id,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  created: Math.floor(Date.now() / 1000) - 86_400,
  amount_total: 2700,
  currency: "usd",
  customer_details: { email },
  metadata: { store: "harbor", ...meta },
  ...over,
});

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Weekly Meal Planner", "", "27", null);
  const other = await addProduct(OWNER, "Pantry Checklist", "", "5", null);
  if (!made.ok || !other.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductLink(OWNER, id, "https://example.com/planner");
  const load = async () => (await storeForEmail(OWNER))!;

  part("Who bought it");
  const handles = new Set(["harbor"]);
  sessions = [
    paid("cs_1", "Ana@Example.com", { product: id }),
    paid("cs_2", "ana@example.com", { product: id }),
    paid("cs_3", "ben@example.com", { product: other.product.id, bump: id }),
    paid("cs_4", "cy@example.com", { product: id, gift: "g1" }),
    paid("cs_5", "dee@example.com", { product: id, store: "elsewhere" }),
    paid("cs_6", "eve@example.com", { product: id }, { payment_status: "unpaid" }),
    paid("cs_7", "fay@example.com", { product: other.product.id }),
  ];
  is("once each, on its own or added at checkout; not a gift's buyer, another store's or an unpaid one", buyersFrom(sessions, handles, id), ["ana@example.com", "ben@example.com"]);

  part("Only where it can be sent");
  const product = (await readListing(await load(), id))!;
  is("not without Pro", (await startUpdate(await load(), product, "")).ok ? "started" : "plan", "plan");
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Jenny at Harbor", address: "1 Main St, Portland, OR 97201" });
  const unsold = (await readListing(await load(), other.product.id))!;
  sessions = sessions.filter((s) => (s.metadata as Record<string, string>).product !== other.product.id || (s.metadata as Record<string, string>).bump);
  is("not when nobody bought it", await startUpdate(await load(), { ...unsold, id: "nothing01" }, "").then((r) => (r.ok ? "started" : r.reason)), "none");
  is("not on a membership or a call", (await startUpdate(await load(), { ...product, recurring: { interval: "month", trialDays: 0, payments: 0 } }, "")).ok ? "started" : "refused", "refused");

  // Ben left the creator's list: an update is still about what he bought, but he said no to their email.
  const store = await load();
  await upsertContact(store.listId as string, "ben@example.com", { agreed: true, explicit: true, source: "import" }, ROOM);
  const ben = (await tokensFor(store.listId as string, ["ben@example.com"], store.handle)).get("ben@example.com");
  if (ben) await unsubscribe(ben);

  const started = await startUpdate(await load(), product, "Ten new recipes.\r\n\r\n\r\nAnd one-page shopping lists.");
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  is("started for every buyer", started.job.total, 2);
  const again = await startUpdate(await load(), product, "Again");
  is("once a week at most, however many presses", again.ok ? "started" : [again.reason, (again.until ?? 0) - started.job.createdAt], ["soon", 7 * 86_400]);

  part("The email");
  const before = await usedThisMonth((await load()).listId, windowId(await load()));
  const job = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
  const sent = batches.flat().map((m) => ({ ...m, to: [m.to].flat()[0] as string }));
  is("sent, to Ana only: Ben left the list", [job?.status, sent.map((m) => m.to)], ["sent", ["ana@example.com"]]);
  const mail = sent[0];
  const text = updateText(await load(), "Weekly Meal Planner", "x");
  is("that there is a new version, the creator's words, and the orders page", [mail.subject, mail.text.includes("There is a new version of Weekly Meal Planner, which you bought from Jenny at Harbor."), mail.text.includes("Ten new recipes.\n\nAnd one-page shopping lists."), mail.text.includes("https://marktmorgen.com/@harbor/orders")], ["Weekly Meal Planner has been updated", true, true, true]);
  is("with why it came, a way to stop them and the postal address", [mail.text.includes("because you bought Weekly Meal Planner from Jenny at Harbor"), mail.text.includes("/unsubscribe?u="), mail.text.includes("1 Main St, Portland, OR 97201"), Boolean(mail.headers?.["List-Unsubscribe"])], [true, true, true, true]);
  is("counted in the store's month", (await usedThisMonth((await load()).listId, windowId(await load()))) - before, 1);
  is("the words of the email in every store language", new Set(Object.values(UPDATES_WORDS).map((w) => w.subject("X"))).size, 7);
  is("the subject comes from the words", text.subject, "Weekly Meal Planner has been updated");

  part("Stopped for good");
  const token = (mail.text.match(/\/unsubscribe\?u=([0-9a-f]{40})/) ?? [])[1] ?? "";
  is("the link knows whose it is", (await readUpdateStop(token))?.email, "ana@example.com");
  is("one press stops them", [await stopUpdates(token), (await readUpdateStop(token))?.stopped], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
