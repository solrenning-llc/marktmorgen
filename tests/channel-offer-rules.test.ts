/**
 * 760 [STN7], units 1 and 2, as rules: a discount that belongs to one post or one AutoDM, applied only through that
 * channel's own link, and sales added up per coupon. On Stan a coupon is a percentage anyone can type. Here a channel
 * offer is never a code to type: the checkout unit applies it as a Stripe coupon with no promotion code, only when the
 * visit carries the channel's own link tag, so a code shared elsewhere cannot take it.
 */
import * as offerModule from "@/lib/channel-offer-rules";
import { done, is, part } from "./check";

const m = offerModule as unknown as Record<string, unknown>;
type Offer = { id: string; channel: { kind: "post" | "autodm"; id: string }; off: unknown; product: string | null; endsAt: number | null; maxUses: number | null };
const readChannelOffer = m.readChannelOffer as (input: unknown, currency: string, products: readonly { id: string }[]) => { ok: true; offer: Offer } | { ok: false; reason: string };
const channelTag = m.channelTag as (channel: { kind: string; id: string }) => { name: string; value: string } | null;
const offerForVisit = m.offerForVisit as (input: Record<string, unknown>) => Offer | null;
const couponSalesReport = m.couponSalesReport as (rows: unknown) => { partial: boolean; lines: { key: string; orders: number; gross: Record<string, number>; refunded: Record<string, number> }[] };

const PRODUCTS = [{ id: "p1a2b3c4" }, { id: "k9x8y7z6" }];
const base = { id: "offer1abc", channel: { kind: "autodm", id: "rule42abc" }, kind: "percent", percent: "20" };

part("A channel offer is read whole");
is("a percent off one AutoDM, on any product, with no end and no cap", readChannelOffer(base, "usd", PRODUCTS), {
  ok: true,
  offer: { id: "offer1abc", channel: { kind: "autodm", id: "rule42abc" }, off: { kind: "percent", percent: 20 }, product: null, endsAt: null, maxUses: null },
});
is("an amount off one post's product, ending, capped", readChannelOffer({ ...base, channel: { kind: "post", id: "17890012345" }, kind: "amount", amount: "7.50", product: "k9x8y7z6", endsAt: 2_000_000_000, maxUses: "50" }, "usd", PRODUCTS), {
  ok: true,
  offer: { id: "offer1abc", channel: { kind: "post", id: "17890012345" }, off: { kind: "amount", cents: 750, currency: "usd" }, product: "k9x8y7z6", endsAt: 2_000_000_000, maxUses: 50 },
});
for (const [what, over, reason] of [
  ["a bad offer id", { id: "x" }, "id"],
  ["no channel", { channel: null }, "channel"],
  ["a channel of another kind", { channel: { kind: "email", id: "rule42abc" } }, "channel"],
  ["an AutoDM id that is no rule id", { channel: { kind: "autodm", id: "Rule 42" } }, "channel"],
  ["a percent of 0", { percent: "0" }, "percent"],
  ["a percent above 100", { percent: "101" }, "percent"],
  ["a fractional percent", { percent: "12.5" }, "percent"],
  ["an amount of nothing", { kind: "amount", amount: "0" }, "amount"],
  ["a product not sold now", { product: "gone1234" }, "product"],
  ["an end that is no time", { endsAt: "soon" }, "ends"],
  ["a cap of 0 uses", { maxUses: "0" }, "uses"],
] as const) {
  const got = readChannelOffer({ ...base, ...over }, "usd", PRODUCTS);
  is(`${what} is refused`, got.ok ? null : got.reason, reason);
}

part("Each channel's own link tag");
is("an AutoDM uses the tag AutoDM already adds", channelTag({ kind: "autodm", id: "rule42abc" }), { name: "mm_dm", value: "rule42abc" });
is("a post has its own", channelTag({ kind: "post", id: "17890012345" }), { name: "mm_post", value: "17890012345" });
is("anything else has none", [channelTag({ kind: "email", id: "x" }), channelTag({ kind: "post", id: "a b" })], [null, null]);

const read = readChannelOffer({ ...base, product: "p1a2b3c4", endsAt: 2_000, maxUses: "3" }, "usd", PRODUCTS);
if (read.ok) {
  const offer = read.offer;
  const visit = (over: Record<string, unknown>) => offerForVisit({ offers: [offer], tag: { name: "mm_dm", value: "rule42abc" }, product: "p1a2b3c4", nowSeconds: 1_000, used: { offer1abc: 0 }, ...over });
  part("An offer reaches only a visit through its own channel");
  is("its own link, its product, in time, under the cap", visit({}), offer);
  is("no tag: nothing", visit({ tag: null }), null);
  is("another rule's tag: nothing", visit({ tag: { name: "mm_dm", value: "rule99zzz" } }), null);
  is("the same id under a post's tag: nothing", visit({ tag: { name: "mm_post", value: "rule42abc" } }), null);
  is("another product: nothing", visit({ product: "k9x8y7z6" }), null);
  is("at its end: nothing", visit({ nowSeconds: 2_000 }), null);
  is("the cap reached: nothing", visit({ used: { offer1abc: 3 } }), null);
  is("a count that is not known is never zero: nothing", [visit({ used: {} }), visit({ used: { offer1abc: Number.NaN } }), visit({ used: null })], [null, null, null]);
  is("an unknown clock: nothing", visit({ nowSeconds: Number.NaN }), null);
}

part("Sales per coupon: whole orders, per currency, refunds apart");
const report = couponSalesReport([
  { key: "LAUNCH20", amountCents: 4_000, currency: "usd", refundedCents: 0 },
  { key: "LAUNCH20", amountCents: 4_000, currency: "usd", refundedCents: 4_000 },
  { key: "offer:offer1abc", amountCents: 3_000, currency: "eur", refundedCents: 500 },
  { key: "LAUNCH20", amountCents: 2_500, currency: "eur", refundedCents: 0 },
]);
is("complete when every row reads", report.partial, false);
is("one line per coupon, the most orders first", report.lines, [
  { key: "LAUNCH20", orders: 3, gross: { eur: 2_500, usd: 8_000 }, refunded: { usd: 4_000 } },
  { key: "offer:offer1abc", orders: 1, gross: { eur: 3_000 }, refunded: { eur: 500 } },
]);
const broken = couponSalesReport([
  { key: "LAUNCH20", amountCents: 4_000, currency: "usd", refundedCents: 0 },
  { key: "LAUNCH20", amountCents: -1, currency: "usd", refundedCents: 0 },
  { key: "", amountCents: 100, currency: "usd", refundedCents: 0 },
  { key: "LAUNCH20", amountCents: 100, currency: "US Dollars", refundedCents: 0 },
  { key: "LAUNCH20", amountCents: 100, currency: "usd", refundedCents: 200 },
  null,
]);
is("a row that does not read makes the report partial, never a smaller whole", [broken.partial, broken.lines], [true, [{ key: "LAUNCH20", orders: 1, gross: { usd: 4_000 }, refunded: {} }]]);
is("a list that is not one is partial and empty", couponSalesReport("nope"), { partial: true, lines: [] });

done();
