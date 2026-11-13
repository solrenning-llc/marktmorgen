/**
 * A contact's row is written back only where it still holds what was read
 * (ALL-160, after the #3925 lists hunt). upsertContact, noteProduct
 * (lib/contacts.ts) and stopCounting (lib/mail-clicks.ts) read a row, decided,
 * then wrote it back with a plain HSET, inside an order's script
 * (lib/order-data.ts, ORDER_WRITE) or not: an unsubscribe, a bounce or a merge
 * landing between the read and the write was written over, and somebody who
 * had just left was written back as somebody who may be emailed. Now the write
 * checks what it read in the same step, and a row changed meanwhile is read
 * again and decided again; a write whose answer cannot be read writes nothing
 * more and throws, so it is tried again. Synthetic data only; the moment is
 * made by writing the row just before the function's write runs.
 */
import { forgetContactPerson, leadsKey, mailable, noteProduct, orderRoom, parseContact, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { stopCounting } from "@/lib/mail-clicks";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { CART_STOCK_COMMANDS_MOST, CART_STOCK_SHARE_OF_ORDER_COMPUTE, COMMAND, ORDER_COMPUTE, ORDER_CONTACT_CHECK_COMMANDS_MOST, ORDER_CONTACT_CHECK_SHARE_OF_ORDER_COMPUTE } from "./plan-cost-registry";
import { MAX_CART } from "@/lib/cart-rules";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let between: (() => Promise<void>) | null = null;
let garble = false;

/** A batch that writes a list's row: a plain HSET, the checked script, or an order's script holding a list's key. */
const writesRow = (batch: Command[]) =>
  batch.some(
    (c) =>
      (c[0] === "HSET" && String(c[1]).startsWith("nl:store:leads:")) ||
      (c[0] === "EVAL" && String(c[1]).includes("contact-cas-hset")) ||
      (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:order-write:") && c.some((a) => String(a).startsWith("nl:store:leads:") && !String(a).endsWith(":agreed") && !String(a).endsWith(":unsub"))),
  );
const readsBack = (batch: Command[]) => batch.length === 1 && batch[0][0] === "HMGET" && String(batch[0][1]).startsWith("nl:store:leads:");

redis.pipeline = (async (batch: Command[]) => {
  // An answer nobody can read, for the row's write and for any read-back of it; nothing of the write is run.
  if (garble && (writesRow(batch) || readsBack(batch))) return batch.map(() => "garbled");
  if (between && writesRow(batch)) {
    const run = between;
    between = null;
    await run();
  }
  return real(batch);
}) as typeof redis.pipeline;

const OWNER = "contact-cas@example.com";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "contact-cas", "Contact Cas", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ContactCas01", subscriptionId: "sub_ContactCas01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  const key = leadsKey(listId);
  const row = async (email: string) => parseContact((await real([["HGET", key, email]]))[0]);
  const raw = async (email: string) => (await real([["HGET", key, email]]))[0];
  /** What an unsubscribe (or a bounce) leaves on the row, written in the moment between. */
  const leaveNow = (email: string, extra: Record<string, unknown> = {}) => async () => {
    const was = (await row(email))!;
    const { clicks: _gone, ...kept } = was;
    void _gone;
    await real([["HSET", key, email, JSON.stringify({ ...kept, unsub: true, unsubAt: new Date().toISOString(), ...extra })]]);
  };
  const earlier = new Date(Date.now() - 60_000).toISOString();

  part("upsertContact: an unsubscribe in the moment between stands");
  await upsertContact(listId, "ann@example.com", { agreed: false, explicit: false, source: "buyer" }, ROOM);
  between = leaveNow("ann@example.com");
  await upsertContact(listId, "ann@example.com", { agreed: true, explicit: true, at: earlier, source: "free", productId: "p-ann", title: "Guide" }, ROOM);
  const ann = await row("ann@example.com");
  is("still unsubscribed, not emailable", [ann?.unsub, ann ? mailable(ann) : true], [true, false]);
  is("and the product is still noted", ann?.ids.includes("p-ann"), true);

  part("upsertContact, an order's write: a bounce in the moment between stands");
  await upsertContact(listId, "bea@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  between = leaveNow("bea@example.com", { gone: "bounced" });
  await upsertContact(listId, "bea@example.com", { agreed: true, explicit: true, at: earlier, source: "buyer", productId: "p-bea", title: "Course" }, orderRoom(store));
  const bea = await row("bea@example.com");
  is("still taken off, for the bounce", [bea?.unsub, bea?.gone, bea ? mailable(bea) : true], [true, "bounced", false]);
  is("and the purchase is still noted", bea?.ids.includes("p-bea"), true);

  part("upsertContact: a merge in the moment between is kept");
  await upsertContact(listId, "cy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  between = async () => {
    const was = (await row("cy@example.com"))!;
    await real([["HSET", key, "cy@example.com", JSON.stringify({ ...was, name: "Cy Merged", tags: ["vip"] })]]);
  };
  await upsertContact(listId, "cy@example.com", { agreed: true, explicit: false, source: "import", productId: "p-cy", title: "Ebook" }, ROOM);
  const cy = await row("cy@example.com");
  is("the merged name and label stay, and the product is noted", [cy?.name, cy?.tags, cy?.ids.includes("p-cy")], ["Cy Merged", ["vip"], true]);

  part("noteProduct: an unsubscribe in the moment between stands");
  await upsertContact(listId, "dee@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  between = leaveNow("dee@example.com");
  await noteProduct(listId, "dee@example.com", "p-dee", "Workbook", store);
  const dee = await row("dee@example.com");
  is("still unsubscribed, not emailable", [dee?.unsub, dee ? mailable(dee) : true], [true, false]);
  is("and the product is still noted", dee?.ids.includes("p-dee"), true);

  part("stopCounting: an unsubscribe in the moment between stands");
  await upsertContact(listId, "eli@example.com", { agreed: true, explicit: true, clicks: true, source: "free" }, ROOM);
  const token = (await tokensFor(listId, ["eli@example.com"], store.handle)).get("eli@example.com")!;
  between = leaveNow("eli@example.com");
  await stopCounting(token);
  const eli = await row("eli@example.com");
  is("still unsubscribed, and nothing counted", [eli?.unsub, Boolean(eli?.clicks), eli ? mailable(eli) : true], [true, false, false]);

  part("A write whose answer cannot be read writes nothing and throws, to be tried again");
  const thrown = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "returned";
    } catch (error) {
      return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
    }
  };
  await upsertContact(listId, "fay@example.com", { agreed: false, explicit: false, source: "buyer" }, ROOM);
  await upsertContact(listId, "gil@example.com", { agreed: true, explicit: true, clicks: true, source: "free" }, ROOM);
  const gilToken = (await tokensFor(listId, ["gil@example.com"], store.handle)).get("gil@example.com")!;
  const fayWas = await raw("fay@example.com");
  const gilWas = await raw("gil@example.com");
  garble = true;
  const answers = [
    await thrown(() => upsertContact(listId, "fay@example.com", { agreed: true, explicit: true, source: "free" }, ROOM)),
    await thrown(() => noteProduct(listId, "fay@example.com", "p-fay", "Guide", store)),
    await thrown(() => stopCounting(gilToken)),
  ];
  garble = false;
  is("each throws UnknownReplyError", answers, ["unknown", "unknown", "unknown"]);
  is("and the rows are as they were", [await raw("fay@example.com"), await raw("gil@example.com")], [fayWas, gilWas]);

  part("unsubscribe: an erasure in the moment between stays done (Claude 1 cloud MEDIUM on #4244)");
  await upsertContact(listId, "ivy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const ivyToken = (await tokensFor(listId, ["ivy@example.com"], store.handle)).get("ivy@example.com")!;
  const unsubBefore = Number((await real([["GET", `${key}:unsub`]]))[0] ?? 0);
  between = async () => {
    await forgetContactPerson(listId, "ivy@example.com");
  };
  const left = await unsubscribe(ivyToken);
  is("(control) the erasure ran inside the unsubscribe", between, null);
  is("the erased contact is not written back", await raw("ivy@example.com"), null);
  is("and the list's count of those who left is not raised for them", Number((await real([["GET", `${key}:unsub`]]))[0] ?? 0), unsubBefore);
  is("the person is told they are off the list", left?.email, "ivy@example.com");

  part("unsubscribe: another write in the moment between is kept, and the unsubscribe still stands");
  await upsertContact(listId, "jon@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const jonToken = (await tokensFor(listId, ["jon@example.com"], store.handle)).get("jon@example.com")!;
  between = async () => {
    await noteProduct(listId, "jon@example.com", "p-jon", "Guide", store);
  };
  await unsubscribe(jonToken);
  const jon = await row("jon@example.com");
  is("unsubscribed, and the product noted meanwhile kept", [jon?.unsub, jon?.ids.includes("p-jon")], [true, true]);

  part("Without anything in between, each writes as before");
  await upsertContact(listId, "hal@example.com", { agreed: true, explicit: true, clicks: true, source: "free" }, ROOM);
  await noteProduct(listId, "hal@example.com", "p-hal", "Guide", store);
  const halToken = (await tokensFor(listId, ["hal@example.com"], store.handle)).get("hal@example.com")!;
  await stopCounting(halToken);
  const hal = await row("hal@example.com");
  is("agreed, product noted, counting stopped", [hal?.agreed, hal?.unsub, hal?.ids.includes("p-hal"), Boolean(hal?.clicks)], [true, false, true, false]);
  part("What the checks add to an order is inside its declared share of the order's compute");
  // A cart of MAX_CART with the box ticked: upsertContact (3 reads) then noteProduct (1 read) for the rest, each a check's
  // HGET and two rounds more at most of its reads, the EVAL and the HGET; and the thank-you page's own upsertContact.
  const upsert = 1 + 2 * (3 + 2);
  const note = 1 + 2 * (1 + 2);
  is("the worst order's checks are counted in full", upsert + (MAX_CART - 1) * note + upsert <= ORDER_CONTACT_CHECK_COMMANDS_MOST && MAX_CART * note + upsert <= ORDER_CONTACT_CHECK_COMMANDS_MOST, true);
  is("and fit their share, beside the cart's stock work", [ORDER_CONTACT_CHECK_COMMANDS_MOST * COMMAND <= ORDER_CONTACT_CHECK_SHARE_OF_ORDER_COMPUTE * ORDER_COMPUTE, CART_STOCK_COMMANDS_MOST * COMMAND <= CART_STOCK_SHARE_OF_ORDER_COMPUTE * ORDER_COMPUTE, ORDER_CONTACT_CHECK_SHARE_OF_ORDER_COMPUTE + CART_STOCK_SHARE_OF_ORDER_COMPUTE < 1], [true, true, true]);
  done();
}

void main();
