/**
 * The moved notice at a closed store's old address (97 [D2-OPEN-EXIT],
 * unit 4: handleLookup in lib/store.ts, exitAnswerForValue in
 * lib/exit-redirect-rules.ts, components/moved-notice.tsx).
 *
 * What fails here:
 *   - a page that reads the address a second time to find the notice (a
 *     command more per visit);
 *   - a notice shown for a live store's address, a released one with no
 *     notice, or one that cannot be read;
 *   - a notice that does not name the new host, its end, or that the site
 *     was not checked; a link that opens a new window or passes on the page;
 *   - a store found differently from before (storeForHandle).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, closeStoreRecord, handleLookup, storeForEmail, storeForHandle } from "@/lib/store";
import { EXIT_NOTICE_DAYS, exitAnswerForValue, releasedValue, type ExitNotice } from "@/lib/exit-redirect-rules";
import { MovedNotice } from "@/components/moved-notice";

const DAY = 86_400_000;
const now = Date.now();
const notice: ExitNotice = { to: "https://example.com/shop", host: "example.com", closedAt: now - DAY, setAt: now - 3 * DAY };

(async () => {
  part("Read from the value the visit already reads");
  is("a released value with a notice: moved", exitAnswerForValue(releasedValue(new Date(now), notice), now), { kind: "moved", to: notice.to, host: notice.host, until: notice.closedAt + EXIT_NOTICE_DAYS * DAY });
  is("a released value with no notice: none", exitAnswerForValue(releasedValue(new Date(now), null), now), { kind: "none" });
  is("a live store's value: none", exitAnswerForValue("owner@example.com", now), { kind: "none" });
  is("nothing read: none", exitAnswerForValue(null, now), { kind: "none" });
  is("after the 90 days: gone", exitAnswerForValue(releasedValue(new Date(now), notice), notice.closedAt + EXIT_NOTICE_DAYS * DAY), { kind: "gone" });

  part("One read of the address");
  is("a store is made", (await claimHandle("mover@example.com", "moving-shop", "Moving", "")).ok, true);
  const live = await handleLookup("moving-shop");
  is("a live address: its store, nothing released", [live.store?.handle, live.released], ["moving-shop", null]);
  is("storeForHandle finds the same store", (await storeForHandle("moving-shop"))?.handle, "moving-shop");
  const mover = await storeForEmail("mover@example.com");
  await closeStoreRecord({ ...mover!, exitNotice: notice });
  const before = redis.pipeline.bind(redis);
  let reads = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => { reads += commands.length; return before(commands); }) as typeof redis.pipeline;
  const closed = await handleLookup("moving-shop");
  redis.pipeline = before;
  is("a closed address: no store, its released value", [closed.store, typeof closed.released === "string"], [null, true]);
  is("read with one command", reads, 1);
  is("which carries the notice", exitAnswerForValue(closed.released, now).kind, "moved");
  is("storeForHandle: no store, as before", await storeForHandle("moving-shop"), null);
  is("a free address: nothing", await handleLookup("never-taken"), { store: null, released: null });
  is("a malformed address: nothing", await handleLookup("x"), { store: null, released: null });

  part("What the visitor reads");
  const html = renderToStaticMarkup(createElement(MovedNotice, { to: notice.to, host: notice.host, until: Date.UTC(2027, 2, 1) }));
  is("one heading", (html.match(/<h1[\s>]/g) ?? []).length, 1);
  is("which says the store moved", /<h1[^>]*>This store has moved<\/h1>/.test(html), true);
  is("the new host is the link's text", /<a [^>]*href="https:\/\/example.com\/shop"[^>]*>[^<]*example\.com[^<]*<\/a>/.test(html), true);
  is("the link stays in this window", /target=/.test(html), false);
  is("and passes nothing of this page on", /rel="[^"]*noreferrer[^"]*"/.test(html) && /rel="[^"]*nofollow[^"]*"/.test(html), true);
  is("the end of the notice, as a date", html.includes("March 1, 2027"), true);
  is("says the new site was not checked", html.includes("Marktmorgen did not check"), true);
  is("no other address on the page leads off the site", (html.match(/href="https?:/g) ?? []).length, 1);

  done();
})();
