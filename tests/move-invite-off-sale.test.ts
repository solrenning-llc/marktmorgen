/**
 * 642 [WG2], Revisor 1's light note decided by Claude 4 (C4-20261105-1945-C2-2,
 * (1)): a member invited to move here from another platform on a price the
 * creator has since taken off sale keeps that price. Their moving-in link,
 * page, email and reminder name it and open it, at that price, read by the id
 * the invitation recorded, with a valid invitation not yet kept. Nobody else
 * gets it: a new link, the product page, a gift, a group or a plan still refuse
 * an option off sale, and an invitation already kept does not reopen it.
 * Stripe and the email sender are played by a stand-in for `fetch`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { forgetInvitesPerson, inviteEmail, inviteMembers, noteKept, openMove, priceWords, readInvite } from "@/lib/move-members";
import { createCheckout } from "@/lib/store-checkout";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { namedPriceOffered, sellableOptions, withInvitedOption } from "@/lib/product-option";
import { givableOptions } from "@/lib/gift-rules";
import { moveWords } from "@/lib/buyer-words/move";
import MovePage from "@/app/[handle]/move/[product]/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "invite-off-sale@example.com";
const DAY = 86_400;
const nowS = Math.floor(Date.now() / 1000);
const checkouts: URLSearchParams[] = [];
/** The checkouts Stripe lists to the sweep (lib/checkout-sweep.ts). */
let swept: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"m".repeat(20)}${checkouts.length}`, url: `https://checkout.stripe.com/c/pay/test${checkouts.length}` }));
  }
  if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ object: "list", data: path === "/checkout/sessions" ? swept : [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

/** Marks option `id` off sale wherever the store keeps it, as the studio does (642 [WG2], unit 2). */
function takeOffSale(id: string): number {
  let patched = 0;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const next: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) next[key] = walk(inner);
    if (next.id === id && typeof next.priceCents === "number" && "label" in next) {
      next.offSale = true;
      patched += 1;
    }
    return next;
  };
  for (const key of redis.keys()) {
    if (redis.run(["TYPE", key]) !== "string") continue;
    const raw = redis.run(["GET", key]);
    if (typeof raw !== "string" || !raw.includes(id)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const before = patched;
    const next = walk(parsed);
    if (patched > before) redis.run(["SET", key, JSON.stringify(next)]);
  }
  return patched;
}

const movePage = async (handle: string, product: string, query: Record<string, string>) =>
  renderToStaticMarkup(await MovePage({ params: Promise.resolve({ handle: `@${handle}`, product }), searchParams: Promise.resolve(query) }));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invite_off_sale_only";
  redis.clear();

  const made = await claimHandle(OWNER, "inviteoffsale", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestInvOff01", true);
  await setSubscription(OWNER, { customerId: "cus_InvOff01", subscriptionId: "sub_InvOff01", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  const id = club.product.id;
  await addOption(OWNER, id, "Basic", "19");
  await addOption(OWNER, id, "Plus", "39");
  let store = (await storeForEmail(OWNER))!;
  const [basic, plus] = (await readProduct(store, id))!.options.map((o) => o.id);
  await setProductLink(OWNER, basic, "https://example.com/basic");
  await setProductLink(OWNER, plus, "https://example.com/plus");
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;

  // Imported on "Basic" from another platform (lib/imports.ts writes the option on the invitation).
  const renews = nowS + 20 * DAY;
  const [adaField, benField] = await inviteMembers(store, "job_inviteoffsale", [
    { email: "ada@example.com", productId: id, option: basic, renews },
    { email: "ben@example.com", productId: id, option: basic, renews },
  ]);
  if (!adaField || !benField) throw new Error("not invited");
  const ada = (await readInvite(statsId, adaField))!;
  const ben = (await readInvite(statsId, benField))!;

  part("The creator takes Basic off sale (Revisor 1's case)");
  is("Basic is off sale where the store keeps it", takeOffSale(basic) > 0, true);
  store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, id))!;
  is("for everyone else, Basic is not offered", [namedPriceOffered(product, basic), sellableOptions(product).map((o) => o.id)], [false, [plus]]);

  part("The invited member keeps the price they had");
  const before = checkouts.length;
  const opened = await openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("their link opens a checkout", opened.ok ? "opened" : opened.reason, "opened");
  is("at Basic, by the id the invitation recorded, at Basic's price", [checkouts.length - before, checkouts.at(-1)?.get("metadata[option]"), checkouts.at(-1)?.get("line_items[0][price_data][unit_amount]")], [1, basic, "1900"]);
  is("their email names Basic's price", (await inviteEmail(store, benField))?.text.includes("$19") ?? false, true);
  const pageHtml = await movePage("inviteoffsale", id, { k: ben.t });
  is("their page shows the button and the price, not \"unavailable\"", [pageHtml.includes("$19"), pageHtml.includes(moveWords("en").notices.unavailable.title.replace(/'/g, "&#x27;"))], [true, false]);

  part("Nobody else gets it");
  const newLink = await createCheckout(store, product, "https://marktmorgen.com", basic, { digitalConsent: TEST_CONSENT }).then(() => "opened", (error: unknown) => (error as Error).message);
  is("a new checkout naming Basic is still refused, before Stripe", newLink, "This product needs one of its options");
  is("priceWords for the product as it is still refuses it (no invitation)", priceWords(store, product, basic), null);
  is("the gift and group picker still leaves it out", givableOptions({ ...product, recurring: null } as never).map((o) => o.id), [plus]);
  await noteKept(store, "ada@example.com", id);
  const keptAgain = await openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("an invitation already kept does not reopen the price off sale: it says it was moved (\"done\", Revisor 1 on #2685)", keptAgain.ok ? "opened" : keptAgain.reason, "done");

  part("An invitation whose \"kept\" cannot be read is not taken as unused (Codex C2 on #2685)");
  const benRecord = JSON.parse(redis.run(["HGET", `nl:mv:${statsId}`, benField]) as string) as Record<string, unknown>;
  for (const odd of ["yes", {}, [], null, -1, 1.5]) {
    redis.run(["HSET", `nl:mv:${statsId}`, benField, JSON.stringify({ ...benRecord, kept: odd })]);
    const before = checkouts.length;
    const tried = await openMove(store, id, ben.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
    is(`kept ${JSON.stringify(odd)}: the price off sale is not opened`, [tried.ok, checkouts.length - before], [false, 0]);
  }
  redis.run(["HSET", `nl:mv:${statsId}`, benField, JSON.stringify(benRecord)]);

  part("Such an invitation is never said to be moved: its state is said to be unknown (Claude 4's MÉDIO on #2685)");
  redis.run(["HSET", `nl:mv:${statsId}`, benField, JSON.stringify({ ...benRecord, kept: "x" })]);
  const unknownBefore = checkouts.length;
  const unread = await openMove(store, id, ben.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("pressing it opens nothing and answers \"unknown\", never \"done\"", [unread.ok ? "opened" : unread.reason, checkouts.length - unknownBefore], ["unknown", 0]);
  const notices = (language: Parameters<typeof moveWords>[0]) => moveWords(language).notices as Record<string, { title: string; body: string } | undefined>;
  const html = (text: string) => text.replace(/'/g, "&#x27;");
  const unknownNotice = notices("en").unknown;
  for (const query of [{ k: ben.t }, { k: ben.t, status: "unknown" }, { k: ben.t, status: "done" }] as Record<string, string>[]) {
    const unreadPage = await movePage("inviteoffsale", id, query);
    is(
      `its page (${JSON.stringify(query.status ?? "")}) says the state could not be checked, never that it was moved, with no button`,
      [
        Boolean(unknownNotice && unreadPage.includes(html(unknownNotice.title)) && unreadPage.includes(html(unknownNotice.body))),
        unreadPage.includes(html(moveWords("en").notices.done.title)),
        unreadPage.includes(html(moveWords("en").notices.done.body)),
        unreadPage.includes(moveWords("en").keep),
      ],
      [true, false, false, false],
    );
  }
  is("its notice says nothing was charged", unknownNotice?.body.includes("Nothing was charged") ?? false, true);
  for (const language of ["es", "fr", "de", "it", "nl", "pt"] as const) {
    const said = notices(language).unknown;
    is(`said in ${language} too, in its own words`, Boolean(said && said.title.length > 0 && said.body.length > 0 && said.title !== unknownNotice?.title), true);
  }
  redis.run(["HSET", `nl:mv:${statsId}`, benField, JSON.stringify(benRecord)]);

  part("Such an invitation is still the person's: copied and erased (Revisor 1 on #2685)");
  redis.run(["HSET", `nl:mv:${statsId}`, benField, JSON.stringify({ ...benRecord, kept: "x" })]);
  const odd = await readInvite(statsId, benField);
  is("it is read, with its state said to be unknown and taken as used", [odd?.e, odd?.keptUnknown, (odd?.kept ?? 0) !== 0], ["ben@example.com", true, true]);
  is("no email is written for it", await inviteEmail(store, benField), null);
  is("erasing the person deletes it, its link and its reminder", [await forgetInvitesPerson(store, [id], "ben@example.com"), redis.run(["HEXISTS", `nl:mv:${statsId}`, benField]), redis.run(["EXISTS", `nl:mv:link:${ben.t}`])], [1, 0, 0]);
  redis.run(["HSET", `nl:mv:${statsId}`, benField, JSON.stringify(benRecord)]);
  redis.run(["SET", `nl:mv:link:${ben.t}`, JSON.stringify({ s: statsId, f: benField }), "EX", 30 * DAY]);

  part("One invitation opens one checkout, however often it is pressed (Claude 4 on #2690)");
  const opens = checkouts.length;
  const [first, second] = await Promise.all([
    openMove(store, id, ben.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT),
    openMove(store, id, ben.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT),
  ]);
  const third = await openMove(store, id, ben.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("two at once and one after: Stripe is asked once", checkouts.length - opens, 1);
  const urls = [first, second, third].flatMap((o) => (o.ok ? [o.url] : []));
  is("whoever gets a page gets that same checkout", [urls.length >= 2, new Set(urls).size], [true, 1]);

  part("A paid moving-in checkout marks its invitation kept, though its member never came back to the page (Claude 4 on #2690)");
  const [cyField] = await inviteMembers(store, "job_inviteoffsale_cy", [{ email: "cy@example.com", productId: id, option: basic, renews }]);
  if (!cyField) throw new Error("cy not invited");
  swept = [{
    id: "cs_test_movedpaid000001", object: "checkout.session", status: "complete", payment_status: "no_payment_required", mode: "subscription",
    created: Math.floor(Date.now() / 1000) - 600, amount_total: 0, currency: "usd", customer_details: { email: "cy@example.com" },
    metadata: { store: "inviteoffsale", product: id, option: basic, moved: "yes", first_charge: String(renews) },
  }];
  await sweepCheckouts(Date.now() + 20_000);
  const cy = await readInvite(statsId, cyField);
  is("the invitation is kept, so its link opens no second membership", (cy?.kept ?? 0) > 0, true);
  swept = [];

  part("A kept invitation opens nothing more, at any price (Revisor 1 on #2685)");
  const [deeField] = await inviteMembers(store, "job_inviteoffsale_dee", [{ email: "dee@example.com", productId: id, option: plus, renews }]);
  if (!deeField) throw new Error("dee not invited");
  const dee = (await readInvite(statsId, deeField))!;
  const deeFirst = await openMove(store, id, dee.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("the first press opens a checkout at Plus", deeFirst.ok, true);
  await noteKept(store, "dee@example.com", id);
  redis.run(["DEL", `nl:mv:open:${statsId}:${deeField}`]);
  const deeBefore = checkouts.length;
  const deeAgain = await openMove(store, id, dee.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("once kept, a day later, the link opens no second membership", [deeAgain.ok ? "opened" : deeAgain.reason, checkouts.length - deeBefore], ["done", 0]);
  const deePage = await movePage("inviteoffsale", id, { k: dee.t });
  is("its page says so, with no button to press", [deePage.includes(moveWords("en").notices.done.title), deePage.includes(moveWords("en").keep)], [true, false]);
  for (const language of ["es", "fr", "de", "it", "nl", "pt"] as const) is(`said in ${language} too`, moveWords(language).notices.done.title.length > 0, true);

  part("The rule itself");
  is("only the named option comes back on sale, nothing else changes", withInvitedOption(product, basic).options.map((o) => [o.id, o.offSale === true]), [[basic, false], [plus, false]]);
  is("an option on sale, an unknown id or none: the product unchanged", [withInvitedOption(product, plus) === product, withInvitedOption(product, "nope") === product, withInvitedOption(product, "") === product], [true, true, true]);
  is("one with nothing to hand over stays not offered", namedPriceOffered(withInvitedOption({ ...product, options: product.options.map((o) => (o.id === basic ? { ...o, link: null, file: null } : o)) }, basic), basic), false);
  done();
}

void main();
