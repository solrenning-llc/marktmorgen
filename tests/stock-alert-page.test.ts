/**
 * 623 [SZ7], unit 3: the back-in-stock page never answers a link it could not
 * read with a confident "no" (rule 24, Claude 3 on #3620, LOW 3). A stop link
 * read unknown does not say "not on this list"; a confirm link read unknown
 * does not say "expired": both show the error notice, which invites a retry.
 * Synthetic Redis only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import BackInStockPage from "@/app/[handle]/back-in-stock/page";
import { claimHandle, ensureStatsId } from "@/lib/store";
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

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
