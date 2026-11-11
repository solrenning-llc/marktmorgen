import { startGift } from "@/lib/gifts";
import { OrdersPausedError } from "@/lib/order-admission";
import { startGroup } from "@/lib/group-buy";
import { preorderDay, soonOne } from "@/lib/preorders";
import { type NextRequest, after } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle, syncTakesBuyer } from "@/lib/store";
import { ReturningCodeRefused, canSellProduct, createCheckout } from "@/lib/store-checkout";
import { RETURNING_TRIES, RETURNING_TRIES_SECONDS, type ReturningCheck, checkReturningCode } from "@/lib/returning-code";
import { countHit } from "@/lib/visit";
import { releaseStockHold, withStockHold } from "@/lib/stock";
import { activePlan } from "@/lib/product-extras";
import { activeFunnel, funnelProductIds } from "@/lib/funnel";
import { affiliateCookieName, attributionFor } from "@/lib/affiliates";
import { viaCookieName } from "@/lib/affiliate-setting";
import { rememberPlan } from "@/lib/plans";
import { UPSELL_COOKIE, newUpsellKey } from "@/lib/upsell";
import { HOLD_SECONDS } from "@/lib/stripe-account";
import { BUYER_COOKIE, BUYER_COOKIE_SECONDS, newBuyerKey } from "@/lib/learn";
import { canWrite } from "@/lib/mail";
import { outOfKeys } from "@/lib/licence-keys";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { readListings, readProduct } from "@/lib/catalog";
import { bundleReady, chosenItems, deliverableItems, picks } from "@/lib/bundle-rules";
import { cameFrom } from "@/lib/came-from";
import { channelOfRequest } from "@/lib/visit-channel";
import { adsCheckout } from "@/lib/ad-events";
import { codeCookieName, readLinkCode } from "@/lib/code-link";
import { AB_COOKIE, abMeta, count as countTest, expectedShareB, readBucket, readCounts, versionFor, winner } from "@/lib/headline-test";
import { readPage } from "@/lib/sales-page-store";
import { readCountry } from "@/lib/fair-price";
import { pageShown, runningTest, declaredMeasure } from "@/lib/sales-page";
import { noteCheckoutTrouble } from "@/lib/checkout-trouble";
import { chargesOffAfterRefusal } from "@/lib/stripe-charges";
import { markFromReferer } from "@/lib/page-funnel";
import { funnelHere } from "@/lib/page-funnel-store";
import { listedReturn, listedSite } from "@/lib/embed-sites";
import { assistReminderOffered, keepAssistReminder } from "@/lib/assistant-reminder";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { type DigitalConsent, DigitalConsentMissing, consentFromForm, deliversDigitally } from "@/lib/digital-consent";

/** The checkout this browser last opened for a limited product. */
const HOLD_COOKIE = "nl_stock_hold";

/**
 * Starts a purchase.
 *
 * The buy button is a plain HTML form, so a store page sells with JavaScript
 * turned off. Nothing here trusts the price or the title the form sends: the
 * product is looked up by id in the store's own record, and the charge is
 * built from that. A form posted from anywhere else can name a product, but
 * never its price.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);

  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  const away = (path: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" },
    });

  let handle = "";
  let productId = "";
  let optionId = "";
  // The products whose boxes the buyer checked (lib/product-extras.ts).
  let bumps: string[] = [];
  // For a bundle the buyer builds: the products they ticked (lib/bundle-rules.ts).
  let picked: string[] = [];
  let plan = false;
  let yearly = false;
  let news = false;
  let clicks = false;
  // Bought for somebody else (lib/gifts.ts): who, from whom, and a message.
  let giftTo = "";
  let giftFrom = "";
  let giftMessage = "";
  // Bought for several people at once (lib/group-buy.ts): how many.
  let people = "";
  // The buyer pressed a pre-order's button (lib/preorders.ts).
  let wantsPreorder = false;
  // Opened by the checkout script on the creator's own site (lib/embed-sites.ts):
  // which site, and where to send the buyer back to. Checked against the
  // store's list below; never trusted as sent.
  let siteAsked = "";
  let returnAsked = "";
  // The Store assistant's box for one reminder if the buyer does not finish
  // (lib/assistant-reminder.ts): checked, the address typed beside it, and
  // the version of the sentence the page showed. Never inferred from anything else.
  let remind = false;
  let remindEmail = "";
  let remindVersion = "";
  // The box to start access at once, which loses the right to cancel once
  // it starts (lib/digital-consent.ts): only the checked box, with the
  // version of the sentence this code shows. Checked again where the charge
  // is built, so nothing digital is opened without it.
  let digitalConsent: DigitalConsent | null = null;
  // A code only for people who already bought here, and the email it is for
  // (lib/returning-code.ts): read only when a code was typed; never kept.
  let typedCode = "";
  let typedEmail = "";
  // The page the form was on, when it is not the product's own (renew, course): only those two words count.
  let from: "renew" | "course" | "" = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    digitalConsent = consentFromForm(form);
    const sentFrom = form.get("from");
    from = sentFrom === "renew" || sentFrom === "course" ? sentFrom : "";
    const h = form.get("handle");
    const p = form.get("product");
    // An id, and only an id. The amount that goes to Stripe is read from the
    // option the creator saved, never from this form.
    const o = form.get("option");
    handle = typeof h === "string" ? normaliseHandle(h) : "";
    productId = typeof p === "string" ? p : "";
    optionId = typeof o === "string" ? o : "";
    // Only a ticked box counts. What each addition costs is read from the store.
    picked = form.getAll("pick").filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)).slice(0, 21);
    bumps = form.getAll("bump").filter((value): value is string => typeof value === "string" && /^(yes|[a-z0-9]{6,40})$/.test(value)).slice(0, 4);
    // Paying in instalments only when the buyer picked it.
    plan = form.get("pay") === "plan";
    yearly = form.get("billing") === "year";
    // Only a box the buyer ticked, and only on a store that can write to them.
    news = form.get("news") === "yes";
    // Its own box, allowing their link use in sequences to be seen; only with the first (lib/mail-clicks.ts).
    clicks = news && form.get("clicks") === "yes";
    const read = (name: string, max: number) => {
      const value = form.get(name);
      return typeof value === "string" ? value.slice(0, max) : "";
    };
    giftTo = read("gift_to", 300);
    giftFrom = read("gift_from", 200);
    giftMessage = read("gift_message", 2_000);
    people = read("people", 12);
    wantsPreorder = form.get("preorder") === "yes";
    siteAsked = read("site", 300);
    returnAsked = read("return", 700);
    remind = form.get("remind") === "yes";
    remindEmail = remind ? normaliseEmail(read("remind_email", MAX_EMAIL_LENGTH + 1)) : "";
    remindVersion = remind ? read("remind_v", 40) : "";
    typedCode = read("rcode", 40).trim();
    typedEmail = typedCode ? read("remail", MAX_EMAIL_LENGTH + 1) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle || !productId) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });

  // In full: the checkout asks its questions and may be followed by offers.
  const product = await readProduct(store, productId);
  if (!product) return away(`/@${store.handle}`);

  // Each press opens a checkout on the creator's Stripe account and may hold
  // a limited unit for half an hour, so one connection gets twenty in ten
  // minutes per store: far past any buyer, and short of a script holding
  // every unit to keep real buyers out.
  if (!(await withinLimit("checkout", `${clientAddress(request)}|${store.handle}`, 20, 600))) {
    return away(`/@${store.handle}?status=slow`);
  }

  // Coming soon: its page takes a waitlist sign-up, and no checkout opens
  // (lib/waitlist.ts) — unless it takes pre-orders and that is what was
  // pressed (lib/preorders.ts). A pre-order is sold before there is anything
  // to hand over: it is handed over the day the product comes out.
  const coming = await soonOne(store, product.id).catch(() => null);
  if (!coming) return away(`/@${store.handle}?status=error`);
  const preorder = coming.soon && wantsPreorder && preorderDay(store, product, coming.soon, coming.day) !== null;
  if (coming.soon && !preorder) return away(`/@${store.handle}/p/${product.id}#waitlist`);
  // Refused here rather than at Stripe, so a buyer never reaches a card form
  // for something that could not have been delivered anyway.
  if (!preorder && !canSellProduct(store, product)) return away(`/@${store.handle}`);
  // A bundle that holds too little that can be handed over right now is not sold.
  if (product.bundle) {
    const pool = deliverableItems(product, await readListings(store, product.bundle));
    if (!bundleReady(product, pool.length)) return away(`/@${store.handle}`);
    // A bundle the buyer builds: exactly as many as it asks, from its list,
    // or back to its page to choose again.
    const pick = picks(product);
    if (pick && !chosenItems(pool, picked, pick)) return away(`/@${store.handle}/p/${product.id}?pick=count#buy`);
  }
  // A call is booked for a time on its own page, never bought without one.
  if (product.call) return away(`/@${store.handle}/book/${product.id}`);
  // Every license key in the pool is given: nobody is charged for one that
  // does not exist. The creator was emailed when the pool ran low. A count
  // that could not be read is unknown, never "some left": nothing opens and
  // the buyer is told plainly (SG2, finding 11).
  const noKeys = await outOfKeys(store, product).then(
    (out) => out,
    () => null,
  );
  if (noKeys === null) return away(`/@${store.handle}?status=error`);
  if (noKeys) return away(`/@${store.handle}?status=soldout`);

  // Asked before a gift or a group is written down, so a refused yes leaves
  // nothing behind; the charge itself checks again, with what was added.
  const consentBack = from
    ? `/@${store.handle}/${from}/${product.id}?consent=needed`
    : `/@${store.handle}/p/${product.id}?consent=needed${giftTo.trim() && !preorder ? "&gift=consent#gift" : people.trim() && !preorder ? "&group=consent#group" : preorder ? "#preorder" : "#buy"}`;
  if (!digitalConsent && deliversDigitally(product, optionId || null)) return away(consentBack);

  // A code only for people who already bought here (554 [DS1], unit 2):
  // checked before anything is written down or held, so a refused code
  // leaves nothing behind. The buyer goes back to the form with the reason;
  // nothing is charged, and they can still buy without it.
  let returning: Extract<ReturningCheck, { ok: true }> | null = null;
  const refusedCode = (reason: string) => away(`/@${store.handle}/p/${product.id}?returning=${reason}#returning`);
  if (typedCode) {
    // Each try reads what an email bought from the creator's Stripe account:
    // a few per connection, so nobody can try address after address.
    if (!(await withinLimit("returning-code", `${clientAddress(request)}|${store.handle}`, RETURNING_TRIES, RETURNING_TRIES_SECONDS))) return refusedCode("busy");
    const checked = await checkReturningCode(store, typedCode, typedEmail);
    if (!checked.ok) return refusedCode(checked.reason);
    returning = checked;
  }

  // A gift: written down before its checkout opens, and its checkout is one
  // plain payment with nothing added and no offer after it.
  let gift: string | undefined;
  if (giftTo.trim() && !preorder) {
    const started = await startGift(store, product, { to: giftTo, from: giftFrom, message: giftMessage }, optionId).catch(() => null);
    if (!started) return away(`/@${store.handle}?status=error`);
    if (!started.ok) return away(`/@${store.handle}/p/${product.id}?gift=${started.reason}#gift`);
    gift = started.gift.id;
  }

  // For several people: written down before its checkout opens, like a gift.
  // The number typed is checked here and never corrected: a buyer who typed
  // one that cannot be sold is told on the page, not charged for another.
  let group: { id: string; people: number } | undefined;
  if (!gift && !preorder && people.trim()) {
    const started = await startGroup(store, product, people, optionId).catch(() => null);
    if (!started) return away(`/@${store.handle}?status=error`);
    if (!started.ok) return away(`/@${store.handle}/p/${product.id}?group=${started.reason}#group`);
    group = { id: started.group.id, people: started.group.people };
  }

  // Opened from a step of a funnel of pages: carried to the thank-you page,
  // only for a funnel that is on and has this product as a step.
  const mark = markFromReferer(request.headers.get("referer"), new URL(origin).hostname);
  const funnel = mark ? ((await funnelHere(store, mark, "product", product.id).catch(() => null))?.funnel.id ?? null) : null;

  try {
    // A buyer who went back from Stripe's page hands back the unit they held
    // before holding another.
    const previous = request.cookies.get(HOLD_COOKIE)?.value ?? "";
    if (previous) await releaseStockHold(store, product, previous).catch(() => {});

    // When offers follow the payment, this browser gets a secret, and only
    // its fingerprint travels with the charge.
    const inPlan = !gift && !group && !preorder && plan && activePlan(product) !== null;
    const upsell = !gift && !group && !preorder && !inPlan && !store.tax.enabled && activeFunnel(await readListings(store, funnelProductIds(product.funnel)), product) ? newUpsellKey() : null;
    // Sent by an affiliate within the store's window: credited to them. A
    // lookup that fails never stops the sale; it is only not credited.
    const via = await attributionFor(store, product.id, {
      via: request.cookies.get(viaCookieName(store.handle))?.value,
      session: request.cookies.get(affiliateCookieName(store.handle))?.value,
    }).catch(() => null);
    // A course opens right away in the browser that paid for it.
    // So does a course in a bundle.
    const buyer = !gift && !group && !preorder && (product.course || product.bundle) ? newBuyerKey() : null;
    // A checkout opened from a page running a test — a second headline or a
    // second version of the whole page — is counted for the version this
    // visitor was shown, and carries it to Stripe, so a paid sale counts for
    // it too (lib/headline-test.ts). Read only for a product with a page, and
    // only for a visitor with a group.
    const bucket = readBucket(request.cookies.get(AB_COOKIE)?.value);
    let abTest = "";
    let ab: string | undefined;
    if (product.page && bucket !== null && !gift && !group) {
      // A page whose read is not known never blocks the sale, and no version is claimed for it: the buyer goes on to
      // Stripe with no metadata[ab], and the test counts nothing (C4-20261106-2610-C6-153, unit B;
      // tests/checkout-ab-page-unknown.test.ts).
      const page = await readPage(store.statsId, product.id).catch(() => null);
      const test = page ? runningTest(page) : null;
      if (page && test && pageShown(page)) {
        const counts = await readCounts(store.statsId, product.id, test).catch(() => null);
        if (counts && !winner(counts, product.priceCents > 0 ? "money" : "checkouts", { declared: declaredMeasure(page), shareB: expectedShareB(test) })) {
          abTest = test;
          ab = abMeta(test, versionFor(bucket, test));
        }
      }
    }
    const ads = await adsCheckout(request, store);
    // Only where the box was offered, for a purchase of the buyer's own, with an address that is one.
    const reminding = remind && !gift && !group && !preorder && remindEmail.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(remindEmail) && assistReminderOffered(store, product);
    const held = await withStockHold(store, product, (holding) =>
      createCheckout(store, product, linkOrigin(request, store), optionId, {
        bumps,
        picked,
        held: holding,
        upsellKey: upsell?.fingerprint,
        plan: inPlan,
        yearly,
        buyerKey: buyer?.fingerprint,
        // Kept only where the box was offered: the creator writes to their
        // list here, or sends this product's buyers to their email platform.
        news: news && (canWrite(store) || syncTakesBuyer(store, product.id)),
        remind: reminding,
        // Only where the creator writes to their list here: that is where it is counted.
        clicks: clicks && canWrite(store),
        via,
        gift,
        group,
        preorder,
        // Which of the creator's links this sale came from, read off the page
        // the button was pressed on (lib/came-from.ts). Nothing is stored and
        // nobody is identified: the tag rides to Stripe with the payment.
        cameFrom: cameFrom(request.headers.get("referer"), new URL(origin).hostname),
        // The channel this sale is credited to: the page's own tags, else the
        // one remembered for this visitor (lib/visit-channel.ts), else direct.
        // And, with the buyer's yes to ad measurement, where the request that
        // opened it is kept, so the purchase is sent to the creator's ad
        // platforms when it is paid (lib/ad-events.ts).
        channel: { ...channelOfRequest(request, store.handle, new URL(origin).hostname, Date.now() / 1000, store.attributionDays), ...ads },
        // A code that came in a link to this store (lib/code-link.ts), applied
        // by Stripe only if it is one of the creator's live codes.
        code: readLinkCode(request.cookies.get(codeCookieName(store.handle))?.value) || undefined,
        // Where the buyer's connection is, for a fair price for that country
        // (lib/fair-price.ts), the same header the page read to show it.
        country: readCountry(request.headers.get("x-vercel-ip-country")),
        // A funnel of pages this product is a step of, read off the page the
        // button was pressed on like the tags above (lib/page-funnel.ts).
        funnel: funnel ?? undefined,
        ab,
        embedSite: listedReturn(store.embedSites, returnAsked) ?? listedSite(store.embedSites, siteAsked) ?? undefined,
        digitalConsent,
        // Checked above against what this email bought here before: the
        // code's coupon, and the checkout opens for that email.
        ...(returning ? { returning: returning.code, email: returning.email } : {}),
      }),
    );
    if (!held.ok) return away(`/@${store.handle}?status=${held.reason}`);
    // Written down before the buyer leaves, so the plan — or a membership that
    // ends after a set number of payments — is given its end whether or not
    // they come back from paying.
    const ends = inPlan || (product.recurring !== null && product.recurring.payments > 0);
    if (ends && store.stripeAccountId) await rememberPlan(store.stripeAccountId, held.value.id);
    // The buyer's yes, kept with the sentence, its version and the time, before they leave for Stripe.
    if (reminding) await keepAssistReminder({ store, session: held.value.id, email: remindEmail, version: remindVersion });
    // Counted once the buyer is on their way, so the count never slows them.
    after(() => countHit(request, store, { kind: "checkout", id: product.id }));
    if (abTest && bucket !== null) after(() => countTest(store.statsId, product.id, abTest, "c", versionFor(bucket, abTest)));
    const headers = new Headers({ Location: held.value.url, "Cache-Control": "no-store" });
    const secure = origin.startsWith("https://") ? "; Secure" : "";
    if (product.stock !== null) {
      headers.append("Set-Cookie", `${HOLD_COOKIE}=${held.value.id}; Path=/api/store/checkout; Max-Age=${HOLD_SECONDS}; HttpOnly; SameSite=Lax${secure}`);
    }
    if (upsell) {
      headers.append("Set-Cookie", `${UPSELL_COOKIE}=${upsell.secret}; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax${secure}`);
    }
    if (buyer) {
      headers.append("Set-Cookie", `${BUYER_COOKIE}=${buyer.secret}; Path=/api/store/course; Max-Age=${BUYER_COOKIE_SECONDS}; HttpOnly; SameSite=Lax${secure}`);
    }
    return new Response(null, { status: 303, headers });
  } catch (error) {
    // The store's orders for the month are reached (lib/order-admission.ts): said plainly, nothing charged.
    if (error instanceof OrdersPausedError) return away(`/@${store.handle}?status=${error.reason === "paused" ? "paused" : "error"}`);
    // The box was not checked, or the page was from before its words
    // changed: back to the form it belongs to, said beside the box. Refused
    // before Stripe is reached, so nothing is charged and no unit is held.
    if (error instanceof DigitalConsentMissing) return away(consentBack);
    // The code's coupon is used up or gone on the creator's account: said on the form, never a checkout at the full price.
    if (error instanceof ReturningCodeRefused) return refusedCode("code");
    console.error("checkout failed", error);
    // A checkout Stripe would not open: counted, and the creator told (lib/checkout-trouble.ts).
    after(() => noteCheckoutTrouble(store, error).catch(() => {}));
    // Stripe says the account cannot take card payments: written down, and said, since trying again will not help.
    if (await chargesOffAfterRefusal(store, error)) return away(`/@${store.handle}?status=nocharges`);
    return away(`/@${store.handle}?status=error`);
  }
}
