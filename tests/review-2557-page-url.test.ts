/**
 * Independent review of PR #2557 (506 [SG1], finding E-2): the checkout's own
 * id (cs_…) must not reach an ad platform. The PR swaps the id in the pixels'
 * event fields for adEventId, but the thanks page is still opened at
 * /@handle/thanks?session_id=cs_… (and ?paypal=<order>), and every pixel the
 * page starts reads the page's own address (Meta's `dl`, Google's
 * page_location, TikTok's page url, Pinterest's, X's and Reddit's) with every
 * event it sends, the Purchase included. So the raw id still goes to each
 * platform the page loads.
 *
 * This runs the real StorePixels component (its effects run in place, with a
 * stand-in for the browser) on the thanks page's address and records the
 * address each platform's script is loaded from: the address that script then
 * reads. It must not name the order.
 */
import * as React from "react";
import { StorePixels } from "@/components/store-pixels";
import { NO_PIXELS } from "@/lib/pixels";
import { adEventId } from "@/lib/ad-events";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const SESSION = "cs_test_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV";
const PAYPAL = "5O190127TN364715T";

type Seen = { src: string; page: string };

function browserAt(href: string) {
  const seen: Seen[] = [];
  const posted: string[] = [];
  const store = new Map<string, string>();
  const location = new URL(href) as unknown as Location & { href: string };
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of ["fbq", "_fbq", "gtag", "dataLayer", "ttq", "TiktokAnalyticsObject", "pintrk", "twq", "rdt"]) delete g[name];
  g.location = location;
  g.history = {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => {
      const next = new URL(url, location.href);
      (location as unknown as URL).href = next.href;
    },
  };
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  Object.defineProperty(g, "navigator", { value: { globalPrivacyControl: false }, configurable: true, writable: true });
  g.document = {
    cookie: "",
    readyState: "complete",
    createElement: () => ({}),
    head: { appendChild: (tag: { src?: string }) => seen.push({ src: String(tag.src), page: location.href }) },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.window = g;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.fetch = (async (_url: string, init?: RequestInit) => {
    posted.push(String(init?.body));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { seen, posted };
}

/** Runs the component once with its effects in place and its state "on" (the pixels allowed). */
function run(element: Parameters<typeof StorePixels>[0]) {
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
    StorePixels(element);
  } finally {
    internals.H = before;
  }
}

const pixels = { ...NO_PIXELS, meta: "123456789012345", google: "G-AB12CD34EF", tiktok: "C4ABCDEFGH1234567890", pinterest: "2612345678901" };

async function main(): Promise<void> {
  part("Stripe thanks page: what address the pixels read");
  const stripe = browserAt(`https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}`);
  run({
    handle: "harbor",
    storeName: "Harbor Kitchen",
    pixels,
    names: "Meta and Google",
    askFirst: false,
    event: { type: "purchase", id: adEventId(SESSION), value: 49, currency: "usd", productId: "club000001", title: "Club" },
  });
  is("the four platforms' scripts were started", stripe.seen.length, 4);
  is(
    "no platform's script is started on an address that names the checkout",
    stripe.seen.filter((s) => s.page.includes(SESSION)).map((s) => new URL(s.src).hostname),
    [],
  );
  is("and the address is not left naming it afterward either", (globalThis as unknown as { location: URL }).location.href.includes(SESSION), false);

  part("PayPal thanks page: what address the pixels read");
  const paypal = browserAt(`https://marktmorgen.com/@harbor/thanks?paypal=${PAYPAL}`);
  run({
    handle: "harbor2",
    storeName: "Harbor Kitchen",
    pixels: { ...pixels, meta: "223456789012345", google: "G-BB12CD34EF", tiktok: "C5ABCDEFGH1234567890", pinterest: "2712345678901" },
    names: "Meta and Google",
    askFirst: false,
    event: { type: "purchase", id: adEventId(PAYPAL), value: 49, currency: "usd", productId: "club000001", title: "Club" },
  });
  is("the four platforms' scripts were started", paypal.seen.length, 4);
  is(
    "no platform's script is started on an address that names the PayPal order",
    paypal.seen.filter((s) => s.page.includes(PAYPAL)).map((s) => new URL(s.src).hostname),
    [],
  );

  part("A buyer who comes back to the thanks page after the change (the order email links to it)");
  const back = browserAt(`https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}`);
  // What the code before this PR wrote on the first visit, after sending the purchase under the checkout's id.
  (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(`nl_px_sent:${SESSION}`, "1");
  run({
    handle: "harbor3",
    storeName: "Harbor Kitchen",
    pixels: { ...NO_PIXELS, meta: "323456789012345" },
    names: "Meta",
    askFirst: false,
    event: { type: "purchase", id: adEventId(SESSION), value: 49, currency: "usd", productId: "club000001", title: "Club" },
  });
  const queued = ((globalThis as unknown as { fbq?: { queue: unknown[][] } }).fbq?.queue ?? []).filter((c) => c[0] === "track" && c[1] === "Purchase");
  is("the purchase already sent is not sent again under a new id (Meta would count it twice)", queued.length, 0);
  // The server's own mark (sentKey, by the checkout's id) still stops a second server send: only the pixels count twice.
  void back;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
