/**
 * A buy button pressed twice sends one checkout (components/store-pixels.tsx).
 *
 * With the store's ad pixels allowed, the page holds every `form[data-checkout]`
 * back for 300 ms so the checkout event can leave first, then submits it again
 * itself. A second press inside that wait used to find the form already marked
 * and return without holding it back, so the browser sent it at once, and the
 * delayed submit sent it a second time: two checkouts, two Stripe sessions,
 * and for a limited product or a booked time, a second hold on it.
 *
 * The real component runs its effects against a stand-in browser (the shape of
 * tests/ad-event-ids.test.ts); the form below counts each submit the browser
 * would really send, that is each submit event nobody prevented.
 */
import * as React from "react";
import { NO_PIXELS, type Pixels } from "@/lib/pixels";
import { StorePixels } from "@/components/store-pixels";
import { done, is, part } from "./check";

type Listener = (e: unknown) => void;
const listeners: Listener[] = [];
const timers: (() => void)[] = [];
const g = globalThis as unknown as Record<string, unknown>;
const realSetTimeout = globalThis.setTimeout;

function browser(): void {
  const location = new URL("https://marktmorgen.com/@harbor/p/club") as unknown as URL;
  const history = { state: { __NA: true }, replaceState() {} };
  (history as unknown as Record<string, unknown>).replaceState = () => {};
  const storage = (m: Map<string, string>) => ({
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  g.location = location;
  g.history = history;
  g.localStorage = storage(new Map());
  Object.defineProperty(g, "sessionStorage", { configurable: true, value: storage(new Map()) });
  Object.defineProperty(g, "performance", { configurable: true, writable: true, value: { getEntriesByType: () => [], now: () => 0 } });
  Object.defineProperty(g, "navigator", { value: { globalPrivacyControl: false }, configurable: true, writable: true });
  g.document = {
    cookie: "",
    referrer: "",
    readyState: "complete",
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: (type: string, f: Listener) => void (type === "submit" && listeners.push(f)),
    removeEventListener: () => {},
  };
  g.window = g;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  // Timers are run by hand, so "within the 300 ms wait" is exact.
  g.setTimeout = ((f: () => void) => {
    timers.push(f);
    return timers.length;
  }) as unknown as typeof setTimeout;
  g.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
}

function runPixels(pixels: Pixels): void {
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const before = internals.H;
  internals.H = {
    useState: () => ["on", () => {}],
    useEffect: (effect: () => unknown) => void effect(),
    useLayoutEffect: (effect: () => unknown) => void effect(),
    useRef: (v: unknown) => ({ current: v }),
    useCallback: (f: unknown) => f,
    useMemo: (f: () => unknown) => f(),
    useContext: () => null,
  };
  try {
    StorePixels({ handle: "harbor", storeName: "Harbor Kitchen", pixels, names: "Meta", askFirst: false, event: null });
  } finally {
    internals.H = before;
  }
}

/** A checkout form: each submit event is offered to the page's listeners, and goes out unless one prevented it. */
function checkoutForm() {
  const form = {
    sent: 0,
    dataset: {} as Record<string, string>,
    hasAttribute: (name: string) => name === "data-checkout",
    requestSubmit: () => press(),
  };
  function press(): void {
    let prevented = false;
    const event = { target: form, submitter: undefined, preventDefault: () => void (prevented = true) };
    for (const f of listeners) f(event);
    if (!prevented) form.sent += 1;
  }
  Object.setPrototypeOf(form, (g.HTMLFormElement as { prototype: object }).prototype);
  return { form, press };
}

function drain(): void {
  while (timers.length) timers.shift()!();
}

async function main(): Promise<void> {
  browser();
  g.HTMLFormElement = class {};
  g.HTMLElement = class {};
  runPixels({ ...NO_PIXELS, meta: "123456789012345" });
  is("the page listens for checkout submits while the pixels are allowed", listeners.length > 0, true);

  part("One press: one checkout, sent once the event has gone");
  {
    const { form, press } = checkoutForm();
    press();
    is("held back at first", form.sent, 0);
    drain();
    is("then sent once", form.sent, 1);
  }

  part("Two presses inside the wait: still one checkout");
  {
    const { form, press } = checkoutForm();
    press();
    press();
    drain();
    is("one checkout, not two", form.sent, 1);
  }

  part("Three quick presses: one checkout");
  {
    const { form, press } = checkoutForm();
    press();
    press();
    press();
    drain();
    is("one checkout, not three", form.sent, 1);
  }
  g.setTimeout = realSetTimeout;
}

void main().then(done).catch((error) => {
  console.error(error);
  process.exit(1);
});
