/**
 * The store cart (components/store-cart.tsx) reads its lines from
 * /api/store/cart when it opens. Before, a read that failed (no network, a
 * reply that is not JSON, or `ok: false`, such as 429 "slow") was swallowed,
 * so the panel kept saying "Checking the prices…" for good: the buyer was never
 * told the cart could not be loaded and had no way to try again (3.3.1, 4.1.3).
 *
 * Now the failed read is kept as the one it was (`reading`), the panel says so
 * in a role="alert" line, and a 44 px "Try again" button reads it again.
 *
 * The load effect runs as written in the component, with a stubbed fetch and
 * recording setters. Synthetic ids and prices only.
 */
import { readFileSync } from "node:fs";
import { cartWords } from "@/lib/buyer-words/cart";
import { compile, cutBlock, fetchAnswering, recorder, settle } from "./client-handler";
import { done, is, part } from "./check";

const FILE = "components/store-cart.tsx";
const SOURCE = readFileSync(FILE, "utf8");
const SETTERS = ["setLines", "setTotal", "setDeal", "setNext", "setSuggest", "setBundle", "setShipping", "setApart", "setDigital", "setUnread"] as const;

const loading = compile<() => (() => void) | undefined>(
  `const effect = ${cutBlock(FILE, "useEffect(() => {\n    if (!open || !wanted) return;").slice("useEffect(".length)};`,
  ["fetch", "open", "wanted", "handle", "reading", "URLSearchParams", ...SETTERS],
  "effect",
);

async function load(answer: typeof fetch, options: { leave?: boolean } = {}) {
  const seen = Object.fromEntries(SETTERS.map((name) => [name, recorder<unknown>()]));
  const scope: Record<string, unknown> = { fetch: answer, open: true, wanted: "p1,p2", handle: "demo", reading: "read-1", URLSearchParams };
  for (const name of SETTERS) scope[name] = seen[name].set;
  const cleanup = loading(scope)();
  if (options.leave) cleanup?.();
  await settle();
  await settle();
  return { lines: seen.setLines.seen, unread: seen.setUnread.seen };
}

async function main() {
  const items = [{ id: "p1", title: "Synthetic guide", href: "/demo/p1", ok: true, price: "$10.00" }];

  part("A healthy read is shown as before");
  const good = await load(fetchAnswering({ ok: true, items, total: "$10.00", digital: true }));
  is("the lines are shown", good.lines, [items]);
  is("and no failure is kept", good.unread.every((value) => value === null), true);

  part("A read that failed is said, for the read it was");
  const offline = await load(fetchAnswering(new TypeError("Failed to fetch")));
  is("no network: the read is kept as not loaded", offline.unread, ["read-1"]);
  is("no network: no lines are made up", offline.lines, []);
  const html = await load(fetchAnswering("<html>Internal Server Error</html>", 500));
  is("a reply that is not JSON: kept as not loaded", html.unread, ["read-1"]);
  const slow = await load(fetchAnswering({ ok: false, error: "slow" }, 429));
  is("ok: false (429 slow): kept as not loaded", slow.unread, ["read-1"]);
  const gone = await load(fetchAnswering(new TypeError("Failed to fetch")), { leave: true });
  is("a read answered after the panel moved on changes nothing", gone.unread, []);

  part("The panel tells the buyer and offers a way to try again");
  is("the failed read is drawn in place of the loading line", SOURCE.includes(") : unread === reading ? ("), true);
  is("in a role=\"alert\" line with the cart's own words", /role="alert" data-cart-unread="">\{c\.unread\}<\/p>/.test(SOURCE), true);
  const retry = /<button[^>]*data-cart-retry=""[^>]*>/.exec(SOURCE)?.[0] ?? "";
  is("a retry button is there", retry.length > 0, true);
  is("at least 44 by 44 px (2.5.5)", /min-h-11/.test(retry) && /min-w-11/.test(retry), true);
  is("it reads again and keeps the focus in the panel", /setTries\(\(now\) => now \+ 1\);\s*panel\.current\?\.focus\(\);/.test(SOURCE), true);
  is("a new try is a new read", SOURCE.includes("const reading = `${wanted}#${tries}`;"), true);

  part("Every buyer language has the words");
  for (const lang of ["en", "es", "fr", "de", "it", "nl", "pt"]) {
    const c = cartWords(lang) as unknown as Record<string, unknown>;
    is(`${lang}: says the cart was not loaded`, typeof c.unread === "string" && (c.unread as string).length > 20, true);
    is(`${lang}: names the retry`, typeof c.retry === "string" && (c.retry as string).length > 2, true);
    if (lang !== "en") is(`${lang}: in its own words`, c.unread !== cartWords("en").unread, true);
  }

  done();
}

void main();
