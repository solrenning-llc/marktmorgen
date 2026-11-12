/**
 * The one reminder after a checkout left unpaid, for a single product
 * (lib/checkout-recovery.ts, remindAbandoned; ClickFunnels audit F17, added
 * 17 October 2026). The cart and the call each have a file of their own
 * (tests/cart-reminder.test.ts, tests/call-reminder.test.ts); this one walks
 * the stop conditions every reminder shares, end to end:
 *
 *   - nothing unless the creator switched it on with a postal address, and
 *     nothing without Stripe's recorded "opt_in";
 *   - nothing for another store's checkout, one still open, or one that closed
 *     more than six hours ago;
 *   - one email, with the product's link, its price today, why it came, the
 *     stop link and the creator's address, and the one-click unsubscribe header;
 *   - after "stop", nothing from that store to that address again, about any
 *     product; nothing to an address that left the list or bounced;
 *   - an email the sender refused is not counted as sent: the next run tries;
 *     one whose answer is not known (a 503) may have gone, so it is not sent
 *     again (rule 30; tests/uncertain-send-checkout-recovery.test.ts).
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readStopToken, remindAbandoned, stopReminders } from "@/lib/checkout-recovery";
import { stopWriting, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_journey_only";
process.env.RESEND_API_KEY = "re_test_recovery_journey_only";

const OWNER = "potter@example.com";
type Mail = { to: string; subject: string; text: string; headers?: Record<string, string> };
const emails: Mail[] = [];
/** What the sender answers instead of a plain yes: a certain refusal (422) or an answer not known (503). */
let senderSays: 200 | 422 | 503 = 200;
let paidSessions: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (senderSays !== 200) return answer({ message: senderSays === 503 ? "unavailable" : "invalid recipient" }, senderSays);
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string; headers?: Record<string, string> };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text, headers: body.headers });
    return answer({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && method === "GET") return answer({ object: "list", data: paidSessions, has_more: false });
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "clayworks", "Clay Works", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestClay00001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const glaze = await add("Glaze Recipes", "24");
  const wheel = await add("Wheel Throwing Class", "59");
  const load = async () => (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  const left = (id: string, email: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      object: "checkout.session",
      status: "expired",
      payment_status: "unpaid",
      created: now - 3700,
      expires_at: now - 100,
      consent: { promotions: "opt_in" },
      customer_details: { email },
      metadata: { store: "clayworks", product: glaze },
      ...over,
    }) as never;

  part("Off until the creator switches it on, with an address");
  is("off: nothing", await remindAbandoned(await load(), left("cs_test_off00000000001", "ana@example.com")), "skip");
  await setRecovery(OWNER, { enabled: true, address: "", asks: true });
  is("on without a postal address reads as off", await remindAbandoned(await load(), left("cs_test_off00000000002", "ana@example.com")), "skip");
  await setRecovery(OWNER, { enabled: true, address: "9 Kiln Road, Portland, OR 97201", asks: true });

  part("Only Stripe's recorded yes, for this store, in its window");
  is("no consent recorded", await remindAbandoned(await load(), left("cs_test_noyes000000001", "ana@example.com", { consent: null })), "skip");
  is("consent refused", await remindAbandoned(await load(), left("cs_test_noyes000000002", "ana@example.com", { consent: { promotions: "opt_out" } })), "skip");
  is("another store's checkout", await remindAbandoned(await load(), left("cs_test_other000000001", "ana@example.com", { metadata: { store: "elsewhere", product: glaze } })), "skip");
  is("a checkout still open", await remindAbandoned(await load(), left("cs_test_open0000000001", "ana@example.com", { status: "open" })), "skip");
  is("closed more than six hours ago", await remindAbandoned(await load(), left("cs_test_late0000000001", "ana@example.com", { expires_at: now - 7 * 3600 })), "skip");
  is("nothing was sent for any of them", emails.length, 0);

  part("One email, saying why it came and how to stop it");
  is("sent", await remindAbandoned(await load(), left("cs_test_left0000000001", "ana@example.com")), "sent");
  const mail = emails.at(-1)!;
  is("to the buyer, about the product", [mail.to, mail.subject.includes("Glaze Recipes")], ["ana@example.com", true]);
  is(
    "the product's page, today's price, why it came, the stop link and the creator's address",
    [mail.text.includes(`/p/${glaze}`), mail.text.includes("$24"), mail.text.includes("you agreed, on the checkout page"), /\/unsubscribe\?r=[0-9a-f]{40}/.test(mail.text), mail.text.includes("9 Kiln Road, Portland, OR 97201")],
    [true, true, true, true, true],
  );
  is("a mail app can stop it in one press", [/\/api\/mail\/unsubscribe\?r=[0-9a-f]{40}/.test(mail.headers?.["List-Unsubscribe"] ?? ""), mail.headers?.["List-Unsubscribe-Post"]], [true, "List-Unsubscribe=One-Click"]);
  is("never twice for that checkout", await remindAbandoned(await load(), left("cs_test_left0000000001", "ana@example.com")), "skip");
  is("nor for the same product in a week, from another checkout", await remindAbandoned(await load(), left("cs_test_left0000000002", "Ana@Example.com")), "skip");
  paidSessions = [{ id: "cs_test_paid0000000001", status: "complete", payment_status: "paid", metadata: { store: "clayworks", product: wheel } }];
  is("nor to somebody who paid for it since", await remindAbandoned(await load(), left("cs_test_left0000000003", "ben@example.com", { metadata: { store: "clayworks", product: wheel } })), "skip");
  paidSessions = [];

  part("Stop means stop, for every product of the store");
  const token = /\/unsubscribe\?r=([0-9a-f]{40})/.exec(mail.text)?.[1] ?? "";
  is("the stop link names the address, not yet stopped", [(await readStopToken(token))?.email, (await readStopToken(token))?.stopped], ["ana@example.com", false]);
  is("pressed", await stopReminders(token), true);
  is("pressed twice is the same", [await stopReminders(token), (await readStopToken(token))?.stopped], [true, true]);
  is("another product, another checkout: nothing", await remindAbandoned(await load(), left("cs_test_left0000000004", "ana@example.com", { metadata: { store: "clayworks", product: wheel } })), "skip");

  part("Nobody who left the list, or whose address bounced");
  const listId = (await load()).listId!;
  await upsertContact(listId, "cy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(listId, "dee@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await stopWriting(listId, "dee@example.com", "bounced");
  // Leaving the list through the link its own emails carry.
  const listToken = (await tokensFor(listId, ["cy@example.com"], "clayworks")).get("cy@example.com") ?? "";
  is("the list's own unsubscribe link worked", (await unsubscribe(listToken))?.email, "cy@example.com");
  is("left the list: no reminder", await remindAbandoned(await load(), left("cs_test_left0000000005", "cy@example.com")), "skip");
  is("bounced for good: no reminder", await remindAbandoned(await load(), left("cs_test_left0000000006", "dee@example.com")), "skip");

  part("Refused by the sender: not counted, tried again");
  // Rule 23 (uncertain-send-crons, 9 November 2026): this part used a 503, which sendEmailOutcome reads as an answer
  // not known, not a refusal; the retry it asserted is the duplicate the change removes. The certain refusal is now a
  // 422 (same assertions), and the 503 is asserted below to keep its marks.
  senderSays = 422;
  const before = emails.length;
  is("the sender refuses", await remindAbandoned(await load(), left("cs_test_left0000000007", "eve@example.com")), "failed");
  senderSays = 200;
  is("the next run sends it, once", [await remindAbandoned(await load(), left("cs_test_left0000000007", "eve@example.com")), emails.length - before], ["sent", 1]);

  part("An answer not known: not counted as sent, and never sent again");
  senderSays = 503;
  is("the sender's answer is not known", await remindAbandoned(await load(), left("cs_test_left0000000008", "fay@example.com")), "failed");
  senderSays = 200;
  is("the next run leaves it, so it is never sent twice", [await remindAbandoned(await load(), left("cs_test_left0000000008", "fay@example.com")), emails.filter((m) => m.to === "fay@example.com").length], ["skip", 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
