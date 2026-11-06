/**
 * components/store-cart.tsx: the cart panel reads GET /api/store/cart again
 * whenever its items change. When that read fails (an { ok: false } answer, a
 * non-JSON 5xx page or a dropped connection), the figures from the previous
 * read must not stay on screen as if they were current: no old total on the
 * "Check out" button, no old deal or shipping row, and an alert says the
 * prices could not be checked. Stripe charges the server's figure, so the
 * button still checks out; it just carries no amount it cannot vouch for.
 *
 * The scenario is Claude 5's sweep app-6 proof (tests/sweep-app6-cart.proof.test.ts
 * on claude5/sweep-app-6 @ b7e7a13d, docs/reviews/c5-sweep-app6.md), with its
 * "DEFECT" checks turned into what must hold. It runs the component's real
 * hooks through tests/sweep-app6-hooks.ts, copied from that branch unchanged.
 */
import { CartButton } from "@/components/store-cart";
import { CART_WORDS, cartWords } from "@/lib/buyer-words/cart";
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
const ship = { label: "Shipping", amount: "$5.00", where: "Ships to: United States", notTo: "" };
const both = { ok: true, items: [line("a", "$10.00"), line("b", "$20.00")], total: "$27.00", deal: { percent: 10, saved: "$3.00" }, next: null, suggest: [], bundle: null, shipping: null, apart: null, digital: true };
const bothShipped = { ...both, total: "$32.00", shipping: ship };
const bothNext = { ...both, deal: null, next: { more: 1, percent: 10 } };
const onlyA = { ok: true, items: [line("a", "$10.00")], total: "$10.00", deal: null, next: { more: 1, percent: 10 }, suggest: [], bundle: null, shipping: null, apart: null, digital: true };

type Tree = Parameters<typeof texts>[0];
const submit = (tree: Tree) => find(tree, (n) => n.type === "button" && n.props?.type === "submit");
const alertsOf = (tree: Tree) => find(tree, (n) => n.props?.role === "alert");

async function cartAfterRemovingB(second: () => Promise<Response>, first: object = both, third?: () => Promise<Response>) {
  stored.set("mm-cart:sweepshop", JSON.stringify(["a", "b"]));
  let reads = 0;
  globalThis.fetch = (async () => {
    reads += 1;
    if (reads === 1) return new Response(JSON.stringify(first), { status: 200 });
    if (reads === 2) return second();
    return third!();
  }) as typeof fetch;
  const cart = await mount(CartButton, { handle: "sweepshop", lang: "en" as const, notice: null, restore: [] });
  const opener = find(cart.tree(), (n) => n.type === "button" && n.props?.["aria-expanded"] === false)[0];
  (opener.props!.onClick as () => void)();
  await cart.settle();
  const before = texts(cart.tree()).join(" | ");
  const remove = find(cart.tree(), (n) => n.type === "button" && n.props?.["aria-label"] === c.remove("Product b"))[0];
  (remove.props!.onClick as () => void)();
  await cart.settle();
  const tree = cart.tree();
  const after = texts(tree).join(" | ");
  const button = submit(tree).map((n) => texts(n.props?.children).join(""));
  const alerts = alertsOf(tree).map((n) => texts(n.props?.children).join(""));
  let again: { after: string; button: string[]; alerts: number } | null = null;
  if (third) {
    const toggle = () => (find(cart.tree(), (n) => n.type === "button" && n.props?.["aria-expanded"] !== undefined)[0].props!.onClick as () => void)();
    toggle();
    await cart.settle();
    toggle();
    await cart.settle();
    const t = cart.tree();
    again = { after: texts(t).join(" | "), button: submit(t).map((n) => texts(n.props?.children).join("")), alerts: alertsOf(t).length };
  }
  cart.unmount();
  return { reads, before, after, button, alerts, again };
}

const failures = [
  ["{ ok: false } answer", async () => new Response(JSON.stringify({ ok: false }), { status: 503 })],
  ["503 non-JSON page", async () => new Response("<html>unavailable</html>", { status: 503 })],
  ["connection dropped", async () => { throw new TypeError("Failed to fetch"); }],
] as const;

async function main() {
  part("Healthy control: the second read answers (200, ok: true, only A)");
  const good = await cartAfterRemovingB(async () => new Response(JSON.stringify(onlyA), { status: 200 }));
  is("first panel shows both and the $27.00 total", good.before.includes(c.checkout("$27.00")) && good.before.includes("Product b"), true);
  is("cart read again after the removal", good.reads, 2);
  is("total and button say $10.00", good.after.includes(c.checkout("$10.00")) && !good.after.includes("$27.00"), true);
  is("button carries the amount", good.button, [c.checkout("$10.00")]);
  is("deal row gone", good.after.includes(c.dealRow(10)), false);
  is("no alert", good.alerts, []);

  for (const [label, answer] of failures) {
    part(`The second read fails (${label})`);
    const bad = await cartAfterRemovingB(answer);
    is("cart read again after the removal", bad.reads, 2);
    is("Product b no longer listed", bad.after.includes("Product b"), false);
    is("no old $27.00 anywhere (A alone is $10.00)", bad.after.includes("$27.00"), false);
    is("button says only \"Check out\", with no amount", bad.button, [c.checkoutUnpriced]);
    is("no old \"10% off for buying more\" for one product", bad.after.includes(c.dealRow(10)), false);
    is("no old \"−$3.00\" saving", bad.after.includes("$3.00"), false);
    is("one alert says the prices could not be checked", bad.alerts, [c.unchecked]);
  }

  part("The second read fails with a shipping row on screen");
  const shipped = await cartAfterRemovingB(failures[2][1], bothShipped);
  is("first panel shows the shipping amount and $32.00", shipped.before.includes("$5.00") && shipped.before.includes(c.checkout("$32.00")), true);
  is("no old $32.00 anywhere", shipped.after.includes("$32.00"), false);
  is("no old shipping amount", shipped.after.includes("$5.00"), false);
  is("button says only \"Check out\"", shipped.button, [c.checkoutUnpriced]);

  part("The second read fails with an \"add more\" row on screen");
  const nexted = await cartAfterRemovingB(failures[1][1], bothNext);
  is("first panel shows the \"add 1 more\" row", nexted.before.includes(c.dealNext(1, 10)), true);
  is("no old \"add 1 more\" row (it was about two products)", nexted.after.includes(c.dealNext(1, 10)), false);
  is("button says only \"Check out\"", nexted.button, [c.checkoutUnpriced]);

  part("A later read that answers puts the figures back");
  const back = await cartAfterRemovingB(failures[0][1], both, async () => new Response(JSON.stringify(onlyA), { status: 200 }));
  is("after the failure, no amount on the button", back.button, [c.checkoutUnpriced]);
  is("after closing and opening again, the button says $10.00", back.again?.button, [c.checkout("$10.00")]);
  is("and the alert is gone", back.again?.alerts, 0);

  part("The words exist in every language a store sells in");
  for (const [code, words] of Object.entries(CART_WORDS)) {
    is(`${code}: "Check out" with no amount is set`, words.checkoutUnpriced.trim().length > 0 && !words.checkoutUnpriced.includes("·"), true);
    is(`${code}: it is the priced button's own verb`, words.checkout("$1.00").startsWith(words.checkoutUnpriced), true);
    is(`${code}: the alert is a full sentence`, words.unchecked.trim().length > 20, true);
  }
  is("the seven languages say it differently", new Set(Object.values(CART_WORDS).map((w) => w.unchecked)).size, 7);
  done();
}
void main();
