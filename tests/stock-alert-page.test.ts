/**
 * 623 [SZ7], unit 3: the back-in-stock page never answers a link it could not
 * read with a confident "no" (rule 24, Claude 3 on #3620, LOW 3). A stop link
 * read unknown does not say "not on this list"; a confirm link read unknown
 * does not say "expired": both show the error notice, which invites a retry.
 * Synthetic Redis only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import BackInStockPage from "@/app/[handle]/back-in-stock/page";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { confirmEmail } from "@/lib/stock-alert-send";
import { STOCK_ALERT_WORDS } from "@/lib/buyer-words/stock-alert";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const w = STOCK_ALERT_WORDS.en;
const TOKEN = "ab".repeat(24);

async function page(query: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await BackInStockPage({ params: Promise.resolve({ handle: "@harbor" }), searchParams: Promise.resolve(query) }));
}

/** Redis that throws on reading a back-in-stock link, as on a lost connection. */
async function unreadable<T>(run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:sa:t:"))) throw new Error("connection lost");
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

/** What the page did at `handle`: drawn, sent elsewhere (and where), or not found. */
async function outcome(handle: string, query: Record<string, string>): Promise<string> {
  try {
    await BackInStockPage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(query) });
    return "shown";
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    if (digest.includes("404")) return "not found";
    throw error;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("owner@example.com", "harbor", "Harbor Prints", "");
  await ensureStatsId("owner@example.com");

  part("A link that is not there: the page says so");
  const gone = await page({ leave: TOKEN });
  is("a stop link that is not there: not on the list", gone.includes(w.notOnListTitle), true);
  const old = await page({ token: TOKEN });
  is("a confirm link that is not there: expired", old.includes(w.notices.expired.title), true);

  part("A link that could not be read: never a confident no (rule 24)");
  const stop = await unreadable(() => page({ leave: TOKEN }));
  is("a stop link read unknown: not \"not on this list\"", stop.includes(w.notOnListTitle), false);
  is("a stop link read unknown: the error notice", stop.includes(w.notices.error.title), true);
  const confirm = await unreadable(() => page({ token: TOKEN }));
  is("a confirm link read unknown: not \"expired\"", confirm.includes(w.notices.expired.title), false);
  is("a confirm link read unknown: the error notice", confirm.includes(w.notices.error.title), true);

  part("A link in an email names the store by its own id, so a handle let go or taken by another store still reaches it (Claude 1 on #3620)");
  await ensureStoreId("owner@example.com");
  const harbor = (await storeForEmail("owner@example.com"))!;
  const mail = confirmEmail(harbor, { id: "p1", title: "Signed Print" } as never, { confirm: TOKEN, leave: TOKEN }, "https://marktmorgen.com");
  const links = [...String(mail.text).matchAll(/https:\/\/marktmorgen\.com\/@harbor\/back-in-stock\?[^\s]+/g)].map((m) => m[0]);
  is("both page links carry the store's own id", links.length >= 2 && links.every((l) => new URL(l).searchParams.get("i") === harbor.sid), true);
  is("a handle no store has now, with the store's id: sent to its current page, the link kept", await outcome("@oldharbor", { leave: TOKEN, i: harbor.sid! }), `redirect /@harbor/back-in-stock?leave=${TOKEN}&i=${harbor.sid}`);
  await claimHandle("other@example.com", "quay", "Quay Goods", "");
  await ensureStoreId("other@example.com");
  is("a handle now another store's, with the first store's id: sent to the first store's page", await outcome("@quay", { token: TOKEN, i: harbor.sid! }), `redirect /@harbor/back-in-stock?token=${TOKEN}&i=${harbor.sid}`);
  is("an id no store has: not found, as before", await outcome("@oldharbor", { leave: TOKEN, i: "zz".repeat(8) }), "not found");
  is("the store's own handle and id: drawn", await outcome("@harbor", { leave: TOKEN, i: harbor.sid! }), "shown");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
