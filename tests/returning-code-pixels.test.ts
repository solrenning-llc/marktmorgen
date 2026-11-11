/**
 * The emailed link for a returning buyer's code (554 [DS1], #3690) opens the
 * product page at /@store/p/<id>?rtoken=<token>#returning. The token works
 * once, for that address, and opens the checkout with the code: a key to an
 * order, like the thanks page's session_id (506 [SG1], finding E-2). Every ad
 * script a store starts reads the page's own address with each event (Meta's
 * `dl`, Google's page_location, ...), so the token must be out of the address
 * before any of them starts.
 *
 * And the page must still work: the code field reads the token from the
 * address to send it with the buy button. Once the pixels have taken it out,
 * the field still has it, or the link in the email would do nothing on every
 * store with a pixel.
 *
 * This runs the real StorePixels component (its effects in place, with a
 * stand-in for the browser), as tests/review-2557-page-url.test.ts does, and
 * the field's own reader. Synthetic data only.
 */
import * as React from "react";
import { StorePixels } from "@/components/store-pixels";
import { linkTokenHere } from "@/components/returning-code-box";
import { NO_PIXELS } from "@/lib/pixels";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const TOKEN = "b".repeat(64);

type Seen = { src: string; page: string };

function browserAt(href: string) {
  const seen: Seen[] = [];
  const store = new Map<string, string>();
  const session = new Map<string, string>();
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
  g.sessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  };
  g.performance = { getEntriesByType: () => [{ type: "navigate" }] };
  Object.defineProperty(g, "navigator", { value: { globalPrivacyControl: false }, configurable: true, writable: true });
  g.document = {
    cookie: "",
    referrer: "",
    readyState: "complete",
    createElement: () => ({}),
    head: { appendChild: (tag: { src?: string }) => seen.push({ src: String(tag.src), page: location.href }) },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.window = g;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  return { seen };
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

const pixels = { ...NO_PIXELS, meta: "423456789012345", google: "G-CB12CD34EF", tiktok: "C6ABCDEFGH1234567890", pinterest: "2812345678901" };
const here = () => (globalThis as unknown as { location: URL }).location;

async function main(): Promise<void> {
  part("The product page opened from the emailed link, on a store with pixels");
  const page = browserAt(`https://marktmorgen.com/@returnbox/p/prod000001?rtoken=${TOKEN}#returning`);
  is("before the pixels: the field reads the token from the address", linkTokenHere(), TOKEN);
  run({ handle: "returnbox", storeName: "Return Box", pixels, names: "Meta and Google", askFirst: false });
  is("the four platforms' scripts were started", page.seen.length, 4);
  is(
    "no platform's script is started on an address that names the token",
    page.seen.filter((s) => s.page.includes(TOKEN)).map((s) => new URL(s.src).hostname),
    [],
  );
  is("and the address is not left naming it afterward", here().href.includes(TOKEN), false);
  is("the rest of the address stays", here().href, "https://marktmorgen.com/@returnbox/p/prod000001#returning");
  is("after the pixels: the field still has the token, so the emailed link still works", linkTokenHere(), TOKEN);

  part("Never another page's token");
  (here() as unknown as { href: string }).href = "https://marktmorgen.com/@returnbox/p/prod000002";
  is("another product's page: no token", linkTokenHere(), "");

  part("A page opened without the token");
  browserAt("https://marktmorgen.com/@returnbox/p/prod000003");
  run({ handle: "returnbox2", storeName: "Return Box", pixels: { ...NO_PIXELS, meta: "523456789012345" }, names: "Meta", askFirst: false });
  is("no token", linkTokenHere(), "");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
