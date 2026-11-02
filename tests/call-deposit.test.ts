/**
 * A deposit on an in-person booking (520 [LB1], unit 5a; lib/call-deposit.ts,
 * lib/call-setup.ts, lib/calls.ts callCheckoutBody; added 2 November 2026).
 * Checked:
 *
 *   - a deposit is read only in person, at least the smallest charge in the
 *     store's currency and less than the price; none is none;
 *   - the setup keeps it only in person, and refuses one on a call or one
 *     that is not a whole amount;
 *   - Stripe is sent only the deposit, with the sentence saying what is left
 *     to pay in person on its own page, and the deposit and the rest on the
 *     sale; with no deposit, or one that is no longer less than the price, or
 *     on a call, or for a session from a package, the whole price as before;
 *   - the studio's save refuses a deposit until the pages say what is left.
 */
import { readFileSync } from "node:fs";
import { chargeNow, parseDeposit } from "@/lib/call-deposit";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { callCheckoutBody } from "@/lib/calls";
import type { Product, Store } from "@/lib/store";
import { done, is, part } from "./check";

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const base = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1 };

const plain0 = () => readSetup({ ...base, place: ["Bela Studio"] }) as CallSetup;

async function main(): Promise<void> {
  part("The rule");
  const usd = { priceCents: 8000, currency: "usd" as const, inPerson: true };
  is("a deposit in person, between the smallest charge and the price", [parseDeposit(2000, usd), parseDeposit(50, usd)], [{ ok: true, cents: 2000 }, { ok: true, cents: 50 }]);
  is("none is none", [parseDeposit(undefined, usd), parseDeposit(null, usd), parseDeposit(0, usd)], Array(3).fill({ ok: true, cents: null }));
  is("a number only, as the setup keeps it: never a string", [parseDeposit("2000", usd), parseDeposit("", usd), readSetup({ ...base, place: ["Bela Studio"], deposit: "" })], [{ ok: false, why: "shape" }, { ok: false, why: "shape" }, "deposit"]);
  is("refused: below the smallest charge, the whole price or more, on a call, or not a whole amount", [parseDeposit(49, usd), parseDeposit(8000, usd), parseDeposit(9000, usd), parseDeposit(2000, { ...usd, inPerson: false }), parseDeposit(20.5, usd), parseDeposit(-5, usd), parseDeposit("20.00", usd)], [{ ok: false, why: "small" }, { ok: false, why: "whole" }, { ok: false, why: "whole" }, { ok: false, why: "online" }, { ok: false, why: "shape" }, { ok: false, why: "shape" }, { ok: false, why: "shape" }]);
  is("in another currency, its own smallest charge", [parseDeposit(500, { priceCents: 50_000, currency: "sek", inPerson: true }), parseDeposit(1000, { priceCents: 50_000, currency: "sek", inPerson: true })], [{ ok: false, why: "small" }, { ok: true, cents: 1000 }]);
  is("what is paid now and what is left", [chargeNow({ ...usd, deposit: 2000 }), chargeNow({ ...usd, deposit: null }), chargeNow({ ...usd, priceCents: 1500, deposit: 2000 }), chargeNow({ ...usd, inPerson: false, deposit: 2000 })], [{ cents: 2000, rest: 6000 }, { cents: 8000, rest: 0 }, { cents: 1500, rest: 0 }, { cents: 8000, rest: 0 }]);

  part("The setup");
  const kept = readSetup({ ...base, place: ["Bela Studio"], deposit: 2000 }) as CallSetup;
  is("kept in person", kept.deposit, 2000);
  is("refused on a call, or not a whole amount; none is no field", [readSetup({ ...base, room: "https://example.com/r", deposit: 2000 }), readSetup({ ...base, place: ["Bela Studio"], deposit: 20.5 }), readSetup({ ...base, place: ["Bela Studio"], deposit: "2000" }), "deposit" in (readSetup({ ...base, place: ["Bela Studio"] }) as CallSetup)], ["deposit", "deposit", "deposit", false]);

  part("What Stripe is sent");
  const store = { handle: "bela", name: "Bela Studio", language: "en", currency: "usd", hasDiscounts: false, tax: { enabled: false, included: false, ids: false, invoices: false } } as unknown as Store;
  const product = (call: CallSetup, priceCents = 8000) => ({ id: "p1", title: "Haircut", summary: "A cut and a wash.", priceCents, call, fields: [] }) as unknown as Product;
  const start = Math.floor((Date.now() + 5 * 86_400_000) / 60_000) * 60_000;
  const body = (p: Product, pkg: { id: string; coupon: string; email: string; back: string } | null = null) => callCheckoutBody({ store, product: p, start, end: start + 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", via: null, fromPackage: pkg });
  const sent = body(product(kept));
  is("only the deposit, with the creator's summary and what is left said on Stripe's page, and both kept on the sale", [sent.get("line_items[0][price_data][unit_amount]"), sent.get("line_items[0][price_data][product_data][description]"), sent.get("metadata[deposit]"), sent.get("metadata[rest]"), sent.get("payment_intent_data[metadata][rest]")], ["2000", "A cut and a wash. \u2014 A deposit to hold your time. The rest, $60, is paid in person to Bela Studio.", "2000", "6000", "6000"]);
  const long = body({ ...product(kept), summary: "x".repeat(600) } as unknown as Product).get("line_items[0][price_data][product_data][description]") ?? "";
  is("a long summary is cut so the sentence stays whole, within Stripe's 500 characters", [long.length <= 500, long.endsWith("is paid in person to Bela Studio.")], [true, true]);
  const coded = callCheckoutBody({ store: { ...store, hasDiscounts: true } as Store, product: product(kept), start, end: start + 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", via: null, fromPackage: null });
  const codedWhole = callCheckoutBody({ store: { ...store, hasDiscounts: true } as Store, product: product(plain0()), start, end: start + 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", via: null, fromPackage: null });
  is("no code box with a deposit, which a code would come off alone; the box as before without one", [coded.get("allow_promotion_codes"), codedWhole.get("allow_promotion_codes")], [null, "true"]);
  const plain = readSetup({ ...base, place: ["Bela Studio"] }) as CallSetup;
  is("with no deposit, the whole price and the creator's own summary, as before", [body(product(plain)).get("line_items[0][price_data][unit_amount]"), body(product(plain)).get("line_items[0][price_data][product_data][description]"), body(product(plain)).get("metadata[rest]")], ["8000", "A cut and a wash.", null]);
  is("a price now at or below the deposit: the whole price, nothing left", [body(product(kept, 1500)).get("line_items[0][price_data][unit_amount]"), body(product(kept, 1500)).get("metadata[rest]")], ["1500", null]);
  is("a deposit left on a setup that is no longer in person: the whole price", body(product({ ...kept, place: undefined } as unknown as CallSetup)).get("line_items[0][price_data][unit_amount]"), "8000");
  const fromPackage = body(product(kept), { id: "pkg1", coupon: "cpn_x", email: "ana@example.com", back: "https://marktmorgen.com/x" });
  is("a session from a package: the price, covered by its coupon, never a deposit", [fromPackage.get("line_items[0][price_data][unit_amount]"), fromPackage.get("discounts[0][coupon]"), fromPackage.get("metadata[rest]")], ["8000", "cpn_x", null]);

  part("When the store changes currency");
  const { chargesBelow } = await import("@/lib/store");
  is("a deposit below the new currency's smallest charge is said, never quietly turned into the whole price", chargesBelow([{ ...product({ ...kept, deposit: 500 }), options: [], bumps: [], funnel: null, plan: null, pwyw: null } as unknown as Product, { ...product(kept), options: [], bumps: [], funnel: null, plan: null, pwyw: null } as unknown as Product], "sek").map((s) => [s.what, s.amount]), [["deposit", 500]]);

  part("Not offered yet");
  is("the studio's save refuses a deposit until the pages say what is left (unit 5b)", readFileSync("app/api/store/call/route.ts", "utf8").includes('if (setup.deposit) return Response.json({ ok: false, error: "deposit" }, { status: 400 });'), true);

  done();
}

void main();
