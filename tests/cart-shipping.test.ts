/**
 * Physical products in the cart, the rules (513 [PF1], unit 1;
 * lib/cart-shipping.ts; added 1 November 2026, corrected the same day after
 * an independent review). Checked: digital only ships nothing; the address
 * countries are the ones every physical product shares, once each; shipping
 * is each product's own amount added together, with each amount kept;
 * when nothing is shared, the fewest products are named and taking them out
 * always leaves a cart that ships, the buyer's country preferred; a physical
 * product whose shipping cannot be read is refused, never taken as digital.
 */
import { cartShipping, type CartItem } from "@/lib/cart-shipping";
import { done, is, part } from "./check";

const digital = (id: string): CartItem => ({ id, title: `Guide ${id}`, physical: false, shipping: null });
const shipped = (id: string, countries: string[], cents = 500): CartItem => ({ id, title: `Box ${id}`, physical: true, shipping: { countries, cents } });

function main(): void {
  part("What ships, and where");
  is("digital only: nothing ships", cartShipping([digital("a"), digital("b")]), { kind: "none" });
  is("one physical with digital: its own countries and amount", cartShipping([digital("a"), shipped("b", ["US", "CA"], 700)]), { kind: "ships", countries: ["US", "CA"], cents: 700, each: [{ id: "b", cents: 700 }] });
  is("two physical: only the shared countries, once each, amounts added and kept", cartShipping([shipped("a", ["US", "CA", "GB", "US"], 500), shipped("b", ["GB", "US"], 300)]), { kind: "ships", countries: ["US", "GB"], cents: 800, each: [{ id: "a", cents: 500 }, { id: "b", cents: 300 }] });
  is("free shipping counts as nothing", (cartShipping([shipped("a", ["US"], 0), shipped("b", ["US"], 450)]) as { cents: number }).cents, 450);

  part("Unknown fails: refused, never taken as digital");
  is("physical with unreadable shipping", cartShipping([digital("x"), { id: "a", title: "Box a", physical: true, shipping: null }]), { kind: "unreadable", items: [{ id: "a", title: "Box a" }] });
  is("no country, a negative, a broken or an over-the-bound amount", ["none", "neg", "nan", "big"].map((k) => cartShipping([k === "none" ? shipped("a", []) : shipped("a", ["US"], k === "neg" ? -100 : k === "nan" ? Number.NaN : 100_001)]).kind), ["unreadable", "unreadable", "unreadable", "unreadable"]);

  part("When nothing is shared: the fewest named, the rest ship");
  const carts: CartItem[][] = [
    [shipped("a", ["US"]), shipped("b", ["US", "CA"]), shipped("c", ["DE"])],
    [shipped("a", ["US"]), shipped("b", ["US"]), shipped("c", ["CA"]), shipped("d", ["CA"]), shipped("e", ["DE"])],
    [shipped("a", ["US"]), shipped("b", ["US"]), shipped("c", ["DE"]), shipped("d", ["DE"])],
    [shipped("a", ["US", "DE"]), shipped("b", ["US"]), shipped("c", ["DE"])],
    [shipped("a", ["US"]), shipped("b", ["DE"]), shipped("c", ["FR"])],
    [digital("x"), shipped("a", ["US"]), shipped("c", ["DE"])],
  ];
  for (const [i, cart] of carts.entries()) {
    const answer = cartShipping(cart);
    if (answer.kind !== "apart") { is(`cart ${i}: nothing shared`, answer.kind, "apart"); continue; }
    const named = new Set(answer.apart.map((p) => p.id));
    const rest = cart.filter((item) => !named.has(item.id));
    const physical = cart.filter((item) => item.physical);
    const most = Math.max(...physical.flatMap((item) => item.shipping!.countries).map((code) => physical.filter((item) => item.shipping!.countries.includes(code)).length));
    is(`cart ${i}: taking out the named ones leaves a cart that ships, and they are the fewest`, [cartShipping(rest).kind, answer.apart.length, answer.apart.some((p) => p.id === "x")], ["ships", physical.length - most, false]);
  }
  is("the case the review found: a,b to US; c,d to CA; e to DE → take out c, d, e at once", (cartShipping(carts[1]) as { apart: { id: string }[] }).apart.map((p) => p.id), ["c", "d", "e"]);
  is("the buyer's country is kept when it is one of the best", [(cartShipping(carts[2], "DE") as { to: string; apart: { id: string }[] }).to, (cartShipping(carts[2], "DE") as { apart: { id: string }[] }).apart.map((p) => p.id)], ["DE", ["a", "b"]]);
}

main();
done();
