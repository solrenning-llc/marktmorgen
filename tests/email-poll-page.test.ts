/**
 * The page a recipient's poll link opens (125 [F2-EMAIL-POLLS], unit 5:
 * pollPage in lib/email-poll-vote.ts, the words in lib/buyer-words/polls.ts).
 *
 * What fails here:
 *   - opening the page keeping, changing or taking back a vote (mail
 *     scanners open every link: only the press of Confirm counts);
 *   - a link that is not that recipient's costing a database read, or
 *     showing the poll;
 *   - the page read without its reads counted first from the store's month
 *     (then the store is resting and the poll is not shown);
 *   - anything that does not read shown as a poll, closed or refused,
 *     never "unknown" (rule 24);
 *   - words missing in a language a store sells in, or words that say a
 *     vote was counted when it was not.
 */
import { pollLinkPart } from "@/lib/email-poll-links";
import { pollPage } from "@/lib/email-poll-vote";
import * as route from "@/app/api/mail/poll/route";
import { pollWords } from "@/lib/buyer-words/polls";
import { LANGUAGES } from "@/lib/store-language";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const now = Date.now();
const ID = "0123456789abcdef01234567";
const poll = { question: "Which class next?", options: ["Glazing", "Trimming", "Firing"], days: 7 };
const record = (extra: Record<string, unknown> = {}) => ({
  id: ID, listId: "list1", handle: "clayhouse", subject: "News", body: "Hello", productId: null, notProductId: null,
  who: "all", narrow: null, status: "sent", createdAt: now - DAY, sendAt: now - DAY, finishedAt: now - DAY + 60_000,
  total: 10, sent: 10, note: "", failures: 0, listed: true, tagged: true, test: null, poll, ...extra,
});
const put = (extra: Record<string, unknown> = {}) => redis.run(["SET", `nl:mail:bc:${ID}`, JSON.stringify(record(extra))]);
const votes = () => redis.run(["HGETALL", `nl:mail:bc:${ID}:poll`]);
const shop = { handle: "clayhouse", name: "Clay House", language: "fr", mail: { fromName: "Ana at Clay House" } } as unknown as Store;

let reads = 0;
let taken = 0;
const deps = (over: Record<string, unknown> = {}) => ({
  loadStore: async (handle: string) => { reads += 1; return handle === "clayhouse" ? shop : null; },
  take: async () => { taken += 1; return true; },
  ...over,
});
const link = (place: number) => pollLinkPart(ID, place) as string;

(async () => {
  redis.clear();
  put();

  part("An open poll: shown, nothing kept");
  taken = 0;
  const open = await pollPage({ broadcastId: ID, link: link(2), now }, deps());
  is("open, with the poll, who sent it, its language and its end", open, { state: "open", poll, sender: "Ana at Clay House", language: "fr", closesAt: now - DAY + 7 * DAY });
  is("the store's month taken from first, once", taken, 1);
  is("opening keeps no vote", votes(), []);
  redis.run(["HSET", `nl:mail:bc:${ID}:poll`, "2", "1"]);
  await pollPage({ broadcastId: ID, link: link(2), now }, deps());
  is("opening again changes no vote", votes(), ["2", "1"]);
  is("the store's name when it has no sender name", (await pollPage({ broadcastId: ID, link: link(2), now }, deps({ loadStore: async () => ({ ...shop, mail: undefined }) }))), { state: "open", poll, sender: "Clay House", language: "fr", closesAt: now - DAY + 7 * DAY });

  part("Refused with no read of the database");
  let calls = 0;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (commands) => { calls += 1; return pipeline(commands); };
  reads = 0;
  is("a link with a changed place", await pollPage({ broadcastId: ID, link: link(2).replace(/^2\./, "3."), now }, deps()), { state: "invalid" });
  is("no link", await pollPage({ broadcastId: ID, link: "", now }, deps()), { state: "invalid" });
  is("a broadcast id that is not one", await pollPage({ broadcastId: "x", link: link(2), now }, deps()), { state: "invalid" });
  is("no database command and no store read", [calls, reads], [0, 0]);
  redis.pipeline = pipeline;

  part("Refused after reading the broadcast");
  is("a place past the list", await pollPage({ broadcastId: ID, link: link(10), now }, deps()), { state: "invalid" });
  put({ poll: undefined });
  is("no poll", await pollPage({ broadcastId: ID, link: link(2), now }, deps()), { state: "invalid" });
  put({ status: "scheduled" });
  is("not gone out", await pollPage({ broadcastId: ID, link: link(2), now }, deps()), { state: "invalid" });

  part("Closed: said so, with its words");
  put({ sendAt: now - 8 * DAY });
  is("closed", await pollPage({ broadcastId: ID, link: link(2), now }, deps()), { state: "closed", poll, sender: "Ana at Clay House", language: "fr", closesAt: now - 8 * DAY + 7 * DAY });

  part("Resting and unknown");
  put();
  is("the month is spent: resting, the poll not shown", await pollPage({ broadcastId: ID, link: link(2), now }, deps({ take: async () => false })), { state: "resting", language: "fr" });
  is("the month could not be read", await pollPage({ broadcastId: ID, link: link(2), now }, deps({ take: async () => { throw new Error("down"); } })), { state: "unknown" });
  is("the store could not be read", await pollPage({ broadcastId: ID, link: link(2), now }, deps({ loadStore: async () => null })), { state: "unknown" });
  redis.run(["SET", `nl:mail:bc:${ID}`, "{not json"]);
  is("the record could not be read", await pollPage({ broadcastId: ID, link: link(2), now }, deps()), { state: "unknown" });
  put({ sendAt: now + DAY });
  is("a send time after now", await pollPage({ broadcastId: ID, link: link(2), now }, deps()), { state: "unknown" });

  part("Words in every language a store sells in");
  const en = pollWords("en");
  const keys = Object.keys(en).sort();
  for (const code of Object.keys(LANGUAGES)) {
    const w = pollWords(code);
    is(`${code}: every word`, Object.keys(w).sort(), keys);
    is(`${code}: none empty`, Object.values(w).every((v) => (typeof v === "function" ? String(v("X")).trim() : String(v).trim()).length > 0), true);
  }
  is("an unknown language: English", pollWords("xx"), en);
  is("opening says it counted nothing", /counted nothing/.test(en.openedNothing), true);
  is("not saved never says counted", /not counted|Nothing was counted/.test(en.notSaved), true);
  is("only totals, never who", /never who/.test(en.totalsOnly), true);

  part("A press from the page goes back to it with what happened");
  const press = async (query: string, form: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.set(k, v);
    return route.POST(new Request(`https://marktmorgen.com/api/mail/poll?${query}`, { method: "POST", body }));
  };
  const back = await press(`b=${ID}&k=${link(2).replace(/^2\./, "3.")}`, { a: "1", from: "page" });
  is("a 303 back to the page", back.status, 303);
  is("with the link and what happened, never a vote", back.headers.get("Location"), `https://marktmorgen.com/poll?b=${ID}&k=${encodeURIComponent(link(2).replace(/^2\./, "3."))}&done=invalid`);
  is("not cached", back.headers.get("Cache-Control"), "no-store");
  const odd = await press(`b=${encodeURIComponent("<x>")}&k=${link(2)}`, { a: "1", from: "page" });
  is("a broadcast id that is not one never goes into the address", odd.headers.get("Location"), "https://marktmorgen.com/poll?done=invalid");
  const plain = await press(`b=${ID}&k=${link(2).replace(/^2\./, "3.")}`, { a: "1" });
  is("without the page: plain words, as before", plain.status, 404);

  done();
})();
