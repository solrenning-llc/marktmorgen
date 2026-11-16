/**
 * Independent review of PR #2557 at f5c5df841 (506 [SG1], finding E-2): the
 * fix clears session_id, paypal, token, pkg and move from the address before
 * any pixel starts. What is checked here, each against the real StorePixels
 * component run with its effects in place in a stand-in browser:
 *
 *   1. the page before: a thanks page whose pixels never started (the visitor
 *      was asked first and had not answered) keeps its key in the address; a
 *      plain link from it to the store's front page (thanks/page.tsx "back to
 *      the store") opens that page with the thanks page's whole address as
 *      document.referrer (same origin, strict-origin-when-cross-origin), and
 *      every platform's script sends document.referrer (Meta's `rl`, Google's
 *      `dr`, TikTok's page referrer). A yes there must not start a script
 *      while the referrer names an order;
 *   2. client-side navigation: the thanks page's "Get my link" is a Next Link
 *      to /affiliates?order=<cs_…>. Next moves there with pushState, with the
 *      pixels' scripts already loaded; Meta's pixel and Google's tag count a
 *      history change as a page view with the new address. No link on the
 *      thanks page may carry an order key to another page of this site;
 *   3. a reload of a different address on the same path (the free page after
 *      a new sign-up, ?status=sent&product=…) must not be sent back with the
 *      token kept from an earlier claim in this tab;
 *   4. Next's router: Next 16.4.2 patches history.replaceState
 *      (node_modules/next/dist/client/components/app-router.js:302-312) and
 *      skips syncing its own URL when the state passed carries `__NA`, which
 *      history.state on an App Router page always does. Its canonical URL then
 *      keeps the key, and the next history write of the router puts it back.
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { StorePixels } from "@/components/store-pixels";
import { NO_PIXELS, type Pixels } from "@/lib/pixels";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const SESSION = "cs_test_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV";
const TOKEN = "f".repeat(48);

type Browser = { seen: { src: string; page: string; referrer: string }[]; replaced: string[]; router: string[] };

function browserAt(href: string, opts: { referrer?: string; session?: Map<string, string>; navigation?: string; nextRouter?: boolean } = {}): Browser {
  const b: Browser = { seen: [], replaced: [], router: [] };
  const location = new URL(href) as unknown as URL & { replace(u: string): void };
  location.replace = (u: string) => void b.replaced.push(u);
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of ["fbq", "_fbq", "gtag", "dataLayer", "ttq", "TiktokAnalyticsObject", "pintrk", "twq", "rdt"]) delete g[name];
  g.location = location;
  const history = {
    state: opts.nextRouter ? { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [], renderedSearch: location.search } } : null,
    replaceState(data: unknown, _t: string, url: string) {
      // Next 16.4.2's patch, as written in app-router.js: a state with __NA is the
      // router's own write and goes through untouched; any other also moves the router.
      const own = Boolean((data as { __NA?: unknown } | null)?.__NA);
      if (opts.nextRouter && !own && url) b.router.push(new URL(url, location.href).href);
      location.href = new URL(url, location.href).href;
    },
  };
  g.history = history;
  const map = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  g.localStorage = map(new Map());
  const session = opts.session ?? new Map<string, string>();
  Object.defineProperty(g, "sessionStorage", { configurable: true, get: () => map(session) });
  Object.defineProperty(g, "performance", {
    configurable: true,
    writable: true,
    value: { getEntriesByType: (t: string) => (t === "navigation" && opts.navigation ? [{ type: opts.navigation }] : []), now: () => 0 },
  });
  Object.defineProperty(g, "navigator", { value: { globalPrivacyControl: false }, configurable: true, writable: true });
  const referrer = opts.referrer ?? "";
  g.document = {
    cookie: "",
    referrer,
    readyState: "complete",
    createElement: () => ({}),
    head: { appendChild: (tag: { src?: string }) => b.seen.push({ src: String(tag.src), page: location.href, referrer }) },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.window = g;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  return b;
}

function runPixels(props: Parameters<typeof StorePixels>[0]) {
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
    StorePixels(props);
  } finally {
    internals.H = before;
  }
}

let seq = 0;
function pixels(): Pixels {
  seq += 1;
  return { ...NO_PIXELS, meta: `12345678901234${seq}`.slice(-15), google: `G-REVIEW${seq}`, tiktok: `C4ABCDEFGH123456789${seq}`.slice(-20), pinterest: `261234567890${seq}`.slice(-13) };
}
const props = (event: Parameters<typeof StorePixels>[0]["event"] = null) => ({ handle: "harbor", storeName: "Harbor Kitchen", pixels: pixels(), names: "Meta and Google", askFirst: true, event });

async function main(): Promise<void> {
  part("1. The store's front page, reached by a plain link from a thanks page whose pixels never started");
  // Adjusted with the fix: a page cannot change its document.referrer, so the fix starts no script on
  // such a page (the thanks page now clears its key on mount, so only a click made before that is left).
  // "Would start" is checked on the same page reached from a referrer without a key.
  const clean = browserAt("https://marktmorgen.com/@harbor", { referrer: "https://marktmorgen.com/@harbor/thanks" });
  runPixels(props());
  is("the scripts would start", clean.seen.length > 0, true);
  const front = browserAt("https://marktmorgen.com/@harbor", { referrer: `https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}` });
  runPixels(props());
  is("no script starts while the page's referrer names the checkout", front.seen.filter((s) => s.referrer.includes(SESSION)).map((s) => new URL(s.src).hostname), []);

  part("2. Links on the thanks page to other pages of this site");
  const thanks = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  // Adjusted with the fix (coordinator's decision): the affiliate page takes the order only in its
  // address, so its link stays, as a plain <a> whose full page load unloads this page's scripts.
  // What must not exist is a Next <Link>, moved with pushState past the pixels already loaded.
  const keyed = (thanks.match(/<Link\s+href=\{`\/@\$\{store\.handle\}\/[^`]*\?[^`]*\$\{encodeURIComponent\(sessionId\)\}[^`]*`\}/g) ?? []).filter((h) => !h.includes("/api/"));
  is("none carries the checkout's id (Next moves there with pushState, past pixels already loaded)", keyed, []);
  is("nor the package's token", /<Link\s+href=\{book\}/.test(thanks), false);

  part("3. A reload of another address on the same path");
  const kept = new Map([["nl_px_keys:/@harbor/free", JSON.stringify([["token", TOKEN]])]]);
  const signup = browserAt("https://marktmorgen.com/@harbor/free?status=sent&product=guide00002", { session: kept, navigation: "reload" });
  runPixels(props());
  is("the page reloaded is the page shown again, not an earlier claim's", signup.replaced, []);

  part("4. Next's router after the key is taken out");
  const routed = browserAt(`https://marktmorgen.com/@harbor/thanks?session_id=${SESSION}&upsell=no`, { nextRouter: true });
  runPixels(props());
  is("the address bar is cleared", (globalThis as unknown as { location: URL }).location.href, "https://marktmorgen.com/@harbor/thanks?upsell=no");
  is("and the router is told, so its own next write does not put the key back", routed.router, ["https://marktmorgen.com/@harbor/thanks?upsell=no"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
