/**
 * Sweep app-6 proof: components/store-cart.tsx:155-175. The cart panel reads
 * GET /api/store/cart again whenever its items change; when that read fails
 * (an { ok: false } answer, a non-JSON 5xx page or a dropped connection) the
 * `.then` returns on `!data.ok` and `.catch(() => {})` swallows the rest, so
 * the total, the deal row and the shipping row from the previous read stay on
 * screen. After the buyer removes a product, the list hides it (`shown` is
 * filtered by the ids) but "Total" and the button "Check out · $…" still carry
 * the removed product's price, with no notice. Stripe charges the server's
 * figure, so no money moves wrongly; the buyer is shown a false amount.
 *
 * A check named "DEFECT" passes while the defect is present.
 */
import { CartButton } from "@/components/store-cart";
import { cartWords } from "@/lib/buyer-words/cart";
import { find, mount, texts } from "./sweep-app6-hooks";
import { done, is, part } from "./check";

const c = cartWords("en");
const stored = new Map<string, string>();
const win = Object.assign(new EventTarget(), {
  localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) },
  location: { href: "https://marktmorgen.com/@sweepshop" },
  history: { state: null, replaceState() {} },
});
(globalThis as Record<string, unknown>).window = win;

const line = (id: string, price: string) => ({ id, title: `Product ${id}`, href: `/@sweepshop/p/${id}`, price, ok: true });
const both = { ok: true, items: [line("a", "$10.00"), line("b", "$20.00")], total: "$27.00", deal: { percent: 10, saved: "$3.00" }, next: null, suggest: [], bundle: null, shipping: null, apart: null, digital: true };
const onlyA = { ok: true, items: [line("a", "$10.00")], total: "$10.00", deal: null, next: { more: 1, percent: 10 }, suggest: [], bundle: null, shipping: null, apart: null, digital: true };

async function cartAfterRemovingB(second: () => Promise<Response>) {
  stored.set("mm-cart:sweepshop", JSON.stringify(["a", "b"]));
  let reads = 0;
  globalThis.fetch = (async () => (++reads === 1 ? new Response(JSON.stringify(both), { status: 200 }) : second())) as typeof fetch;
  const cart = await mount(CartButton, { handle: "sweepshop", lang: "en" as const, notice: null, restore: [] });
  const opener = find(cart.tree(), (n) => n.type === "button" && n.props?.["aria-expanded"] === false)[0];
  (opener.props!.onClick as () => void)();
  await cart.settle();
  const before = texts(cart.tree()).join(" | ");
  const remove = find(cart.tree(), (n) => n.type === "button" && n.props?.["aria-label"] === c.remove("Product b"))[0];
  (remove.props!.onClick as () => void)();
  await cart.settle();
  const after = texts(cart.tree()).join(" | ");
  const alerts = find(cart.tree(), (n) => n.props?.role === "alert").length;
  cart.unmount();
  return { reads, before, after, alerts };
}

async function main() {
  part("Healthy control: the second read answers (200, ok: true, only A)");
  const good = await cartAfterRemovingB(async () => new Response(JSON.stringify(onlyA), { status: 200 }));
  is("first panel shows both and the $27.00 total", good.before.includes(c.checkout("$27.00")) && good.before.includes("Product b"), true);
  is("cart read again after the removal", good.reads, 2);
  is("total and button say $10.00", good.after.includes(c.checkout("$10.00")) && !good.after.includes("$27.00"), true);
  is("deal row gone", good.after.includes(c.dealRow(10)), false);

  for (const [label, answer] of [
    ["{ ok: false } answer", async () => new Response(JSON.stringify({ ok: false }), { status: 503 })],
    ["503 non-JSON page", async () => new Response("<html>unavailable</html>", { status: 503 })],
    ["connection dropped", async () => { throw new TypeError("Failed to fetch"); }],
  ] as const) {
    part(`Defect: the second read fails (${label})`);
    const bad = await cartAfterRemovingB(answer);
    is("cart read again after the removal", bad.reads, 2);
    is("Product b no longer listed", bad.after.includes("Product b"), false);
    is("DEFECT: button still says \"Check out · $27.00\" (A alone is $10.00)", bad.after.includes(c.checkout("$27.00")), true);
    is("DEFECT: \"10% off for buying more\" still shown for one product", bad.after.includes(c.dealRow(10)), true);
    is("DEFECT: no alert that the prices could not be checked", bad.alerts, 0);
  }
  done();
}
void main();
