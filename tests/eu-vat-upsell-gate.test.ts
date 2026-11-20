/**
 * EU VAT art. 9a (789 [IV1] unit 1, C; coordinator C5-20261120-2325-upsell-gate): the one-click offer after paying
 * (lib/upsell.ts) asks the same gate the card checkout asks (lib/eu-vat-gate.ts consumerGate), on the product offered,
 * with the order's own evidence: the billing country Stripe kept on the paid checkout (customer_details.address.country)
 * and the IP country of the request (x-vercel-ip-country).
 *
 * The parent checkout asked the gate only for its own lines, so a parent exempt by design (a live call or a package
 * of calls) let an EU buyer through, and a download offered after it was then charged in one click with no gate.
 * The offer is gated on its own supply, never on the parent's: refused in the EU and the UK, refused without the
 * billing country, refused when the IP and the billing country disagree (art. 24f, non-contradictory evidence), and
 * drawn and charged as before for a buyer outside them. Synthetic data only; nothing real is charged or sent.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import * as upsell from "@/lib/upsell";
import { funnelView, readUpsell, takeUpsell, newUpsellKey } from "@/lib/upsell";
import { readListing } from "@/lib/catalog";
import type { CallSetup } from "@/lib/call-setup";
import type { EuSupplyFields } from "@/lib/eu-vat-supply";
import type { Listing } from "@/lib/store";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_eu_vat_upsell_gate_only";
process.env.RESEND_API_KEY = "re_test_eu_vat_upsell_gate_only";

const OWNER = "baker@example.com";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestUpsell0001";
const NOW = Math.floor(Date.now() / 1000);

const charges: URLSearchParams[] = [];
const made: Record<string, unknown>[] = [];
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    charges.push(body);
    const pi = {
      id: `pi_test_${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: "succeeded",
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
    };
    made.push(pi);
    return answer(pi);
  }
  if (path === "/payment_intents" && method === "GET") {
    return answer({ object: "list", data: url.searchParams.get("customer") === "cus_TestBuyer01" ? made : [], has_more: false });
  }
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = made.find((pi) => pi.id === one[1]);
    return found ? answer(found) : answer({ error: { message: "no such payment" } }, 404);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid checkout of the front product, as Stripe reports it, with the billing country Stripe kept (or none). */
/** card: the paying card's country Stripe reports (payment_method.card.country); by default the address's, as most cards are. */
function paidCheckout(id: string, product: string, fingerprint: string, country: string | null, card: string | null = country): Record<string, unknown> {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer01",
    currency: "usd",
    metadata: { store: "harbor", product, upsell_key: fingerprint },
    customer_details: country === null ? { email: BUYER } : { email: BUYER, address: { country } },
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01", ...(card === null ? {} : { card: { country: card } }) } },
  };
}

const weekly: CallSetup = {
  kind: "weekly",
  minutes: 60,
  tz: "America/New_York",
  weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

type OfferGate = (target: Listing, members: ReadonlyMap<string, EuSupplyFields> | undefined, evidence: { headers: Headers; billing: unknown; card: unknown }) => boolean;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Sourdough Course", "49");
  const guide = await add("Starter Kit Guide", "29");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [{ id: "kit001", productId: guide, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  is("the funnel is accepted", saved.ok, true);
  const store = (await storeForEmail(OWNER))!;
  const origin = "https://marktmorgen.com";
  const browser = newUpsellKey();
  const frontListing = (await readListing(store, front))!;

  const ip = (country: string | null) => new Headers(country === null ? {} : { "x-vercel-ip-country": country });
  // The thanks page's call, with the order's billing country and the request's IP country (app/[handle]/thanks/page.tsx).
  const drawn = async (country: string | null, ipCountry: string | null, id: string, card: string | null = country) =>
    (await funnelView({
      store,
      session: id,
      product: frontListing,
      alsoOwned: [],
      eligible: true,
      created: NOW - 60,
      secret: browser.secret,
      upsellKey: browser.fingerprint,
      evidence: { headers: ip(ipCountry), billing: country ?? undefined, card: card ?? undefined },
    } as Parameters<typeof funnelView>[0])).offer;
  // The route's call, with the request's headers (app/api/store/upsell/route.ts).
  const take = async (id: string, ipCountry: string | null) =>
    takeUpsell({ store, session: id, secret: browser.secret, origin, step: await shownRef(store, "kit001"), answer: "yes", consent: TEST_CONSENT, headers: ip(ipCountry) } as Parameters<typeof takeUpsell>[0]);

  /** One buyer: the session Stripe kept, the page's offer, the yes, and whether anything was charged or written. */
  const buyer = async (id: string, country: string | null, ipCountry: string | null, card: string | null = country) => {
    sessions[id] = paidCheckout(id, front, browser.fingerprint, country, card);
    const before = charges.length;
    const offer = await drawn(country, ipCountry, id, card);
    const kind = (await take(id, ipCountry)).kind;
    return { drawn: offer !== null, kind, charged: charges.length - before, record: (await readUpsell(id, ""))?.state ?? null };
  };

  part("(a) RED: an EU buyer (address DE, IP DE) is never offered nor charged a download after paying");
  is("RED: no offer drawn, the yes is unavailable, no POST /payment_intents and nothing written", await buyer("cs_test_eugate0000000001", "DE", "DE"), {
    drawn: false,
    kind: "unavailable",
    charged: 0,
    record: null,
  });
  is("RED: the same for the United Kingdom (address GB, IP GB)", await buyer("cs_test_eugate0000000002", "GB", "GB"), { drawn: false, kind: "unavailable", charged: 0, record: null });

  part("(a2) RED: a no from the EU or the UK is refused the same, with nothing written (the funnel never moves on)");
  sessions.cs_test_eugate0000000019 = paidCheckout("cs_test_eugate0000000019", front, browser.fingerprint, "DE");
  const no = await takeUpsell({ store, session: "cs_test_eugate0000000019", secret: browser.secret, origin, step: await shownRef(store, "kit001"), answer: "no", headers: ip("DE") } as Parameters<typeof takeUpsell>[0]);
  is("RED: unavailable, and no declined record is written", [no.kind, (await readUpsell("cs_test_eugate0000000019", ""))?.state ?? null], ["unavailable", null]);

  part("(b) A buyer in the United States (address US, IP US) is offered and charged as before");
  is("drawn, taken, charged once and written paid", await buyer("cs_test_eugate0000000003", "US", "US"), { drawn: true, kind: "done", charged: 1, record: "paid" });
  is("charged the offer's own price", charges[charges.length - 1]?.get("amount"), "1900");

  part("(c) RED: a paid checkout with no billing country is offered nothing");
  is("RED: no offer, unavailable, nothing charged or written", await buyer("cs_test_eugate0000000004", null, "US"), { drawn: false, kind: "unavailable", charged: 0, record: null });

  part("(d) An EU or UK place in the IP country or the address is refused, whatever the other says");
  for (const [n, country, ipCountry] of [["5", "FR", "US"], ["6", "US", "FR"]] as const) {
    is(`RED: address ${country}, IP ${ipCountry}: no offer, unavailable, nothing charged`, await buyer(`cs_test_eugate000000000${n}`, country, ipCountry), {
      drawn: false,
      kind: "unavailable",
      charged: 0,
      record: null,
    });
  }

  part("(d2) RED, 790 [IV2] unit 2: the two items are the billing address and the paying card's country (arts. 24b, 24f)");
  // The owner's decision of 20/11/2026 (AGENTS.md, IV (i); docs/codex-queue.md, 790 [IV2] unit 2): the IP country is
  // no longer one of the two items; an EU or UK IP still refuses, as (d) shows, because consumerGate refuses any such place.
  is("RED: address US, IP CA, card US: offered and charged (the IP no longer has to match)", await buyer("cs_test_eugate0000000007", "US", "CA", "US"), { drawn: true, kind: "done", charged: 1, record: "paid" });
  for (const [n, country, card] of [["10", "US", "DE"], ["11", "US", "GB"], ["12", "US", "CA"], ["13", "CA", "US"]] as const) {
    is(`RED: address ${country}, IP ${country}, card ${card}: a contradiction, no offer, nothing charged`, await buyer(`cs_test_eugate00000000${n}`, country, country, card), {
      drawn: false,
      kind: "unavailable",
      charged: 0,
      record: null,
    });
  }
  is("RED: a card whose country Stripe did not give is no second item: no offer, nothing charged", await buyer("cs_test_eugate0000000014", "US", "US", null), {
    drawn: false,
    kind: "unavailable",
    charged: 0,
    record: null,
  });
  is("a lower-case card country reads as the same country", await buyer("cs_test_eugate0000000015", "US", "US", "us"), { drawn: true, kind: "done", charged: 1, record: "paid" });

  part("(f) Without the IP header (as the checkout reads it), a buyer with address US is offered and charged");
  is("drawn, taken, charged once", await buyer("cs_test_eugate0000000008", "US", null), { drawn: true, kind: "done", charged: 1, record: "paid" });
  is("and a lower-case Stripe country reads as the same country", await buyer("cs_test_eugate0000000009", "us", "US"), { drawn: true, kind: "done", charged: 1, record: "paid" });

  part("(e) RED: the gate itself, on the product offered (never the parent's exemption)");
  // A funnel cannot offer a live call or a package of calls today (lib/product-extras.ts canBeBumped needs call null,
  // and lib/bundle-rules.ts canBeInBundle refuses a call), so the exempt target is checked on the helper directly.
  const offerGate = (upsell as unknown as { offerGate?: OfferGate }).offerGate;
  is("RED: lib/upsell.ts exports offerGate", typeof offerGate, "function");
  if (offerGate) {
    const added = await addProduct(OWNER, "Coaching Call", "", "120", null);
    if (!added.ok) throw new Error("no call product");
    const callId = added.product.id;
    is("a weekly call is set", (await setProductCall(OWNER, callId, weekly)).ok, true);
    // Read from the store as it is now: the record read above was taken before the call was set.
    const call = (await readListing((await storeForEmail(OWNER))!, callId))!;
    const download = (await readListing(store, guide))!;
    const de = { headers: ip("DE"), billing: "DE", card: "DE" };
    is("a live call goes on for an EU buyer, as the checkout lets it", offerGate(call, undefined, de), true);
    is("and with no evidence at all, as consumerGate exempts it", offerGate(call, undefined, { headers: new Headers(), billing: undefined, card: undefined }), true);
    is("a download is refused for the same EU buyer", offerGate(download, undefined, de), false);
    is("a download for a US buyer goes on", offerGate(download, undefined, { headers: ip("US"), billing: "US", card: "US" }), true);
    is("a billing country that is not a string is no billing country", offerGate(download, undefined, { headers: ip("US"), billing: 840, card: "US" }), false);
    is("an alias that disagrees with the card is refused (UK vs GB), fail-closed", offerGate(download, undefined, { headers: new Headers(), billing: "UK", card: "GB" }), false);
    is("RED: a card country that is not a string is no card country", offerGate(download, undefined, { headers: ip("US"), billing: "US", card: 840 }), false);
    is("RED: a US address with an EU card is refused on the helper too", offerGate(download, undefined, { headers: ip("US"), billing: "US", card: "DE" }), false);
    const bundle = { ...download, id: "bundle1", bundle: [guide, front] } as Listing;
    const members = new Map<string, EuSupplyFields>([[guide, download], [front, frontListing]]);
    is("a bundle of downloads, read by its members, is refused for an EU buyer", offerGate(bundle, members, de), false);
    is("and goes on for a US buyer", offerGate(bundle, members, { headers: ip("US"), billing: "US", card: "US" }), true);
  }

  done();
}

void main();
