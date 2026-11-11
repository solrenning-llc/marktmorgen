/**
 * The totals of a poll, read for its creator in the studio (125
 * [F2-EMAIL-POLLS], unit 7c: lib/email-poll-results.ts, the mail route's
 * "poll_results" and pollResultsUnits in lib/email-polls.ts).
 *
 * What fails here:
 *   - another store's email read, or an email with no poll answered as one;
 *   - the votes read before the studio requests their size needs are taken
 *     (then nothing is read and the creator is told why);
 *   - totals with a vote that does not read, or from a list that could not
 *     be read, shown as a count (rule 24);
 *   - anything that names who answered.
 */
import { MAX_LEADS } from "@/lib/contact-rules";
import { studioPollResults } from "@/lib/email-poll-results";
import { POLL_VALUE_BYTES, pollResultsUnits } from "@/lib/email-polls";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const sec = (ms: number) => Math.floor(ms / 1000);
const now = Date.now();
const ID = "0123456789abcdef01234567";
const poll = { question: "Which class next?", options: ["Glazing", "Trimming", "Firing"], days: 7 };
const record = (extra: Record<string, unknown> = {}) => ({
  id: ID, listId: "list1", handle: "clayhouse", subject: "News", body: "Hello", productId: null, notProductId: null,
  who: "all", narrow: null, status: "sent", createdAt: sec(now - DAY), sendAt: sec(now - DAY), finishedAt: sec(now - DAY),
  total: 20_000, sent: 20_000, note: "", failures: 0, listed: true, tagged: true, test: null, poll, ...extra,
});
const put = (extra: Record<string, unknown> = {}) => redis.run(["SET", `nl:mail:bc:${ID}`, JSON.stringify(record(extra))]);
const shop = { handle: "clayhouse", listId: "list1" } as Store;
let asked: number[] = [];
const take = async (units: number) => { asked.push(units); return true; };

(async () => {
  part("Units by the email's size, never fewer than one");
  is("an email to nobody: one", pollResultsUnits(0), 1);
  is("grows with the people it went to", pollResultsUnits(20_000) > pollResultsUnits(1_000), true);
  is("each vote's bytes, at least what HVALS answers for one", POLL_VALUE_BYTES >= 6, true);
  is("the largest list: a finite number", Number.isSafeInteger(pollResultsUnits(MAX_LEADS)), true);

  part("Totals, after the units are taken");
  redis.clear();
  put();
  redis.run(["HSET", `nl:mail:bc:${ID}:poll`, "0", "1", "1", "1", "7", "2", "19999", "0"]);
  asked = [];
  const read = await studioPollResults(shop, ID, take, now);
  is("the counts by answer, the votes, open and its end", read, { state: "ok", counts: [1, 2, 1], votes: 4, open: true, closesAt: sec(now - DAY) * 1000 + 7 * DAY });
  is("the units for its size taken once, before reading", asked, [pollResultsUnits(20_000)]);
  is("nothing that names anyone", Object.keys(read).sort(), ["closesAt", "counts", "open", "state", "votes"]);
  put({ sendAt: sec(now - 8 * DAY) });
  is("closed: said so", (await studioPollResults(shop, ID, take, now) as { open?: boolean }).open, false);

  part("Not read");
  put();
  asked = [];
  is("the studio's month is spent: nothing read, said why", await studioPollResults(shop, ID, async () => false, now), { state: "used" });
  is("another store's email: none", await studioPollResults({ ...shop, listId: "list2" } as Store, ID, take, now), { state: "none" });
  put({ poll: undefined });
  is("an email with no poll: none", await studioPollResults(shop, ID, take, now), { state: "none" });
  is("and no units taken for any of them", asked, []);
  put({ status: "scheduled", sent: 0 });
  is("not gone out: none yet", await studioPollResults(shop, ID, take, now), { state: "none" });
  // It waits with part of its list sent (daily portions, a subject test): its totals so far are read (review, ALTO).
  put({ status: "waiting", sent: 4 });
  is("waiting after some went out: read", (await studioPollResults(shop, ID, take, now)).state, "ok");
  is("an id that is not one", await studioPollResults(shop, "nope", take, now), { state: "none" });

  part("Unknown, never a count");
  put();
  redis.run(["HSET", `nl:mail:bc:${ID}:poll`, "3", "x"]);
  is("a vote that does not read", await studioPollResults(shop, ID, take, now), { state: "unknown" });
  redis.run(["SET", `nl:mail:bc:${ID}`, "{not json"]);
  is("a record that does not read", await studioPollResults(shop, ID, take, now), { state: "unknown" });
  put();
  is("the month could not be read", await studioPollResults(shop, ID, async () => { throw new Error("down"); }, now), { state: "unknown" });

  done();
})();
