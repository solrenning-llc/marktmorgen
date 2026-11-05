/**
 * Waitlists: a product coming soon takes confirmed addresses, and the day it
 * goes on sale each gets one email.
 *
 * Measured before it was built (30 September 2026): Stan's "Product coming
 * soon!" only means no way to pay is connected; Whop's waitlist admits people
 * one by one and documents no email at launch. What is checked:
 *
 *   - only a product marked coming soon takes sign-ups;
 *   - an address counts once its owner presses the button in the email, and
 *     joins the creator's list only if they checked the box;
 *   - launching puts the product on sale, needs a postal address when anyone
 *     will be emailed, and emails each confirmed address exactly once, with
 *     the link, the price, the note, the address and a one-click way out;
 *   - whoever left is not emailed, and the addresses are gone afterwards.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, isSoon, joinWaitlist, launch, leaveWaitlist, runLaunches, setSoon, soonProducts, waitlistViews } from "@/lib/waitlist";
import { launchBody } from "@/lib/waitlist-rules";
import { leadsKey } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { productSegment } from "@/lib/product-slug";

type Sent = { to: string[]; subject: string; text: string; headers?: Record<string, string> };
const single: Sent[] = [];
const batches: Sent[][] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    batches.push(batch);
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  if (url.hostname === "api.resend.com") {
    single.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const tokenIn = (text: string) => text.match(/token=([0-9a-f]{48})/)?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const made = await addProduct("owner@example.com", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const origin = "https://marktmorgen.com";
  const join = (email: string, consent = false, ip = "1.1.1.1") => joinWaitlist({ store, product, email, consent, ip, origin });

  part("Only a product coming soon");
  is("not before it is marked", await join("dana@example.com"), "closed");
  await setSoon(store, product.id, true);
  is("marked", [await isSoon(store, product.id), (await soonProducts(store)).has(product.id)], [true, true]);
  is("an address that is not one", await join("not-an-address"), "email");

  part("Joining, and confirming");
  is("Dana joins", await join("Dana@Example.com"), "sent");
  is("an email with a button to confirm", [single.length, single[0]?.to, single[0]?.subject], [1, ["dana@example.com"], "Confirm your spot: The Bread Book"]);
  is("it says no other email comes unless the box was checked", single[0]?.text.includes("You did not check the box"), true);
  let view = (await waitlistViews(store, [product.id]))[product.id];
  is("not counted until confirmed", [view.confirmed, view.waiting], [0, 1]);
  const danaConfirm = tokenIn(single[0].text);
  is("the button counts it", (await confirmSpot(danaConfirm, store)).ok, true);
  is("pressed twice, still one", (await confirmSpot(danaConfirm, store)).ok, true);
  view = (await waitlistViews(store, [product.id]))[product.id];
  is("confirmed", [view.confirmed, view.waiting], [1, 0]);
  const leads = leadsKey(store.listId!);
  is("without the box, not on the creator's list", redis.run(["HGET", leads, "dana@example.com"]), null);

  is("Hal joins and asks to hear more", await join("hal@example.com", true, "2.2.2.2"), "sent");
  await confirmSpot(tokenIn(single[1].text), store);
  is("on the creator's list, as he asked", typeof redis.run(["HGET", leads, "hal@example.com"]), "string");
  is("Sam joins and never confirms", await join("sam@example.com", false, "3.3.3.3"), "sent");
  is("Kim joins, confirms, then leaves", await join("kim@example.com", false, "4.4.4.4"), "sent");
  await confirmSpot(tokenIn(single[3].text), store);

  part("Too many at once");
  for (let i = 0; i < 5; i += 1) await join("flood@example.com", false, `9.9.9.${i}`);
  is("the same address, a sixth time in an hour", await join("flood@example.com", false, "9.9.9.9"), "limited");

  part("Launching");
  const noAddress = await launch(store, product, { note: "", address: "" });
  is("a postal address is asked for when anyone will be emailed", noAddress.ok ? "launched" : noAddress.reason, "address");
  is("and nothing changed", await isSoon(store, product.id), true);
  // Kim leaves with the link every waitlist email carries; she has one from the start.
  const kimLeave = JSON.parse(String(redis.run(["HGET", `nl:wl:${store.statsId}:${product.id}`, "kim@example.com"]))).t as string;
  const launched = await launch(store, product, { note: "Thank you for waiting.", address: "1 Main St, Portland, OR 97201" });
  is("launched, for everyone confirmed then", launched.ok && launched.total, 3);
  is("on sale at once", await isSoon(store, product.id), false);
  is("Kim leaves before it goes out", await leaveWaitlist(kimLeave), true);
  is("a coming-soon sign-up is refused now", await join("late@example.com"), "closed");

  const sent = await runLaunches(async () => (await storeForEmail("owner@example.com"))!, readListing, Date.now() + 10_000);
  is("one batch, to the confirmed who stayed", [sent, batches.length, batches[0]?.map((m) => m.to[0])], [2, 1, ["dana@example.com", "hal@example.com"]]);
  const email = batches[0][0];
  is("its subject", email.subject, "The Bread Book is out");
  is("its link and price", email.text.includes(`/@harbor/p/${productSegment(product)}`) && email.text.includes("$39"), true);
  is("the note", email.text.includes("Thank you for waiting."), true);
  is("the postal address", email.text.includes("1 Main St, Portland, OR 97201"), true);
  is("a one-click way out", Boolean(email.headers?.["List-Unsubscribe"]), true);
  is("never to Sam, who did not confirm", batches.flat().some((m) => m.to[0] === "sam@example.com"), false);
  is("run again, nothing more", await runLaunches(async () => store, readListing, Date.now() + 10_000), 0);
  view = (await waitlistViews(store, [product.id]))[product.id];
  is("the addresses are gone, the count stays", [view.confirmed, view.waiting, view.launch?.sent, Boolean(view.launch?.finished)], [0, 0, 2, true]);

  part("The words");
  is(
    "without a price or note",
    launchBody({ storeName: "Harbor", title: "X", price: "", link: "https://a.b/p", note: " " }).body,
    "You asked Harbor to tell you when X came out. It is out now:\n\nhttps://a.b/p",
  );

  done();
}

void main();
