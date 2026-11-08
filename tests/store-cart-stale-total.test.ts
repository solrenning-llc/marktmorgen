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
 *
 * Claude 5's review of PR #2978 (comment 6697431273) added four cases, rebuilt
 * here from her description: a product ADDED while the re-read fails must not
 * vanish from what is posted while the header still counts it; a re-read that
 * never answers must not keep the old total past a bounded wait; a FIRST read
 * that fails must not leave the panel on "Checking the prices…"; and the
 * buyer gets a "Try again" button that runs the read again. The wait is the
 * component's window.setTimeout, replaced here by a fake clock.
 */
import { CartButton } from "@/components/store-cart";
import { CART_WORDS, cartWords } from "@/lib/buyer-words/cart";
import { find, mount, texts } from "./sweep-app6-hooks";
import { done, is, part } from "./check";

const c = cartWords("en");
const stored = new Map<string, string>();
/** The fake clock: every window.setTimeout the cart starts, fired only when a check says so. */
const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
let timerIds = 0;
const win = Object.assign(new EventTarget(), {
  setTimeout: (fn: () => void, ms = 0) => {
    const timer = { fn, ms, id: ++timerIds, live: true };
    timers.push(timer);
    return timer.id;
  },
  clearTimeout: (id: number) => {
    const timer = timers.find((t) => t.id === id);
    if (timer) timer.live = false;
  },
  localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) },
  location: { href: "https://marktmorgen.com/@sweepshop" },
  history: { state: null, replaceState() {} },
});
(globalThis as Record<string, unknown>).window = win;
// The cart's Escape and focus-out listeners (main, AAA 2.1.1/2.4.11) need a document; no key or focus event is sent here.
(globalThis as Record<string, unknown>).document = { addEventListener() {}, removeEventListener() {}, activeElement: null };

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

type Answer = (init?: RequestInit) => Promise<Response>;
const answer = (body: object): Answer => async () => new Response(JSON.stringify(body), { status: 200 });
/** A read that never answers; like a real fetch it gives up when its signal is aborted, unless `deaf`. */
const hang = (deaf = false): Answer => (init) =>
  new Promise<Response>((_, reject) => {
    if (!deaf) init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
/** A read that answers only when the check says so. */
function later(): { read: Answer; give: (body: object) => void; drop: () => void } {
  let give: (r: Response) => void = () => {};
  let drop: (e: Error) => void = () => {};
  const promise = new Promise<Response>((resolve, reject) => ((give = resolve), (drop = reject)));
  return { read: () => promise, give: (body) => give(new Response(JSON.stringify(body), { status: 200 })), drop: () => drop(new TypeError("Failed to fetch")) };
}

// Words this review adds, read without assuming they exist yet (so a missing word is a failing check, not a crash).
const wordsOf = (w: unknown) => w as Record<string, unknown>;
const uncheckedSome = (n: number, w: unknown = c) => {
  const say = wordsOf(w).uncheckedSome;
  return typeof say === "function" ? (say as (n: number) => string)(n) : "<no uncheckedSome>";
};
const closedWord = (w: unknown = c) => {
  const say = wordsOf(w).storeClosed;
  return typeof say === "string" ? say : "<no storeClosed>";
};
const retryWord = (w: unknown = c) => {
  const say = wordsOf(w).retry;
  return typeof say === "string" ? say : "<no retry>";
};

const suggestC = { id: "c", title: "Product c", href: "/@sweepshop/p/c", price: "$5.00", why: "Picked to go with Product a", kind: "pick" };
const onlyAWithC = { ...onlyA, suggest: [suggestC] };
const aAndC = { ok: true, items: [line("a", "$10.00"), line("c", "$5.00")], total: "$15.00", deal: null, next: null, suggest: [], bundle: null, shipping: null, apart: null, digital: true };

/** What the open panel shows, read from the component's own tree. */
function view(tree: Tree) {
  const forms = find(tree, (n) => n.type === "form" && n.props?.["data-checkout"] !== undefined);
  return {
    text: texts(tree).join(" | "),
    button: submit(tree).map((n) => texts(n.props?.children).join("")),
    alerts: alertsOf(tree).map((n) => texts(n.props?.children).join("")),
    posted: forms.length === 0 ? null : find(forms, (n) => n.type === "input" && n.props?.name === "id").map((n) => n.props?.value),
    retry: find(tree, (n) => n.type === "button" && texts(n.props?.children).join("") === retryWord()),
    statuses: find(tree, (n) => n.props?.role === "status").map((n) => texts(n.props?.children).join("")),
  };
}

/** Opens a cart holding `start`; each read takes the next answer, the last one repeating. */
async function openCart(start: string[], answers: Answer[]) {
  stored.set("mm-cart:sweepshop", JSON.stringify(start));
  timers.length = 0;
  let reads = 0;
  globalThis.fetch = ((_: unknown, init?: RequestInit) => {
    const next = answers[Math.min(reads, answers.length - 1)];
    reads += 1;
    return next(init);
  }) as typeof fetch;
  const cart = await mount(CartButton, { handle: "sweepshop", lang: "en" as const, notice: null, restore: [] });
  (find(cart.tree(), (n) => n.type === "button" && n.props?.["aria-expanded"] === false)[0].props!.onClick as () => void)();
  await cart.settle();
  const press = async (test: Parameters<typeof find>[1]) => {
    const button = find(cart.tree(), test)[0];
    if (button) (button.props!.onClick as () => void)();
    await cart.settle();
    return Boolean(button);
  };
  return {
    reads: () => reads,
    view: () => view(cart.tree()),
    press,
    retry: () => press((n) => n.type === "button" && texts(n.props?.children).join("") === retryWord()),
    /** Fires every pending wait of a second or more, as the clock running out would. */
    waitOut: async () => {
      for (const t of timers.filter((t) => t.live && t.ms >= 1000)) {
        t.live = false;
        t.fn();
      }
      await cart.settle();
    },
    settle: () => cart.settle(),
    /** Closes the panel and opens it again with the cart's own button. */
    reopen: async () => {
      for (let i = 0; i < 2; i += 1) {
        (find(cart.tree(), (n) => n.type === "button" && n.props?.["aria-expanded"] !== undefined)[0].props!.onClick as () => void)();
        await cart.settle();
      }
    },
    unmount: () => cart.unmount(),
    /** Gives the panel a stand-in element and counts how often the cart puts the focus on it. */
    watchFocus: () => {
      const region = find(cart.tree(), (n) => n.props?.role === "region")[0];
      const ref = region?.props?.ref as { current: unknown } | undefined;
      const seen = { focus: 0 };
      if (ref) ref.current = { focus: () => (seen.focus += 1), contains: () => false };
      return seen;
    },
    /** Changes the cart from elsewhere on the page, as AddToCart does. */
    change: async (ids: string[]) => {
      stored.set("mm-cart:sweepshop", JSON.stringify(ids));
      win.dispatchEvent(new Event("mm-cart-changed"));
      await cart.settle();
    },
  };
}
const bounded = () => timers.some((t) => t.live && t.ms >= 1000 && t.ms <= 15_000);

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

  // ---- Claude 5's review of #2978, finding 1 (MÉDIO): a product added while the re-read fails ----
  for (const [label, fail] of failures) {
    part(`A product is added and the re-read fails (${label})`);
    const cart = await openCart(["a"], [answer(onlyAWithC), fail, answer(aAndC)]);
    is("first panel offers Product c", cart.view().text.includes("Product c"), true);
    is("the add button is there", await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === `${c.add}: Product c`), true);
    const v = cart.view();
    is("cart read again after the add", cart.reads(), 2);
    is("the header counts 2 products", v.text.includes(c.open(2)), true);
    is("no form posts fewer products than the header counts", v.posted === null || v.posted.join(",") === "a,c", true);
    is("no amount on any button", v.button.every((b) => !b.includes("$")), true);
    is("the buyer is told 1 product could not be checked", v.alerts, [uncheckedSome(1)]);
    is("a \"Try again\" button is offered", v.retry.length, 1);
    is("pressing it reads the cart again", (await cart.retry()) && cart.reads(), 3);
    const w = cart.view();
    is("then the form posts both products", w.posted, ["a", "c"]);
    is("and the button says $15.00", w.button, [c.checkout("$15.00")]);
    is("and no alert or retry button is left", [w.alerts, w.retry.length], [[], 0]);
    cart.unmount();
  }

  part("A product is added and the re-read has not answered yet");
  {
    const slow = later();
    const cart = await openCart(["a"], [answer(onlyAWithC), slow.read]);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === `${c.add}: Product c`);
    const v = cart.view();
    is("no form posts only Product a while the header counts 2", v.posted === null || v.posted.join(",") === "a,c", true);
    is("no old \"Check out · $10.00\" for a cart of two", v.button.includes(c.checkout("$10.00")), false);
    is("the panel says the prices are being checked", v.text.includes(c.loading), true);
    slow.give(aAndC);
    await cart.settle();
    is("once it answers, the form posts both", cart.view().posted, ["a", "c"]);
    is("and the button says $15.00", cart.view().button, [c.checkout("$15.00")]);
    cart.unmount();
  }

  // ---- Finding 2 (LEVE): a re-read that hangs ----
  for (const deaf of [false, true]) {
    part(`The re-read after a removal never answers${deaf ? " (and ignores the abort)" : ""}`);
    const cart = await openCart(["a", "b"], [answer(both), hang(deaf), answer(onlyA)]);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === c.remove("Product b"));
    is("the wait is bounded (between 1 and 15 seconds)", bounded(), true);
    await cart.waitOut();
    const v = cart.view();
    is("after the wait, no old $27.00 anywhere", v.text.includes("$27.00"), false);
    is("the button says only \"Check out\"", v.button, [c.checkoutUnpriced]);
    is("one alert says the prices could not be checked", v.alerts, [c.unchecked]);
    is("a \"Try again\" button is offered", v.retry.length, 1);
    is("pressing it reads the cart again", (await cart.retry()) && cart.reads(), 3);
    is("then the button says $10.00", cart.view().button, [c.checkout("$10.00")]);
    is("and no alert or retry button is left", [cart.view().alerts, cart.view().retry.length], [[], 0]);
    cart.unmount();
  }

  // ---- Finding 3 (LEVE): the very first read fails ----
  for (const [label, fail] of failures) {
    part(`The first read fails (${label})`);
    const cart = await openCart(["a"], [fail, answer(onlyA)]);
    const v = cart.view();
    is("not stuck on \"Checking the prices…\"", v.text.includes(c.loading), false);
    is("the alert says 1 product could not be checked", v.alerts, [uncheckedSome(1)]);
    is("nothing to pay is offered", [v.posted, v.button], [null, []]);
    is("a \"Try again\" button is offered", v.retry.length, 1);
    is("pressing it reads the cart again", (await cart.retry()) && cart.reads(), 2);
    const w = cart.view();
    is("then Product a is listed", w.text.includes("Product a"), true);
    is("and the button says $10.00", w.button, [c.checkout("$10.00")]);
    is("and no alert or retry button is left", [w.alerts, w.retry.length], [[], 0]);
    cart.unmount();
  }

  part("After a failure and a retry that answers, the next add shows \"Checking the prices…\", not the old failure");
  {
    const slow = later();
    const cart = await openCart(["a"], [failures[2][1], answer(onlyAWithC), slow.read]);
    await cart.retry();
    is("the retry answered", cart.view().button, [c.checkout("$10.00")]);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === `${c.add}: Product c`);
    const v = cart.view();
    is("while the new read runs, no alert from the old failure", v.alerts, []);
    is("and the panel says the prices are being checked", v.text.includes(c.loading), true);
    slow.give(aAndC);
    await cart.settle();
    is("once it answers, the form posts both", cart.view().posted, ["a", "c"]);
    cart.unmount();
  }

  part("The first read never answers");
  {
    const cart = await openCart(["a", "b"], [hang()]);
    is("the panel says the prices are being checked", cart.view().text.includes(c.loading), true);
    is("the wait is bounded (between 1 and 15 seconds)", bounded(), true);
    await cart.waitOut();
    const v = cart.view();
    is("after the wait, no longer \"Checking the prices…\"", v.text.includes(c.loading), false);
    is("the alert says 2 products could not be checked", v.alerts, [uncheckedSome(2)]);
    is("a \"Try again\" button is offered", v.retry.length, 1);
    cart.unmount();
  }

  // ---- Claude 5's focal return on #2978 (comment 6697801851), N1–N3, and Claude 4's re-review ----
  for (const how of ["hangs", "answers slowly"] as const) {
    part(`N1: after a removal, the re-read ${how}: the old total goes at once`);
    const slow = later();
    const cart = await openCart(["a", "b"], [answer(both), how === "hangs" ? hang() : slow.read]);
    is("first panel shows $27.00", cart.view().button, [c.checkout("$27.00")]);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === c.remove("Product b"));
    const v = cart.view();
    is("before any wait runs out, no old $27.00 anywhere", v.text.includes("$27.00"), false);
    is("no old \"10% off\" row for one product", v.text.includes(c.dealRow(10)), false);
    is("no old \"−$3.00\" saving", v.text.includes("$3.00"), false);
    is("the button says only \"Check out\"", v.button, [c.checkoutUnpriced]);
    is("the panel says the prices are being checked", v.statuses.includes(c.loading), true);
    is("no alert while the read is still running", v.alerts, []);
    if (how === "answers slowly") {
      slow.give(onlyA);
      await cart.settle();
      is("once it answers, the button says $10.00", cart.view().button, [c.checkout("$10.00")]);
      is("and the checking line is gone", cart.view().statuses.includes(c.loading), false);
    } else {
      await cart.waitOut();
      is("once the wait runs out, the alert says the prices could not be checked", cart.view().alerts, [c.unchecked]);
    }
    cart.unmount();
  }

  for (const [label, first, gone] of [
    ["a shipping row", bothShipped, ["$32.00", "$5.00"]],
    ["an \"add more\" row", bothNext, [c.dealNext(1, 10)]],
  ] as const) {
    part(`N1: after a removal, while the re-read runs, no old ${label}`);
    const cart = await openCart(["a", "b"], [answer(first), hang()]);
    is(`first panel shows ${label}`, gone.every((g) => cart.view().text.includes(g)), true);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === c.remove("Product b"));
    const v = cart.view();
    is(`before any wait runs out, no old ${label}`, gone.some((g) => v.text.includes(g)), false);
    is("the button says only \"Check out\"", v.button, [c.checkoutUnpriced]);
    cart.unmount();
  }

  part("N2: \"Try again\" says it is checking, keeps its button, and a new failure is said again");
  {
    const again = later();
    const cart = await openCart(["a"], [failures[2][1], again.read, answer(onlyA)]);
    is("the first failure is said", cart.view().alerts, [uncheckedSome(1)]);
    is("Try again was pressed", await cart.retry(), true);
    const v = cart.view();
    is("while it runs, the panel says the prices are being checked", v.statuses.includes(c.loading), true);
    is("the old alert is not left up as if nothing happened", v.alerts, []);
    is("the button is still there, so the focus is not lost", v.retry.length, 1);
    is("and it says it is busy", [v.retry[0]?.props?.["aria-disabled"], v.retry[0]?.props?.["aria-busy"]], [true, true]);
    is("one read so far for the retry", cart.reads(), 2);
    await cart.retry();
    is("pressing it again while busy starts no second read", cart.reads(), 2);
    again.drop();
    await cart.settle();
    const w = cart.view();
    is("when the retry fails too, the alert is said again", w.alerts, [uncheckedSome(1)]);
    is("the checking line is gone", w.statuses.includes(c.loading), false);
    is("the button can be pressed again", [w.retry.length, w.retry[0]?.props?.["aria-disabled"] ?? false], [1, false]);
    await cart.retry();
    is("and the next retry answers", cart.view().button, [c.checkout("$10.00")]);
    cart.unmount();
  }

  part("N2: \"Try again\" under the checkout form says it is checking");
  {
    const again = later();
    const cart = await openCart(["a", "b"], [answer(both), hang(), again.read]);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === c.remove("Product b"));
    await cart.waitOut();
    is("the alert says the prices could not be checked", cart.view().alerts, [c.unchecked]);
    await cart.retry();
    const v = cart.view();
    is("while it runs, the panel says the prices are being checked", v.statuses.includes(c.loading), true);
    is("the button is still there and busy", [v.retry.length, v.retry[0]?.props?.["aria-disabled"]], [1, true]);
    is("no amount on the checkout button", v.button, [c.checkoutUnpriced]);
    again.give(onlyA);
    await cart.settle();
    is("once it answers, the button says $10.00", cart.view().button, [c.checkout("$10.00")]);
    cart.unmount();
  }

  part("N3: a retry that fails does not move the focus later");
  {
    const cart = await openCart(["a"], [failures[2][1], failures[2][1], answer(aAndC)]);
    const seen = cart.watchFocus();
    await cart.retry();
    is("the retry failed", cart.view().alerts, [uncheckedSome(1)]);
    await cart.change(["a", "c"]);
    is("the cart read again after the change", cart.reads(), 3);
    is("that read answered", cart.view().posted, ["a", "c"]);
    is("the focus did not jump into the panel", seen.focus, 0);
    cart.unmount();
  }
  part("N3 control: a retry that answers puts the focus on the panel once");
  {
    const cart = await openCart(["a"], [failures[2][1], answer(onlyA)]);
    const seen = cart.watchFocus();
    await cart.retry();
    is("the retry answered", cart.view().button, [c.checkout("$10.00")]);
    is("the focus went to the panel once", seen.focus, 1);
    cart.unmount();
  }

  part("Claude 4: after a failed add, another change shows \"Checking the prices…\", not the old failure");
  {
    const slow = later();
    const cart = await openCart(["a"], [answer(onlyAWithC), failures[2][1], slow.read]);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === `${c.add}: Product c`);
    is("the failed add is said", cart.view().alerts, [uncheckedSome(1)]);
    await cart.change(["a", "c", "d"]);
    const v = cart.view();
    is("while the new read runs, no alert from the old failure", v.alerts, []);
    is("and the panel says the prices are being checked", v.statuses.includes(c.loading), true);
    slow.give({ ...aAndC, items: [...aAndC.items, line("d", "$1.00")], total: "$16.00" });
    await cart.settle();
    is("once it answers, the form posts all three", cart.view().posted, ["a", "c", "d"]);
    cart.unmount();
  }

  // ---- Claude 6's review of #2978 (two LEVES she found reading the code, and an optional target size) ----
  part("Claude 6 L1: reopening the cart while it reads again does not show the old failure");
  {
    const cart = await openCart(["a"], [failures[2][1], hang()]);
    is("the first failure is said", cart.view().alerts, [uncheckedSome(1)]);
    await cart.reopen();
    const v = cart.view();
    is("the cart reads again when it is opened again", cart.reads(), 2);
    is("while that read runs, no alert from the old failure", v.alerts, []);
    is("and the panel says the prices are being checked", v.statuses.includes(c.loading), true);
    await cart.waitOut();
    is("when that read fails too, the alert is said again", cart.view().alerts, [uncheckedSome(1)]);
    cart.unmount();
  }
  {
    const cart = await openCart(["a", "b"], [answer(both), failures[2][1], hang()]);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === c.remove("Product b"));
    is("under the form, the failure is said", cart.view().alerts, [c.unchecked]);
    await cart.reopen();
    const v = cart.view();
    is("under the form, reopening shows no old alert while the read runs", v.alerts, []);
    is("and says the prices are being checked", v.statuses.includes(c.loading), true);
    is("and the button carries no amount", v.button, [c.checkoutUnpriced]);
    cart.unmount();
  }

  const unknownStore: Answer = async () => new Response(JSON.stringify({ ok: false, error: "unknown" }), { status: 404 });
  part("Claude 6 L2: a store that is gone (404) says so, with no \"Try again\" and nothing to pay");
  {
    const cart = await openCart(["a"], [unknownStore]);
    const v = cart.view();
    is("the alert says the store is not taking orders", v.alerts, [closedWord()]);
    is("no \"Try again\" that can only fail again", v.retry.length, 0);
    is("no checkout form", v.posted, null);
    is("no \"could not check\" sentence", v.text.includes(uncheckedSome(1)), false);
    cart.unmount();
  }
  {
    const cart = await openCart(["a", "b"], [answer(both), unknownStore]);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === c.remove("Product b"));
    const v = cart.view();
    is("after a change, the alert says the store is not taking orders", v.alerts, [closedWord()]);
    is("no \"Try again\"", v.retry.length, 0);
    is("no checkout button that would post to a store that is gone", v.button, []);
    is("no old $27.00", v.text.includes("$27.00"), false);
    cart.unmount();
  }
  part("Claude 6 focal L1: reopening after \"not taking orders\" never shows the old lines or a checkout form");
  {
    const cart = await openCart(["a", "b"], [answer(both), unknownStore, hang()]);
    await cart.press((n) => n.type === "button" && n.props?.["aria-label"] === c.remove("Product b"));
    is("first, it is gone", cart.view().alerts, [closedWord()]);
    await cart.reopen();
    const v = cart.view();
    is("while the new read runs, no checkout form", v.posted, null);
    is("no checkout button", v.button, []);
    is("and the panel says the prices are being checked", v.statuses.includes(c.loading), true);
    await cart.waitOut();
    const w = cart.view();
    is("when that read runs out of time, still no checkout form", w.posted, null);
    is("it says the product could not be checked", w.alerts, [uncheckedSome(1)]);
    is("with \"Try again\"", w.retry.length, 1);
    cart.unmount();
  }
  part("Claude 6 focal L2: the store-gone sentence follows each table's own writing");
  is("pt is the table's European Portuguese (\"a aceitar\", \"por isso\")", [closedWord(CART_WORDS.pt).includes("a aceitar"), closedWord(CART_WORDS.pt).includes("por isso"), closedWord(CART_WORDS.pt).includes("então")], [true, true, false]);
  is("fr uses the no-break space before \":\" and the straight apostrophe", [closedWord(CART_WORDS.fr).includes("\u00a0:"), closedWord(CART_WORDS.fr).includes(" :"), closedWord(CART_WORDS.fr).includes("\u2019")], [true, false, false]);

  part("Claude 6 L2 control: a 404 that is not the cart's own answer is an ordinary failure");
  {
    const cart = await openCart(["a"], [async () => new Response("<html>not found</html>", { status: 404 })]);
    is("it says the product could not be checked", cart.view().alerts, [uncheckedSome(1)]);
    is("with \"Try again\"", cart.view().retry.length, 1);
    cart.unmount();
  }
  part("Claude 6 L2 control: a store that answers again after a 404 is shown normally");
  {
    const cart = await openCart(["a"], [unknownStore, answer(onlyA)]);
    is("first, it is gone", cart.view().alerts, [closedWord()]);
    await cart.reopen();
    is("opened again, the store answers and the button says $10.00", cart.view().button, [c.checkout("$10.00")]);
    is("and no alert is left", cart.view().alerts, []);
    cart.unmount();
  }
  part("Claude 6 (optional): \"Try again\" is at least 44 px wide as well as tall");
  {
    const cart = await openCart(["a"], [failures[2][1]]);
    const cls = String(cart.view().retry[0]?.props?.className ?? "");
    is("min-h-11 and min-w-11", [cls.includes("min-h-11"), cls.includes("min-w-11")], [true, true]);
    cart.unmount();
  }

  part("The words exist in every language a store sells in");
  for (const [code, words] of Object.entries(CART_WORDS)) {
    is(`${code}: "Check out" with no amount is set`, words.checkoutUnpriced.trim().length > 0 && !words.checkoutUnpriced.includes("·"), true);
    is(`${code}: it is the priced button's own verb`, words.checkout("$1.00").startsWith(words.checkoutUnpriced), true);
    is(`${code}: the alert is a full sentence`, words.unchecked.trim().length > 20, true);
  }
  is("the seven languages say it differently", new Set(Object.values(CART_WORDS).map((w) => w.unchecked)).size, 7);
  for (const [code, words] of Object.entries(CART_WORDS)) {
    is(`${code}: "Try again" is set`, retryWord(words).trim().length > 0 && !retryWord(words).startsWith("<"), true);
    is(`${code}: 1 and 2 unchecked products are full sentences that differ`, uncheckedSome(1, words).length > 20 && !uncheckedSome(1, words).startsWith("<") && uncheckedSome(1, words) !== uncheckedSome(2, words), true);
    is(`${code}: the count is in the sentence`, uncheckedSome(1, words).includes("1") && uncheckedSome(2, words).includes("2"), true);
  }
  for (const [code, words] of Object.entries(CART_WORDS)) {
    is(`${code}: the store-gone sentence is set`, closedWord(words).length > 20 && !closedWord(words).startsWith("<"), true);
  }
  is("the seven store-gone sentences differ", new Set(Object.values(CART_WORDS).map((w) => closedWord(w))).size, 7);
  is("the seven \"Try again\" differ", new Set(Object.values(CART_WORDS).map((w) => retryWord(w))).size, 7);
  is("the seven unchecked-products sentences differ", new Set(Object.values(CART_WORDS).map((w) => uncheckedSome(2, w))).size, 7);
  done();
}
void main();
