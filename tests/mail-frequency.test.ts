/**
 * The per-person email gap, kept in the database (374 [SU7], unit 2;
 * lib/mail-frequency.ts), against the in-memory Redis. Checked:
 *
 *   - service mail asks the database nothing and holds nobody;
 *   - a person sent once is held for the gap and sent again after it;
 *   - two sends at the same time give the person one email, never two;
 *   - the send is recorded BEFORE it goes, so a send whose outcome is
 *     uncertain still counts as sent, and a person whose record did not
 *     come back is not sent;
 *   - a failed or odd read is unknown, never "never sent"; an odd reply to
 *     the record is read back, and only our own value is ours;
 *   - the ceiling: checks are taken from the store's month before any read,
 *     a plan without list email checks nobody, a send past the ceiling reads
 *     nothing and gives its checks back;
 *   - keys hold no address and live no longer than the longest gap.
 */
import { DAY_MS, MAIL_GAP_KEEP_MS } from "@/lib/mail-frequency-rules";
import {
  MAIL_GAP_CHECKS_PER_EMAIL,
  MAIL_GAP_CHECK_WINDOW_SECONDS,
  MAIL_GAP_KEEP_SECONDS,
  admitForSend,
  mailGapCheckLimit,
} from "@/lib/mail-frequency";
import { monthlyEmails } from "@/lib/plan";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 11, 15);
const STORE = "store_1";

type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;
const realPipeline: Pipe = store.pipeline.bind(store);
let sent: (string | number)[][] = [];
function watch(replace?: (commands: (string | number)[][]) => Promise<unknown[]> | null): void {
  (store as unknown as { pipeline: Pipe }).pipeline = async (commands) => {
    sent.push(...commands);
    const other = replace?.(commands);
    return other ?? realPipeline(commands);
  };
}
function reset(): void {
  store.clear();
  sent = [];
  watch();
}

const admit = (people: string[], now: number, over: Partial<Parameters<typeof admitForSend>[0]> = {}) =>
  admitForSend({ store: STORE, tier: "pro", kind: "marketing", people, setting: 1, now, ...over });

async function main(): Promise<void> {
  part("The ceiling's figures");
  is("two checks for every monthly email of the plan", MAIL_GAP_CHECKS_PER_EMAIL, 2);
  is("Studio's checks", mailGapCheckLimit("pro"), 2 * monthlyEmails("pro"));
  is("the Store plan has no list email, so no checks", mailGapCheckLimit("creator"), 0);
  is("records live as long as the longest gap", MAIL_GAP_KEEP_SECONDS * 1000, MAIL_GAP_KEEP_MS);
  is("the month's count outlives a calendar month", MAIL_GAP_CHECK_WINDOW_SECONDS >= 31 * 86_400, true);

  part("Service mail");
  reset();
  is("sent to everyone", await admit(["a@x.test", "b@x.test"], T0, { kind: "service" }), { send: ["a@x.test", "b@x.test"], held: [], unknown: [], repeated: 0, refused: false });
  is("without asking the database", sent.length, 0);

  part("Held for the gap, sent after it");
  reset();
  const first = await admit(["a@x.test", "b@x.test", "a@x.test"], T0);
  is("the first send goes to each person once", [first.send, first.repeated], [["a@x.test", "b@x.test"], 1]);
  is("no key holds an address", store.keys().some((k) => k.includes("@") || k.includes("x.test")), false);
  is("every key is in the family nl:mgap:", store.keys().every((k) => k.startsWith("nl:mgap:")), true);
  const ttls = await realPipeline(store.keys().filter((k) => !k.startsWith("nl:mgap:checks:")).map((k) => ["TTL", k]));
  is("every record ends within seven days", ttls.every((t) => typeof t === "number" && t > 0 && t <= MAIL_GAP_KEEP_SECONDS), true);
  const again = await admit(["a@x.test", "c@x.test"], T0 + HOUR);
  is("an hour later: a is held, c (never sent) is sent", [again.send, again.held], [["c@x.test"], ["a@x.test"]]);
  store.advance(DAY_MS);
  const nextDay = await admit(["a@x.test"], T0 + DAY_MS);
  is("a day later: a is sent again", nextDay.send, ["a@x.test"]);
  const weekly = await admit(["a@x.test"], T0 + DAY_MS + 2 * DAY_MS, { setting: 7 });
  is("the creator moves to weekly: the send two days ago still holds", weekly.held, ["a@x.test"]);

  part("Two sends at the same time");
  reset();
  const [one, two] = await Promise.all([admit(["a@x.test"], T0), admit(["a@x.test"], T0)]);
  is("exactly one of them sends to the person", one.send.length + two.send.length, 1);
  is("the other holds the person", one.held.length + two.held.length, 1);

  part("Recorded before sending: no record, no send");
  reset();
  // The record of when the person was sent fails to answer: the person is not sent now (Claude 1 on #3636), and the
  // gate taken holds them next time.
  watch((commands) => (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:mgap:last:")) ? Promise.reject(new Error("timeout")) : null));
  is("not sent without its record: unknown", (await admit(["a@x.test"], T0)).unknown, ["a@x.test"]);
  watch();
  is("and the next send an hour later holds the person", (await admit(["a@x.test"], T0 + HOUR)).held, ["a@x.test"]);

  part("Unknown is never 'never sent'");
  reset();
  watch((commands) => (commands[0]?.[0] === "GET" && String(commands[0][1]).startsWith("nl:mgap:last:") ? Promise.reject(new Error("down")) : null));
  const down = await admit(["a@x.test", "b@x.test"], T0);
  is("a failed read: everyone unknown, nobody sent", [down.send, down.unknown], [[], ["a@x.test", "b@x.test"]]);
  is("and nothing recorded for them", store.keys().filter((k) => !k.startsWith("nl:mgap:checks:")), []);
  reset();
  watch((commands) => (commands[0]?.[0] === "GET" && String(commands[0][1]).startsWith("nl:mgap:last:") ? Promise.resolve(commands.map(() => "garbage")) : null));
  is("an odd stored value: unknown", (await admit(["a@x.test"], T0)).unknown, ["a@x.test"]);
  reset();
  watch((commands) => (commands[0]?.[0] === "GET" && String(commands[0][1]).startsWith("nl:mgap:last:") ? Promise.resolve([null]) : null));
  is("a reply of the wrong length: unknown", (await admit(["a@x.test", "b@x.test"], T0)).unknown, ["a@x.test", "b@x.test"]);

  part("An odd reply to the record is read back");
  reset();
  let gateWritten = false;
  watch((commands) => {
    if (commands.every((c) => c[0] === "SET" && String(c[1]).startsWith("nl:mgap:gate:"))) {
      gateWritten = true;
      return realPipeline(commands).then((replies) => replies.map(() => "QUEUED"));
    }
    return null;
  });
  is("the write landed with our value: ours, sent", (await admit(["a@x.test"], T0)).send, ["a@x.test"]);
  is("(the write was made)", gateWritten, true);
  reset();
  watch((commands) => (commands.every((c) => c[0] === "SET" && String(c[1]).startsWith("nl:mgap:gate:")) ? Promise.resolve(commands.map(() => 1)) : null));
  is("the write did not land and nothing is there: unknown, not sent", (await admit(["a@x.test"], T0)).unknown, ["a@x.test"]);
  reset();
  watch((commands) => {
    if (commands.every((c) => c[0] === "SET" && String(c[1]).startsWith("nl:mgap:gate:"))) {
      return Promise.all(commands.map((c) => realPipeline([["SET", c[1], "someone-else", "EX", 60]]))).then(() => commands.map(() => "odd"));
    }
    return null;
  });
  is("another run's value is there: held, not sent", (await admit(["a@x.test"], T0)).held, ["a@x.test"]);

  part("The ceiling, before any read");
  reset();
  const none = await admit(["a@x.test"], T0, { tier: "creator" });
  is("the Store plan: nobody checked, nobody sent, said as refused", [none.send, none.unknown, none.refused], [[], ["a@x.test"], true]);
  is("and nothing read", sent.filter((c) => c[0] === "GET").length, 0);
  reset();
  const limit = mailGapCheckLimit("pro");
  const many = Array.from({ length: limit + 1 }, (_, i) => `p${i}`);
  const over = await admit(many, T0);
  is("a send larger than the month's checks: refused, all unknown", [over.refused, over.send.length, over.unknown.length], [true, 0, limit + 1]);
  is("without asking the database anything", sent.length, 0);
  reset();
  const counter = `nl:mgap:checks:${STORE}:2026-11`;
  await realPipeline([["SET", counter, String(limit), "EX", 60]]);
  const full = await admit(["a@x.test", "b@x.test"], T0);
  is("a month whose checks are spent: refused, all unknown", [full.refused, full.unknown], [true, ["a@x.test", "b@x.test"]]);
  is("its checks are given back", (await realPipeline([["GET", counter]]))[0], String(limit));
  is("no person's record was read", sent.filter((c) => c[0] === "GET").length, 0);
  await realPipeline([["SET", counter, String(limit - 1), "EX", 60]]);
  const fits = await admit(["a@x.test"], T0);
  is("one check left: the send still goes", [fits.refused, fits.send], [false, ["a@x.test"]]);
  reset();
  watch((commands) => (commands.some((c) => c[0] === "INCRBY") ? Promise.resolve(commands.map(() => "?")) : null));
  is("an unreadable count: refused, nobody sent", await admit(["a@x.test"], T0), { send: [], held: [], unknown: ["a@x.test"], repeated: 0, refused: true });
  reset();
  is("an unreadable time: nobody sent, nothing asked", [(await admit(["a@x.test"], Number.NaN)).unknown, sent.length], [["a@x.test"], 0]);

  part("One person in any letter case is one person (Claude 1 on #3636)");
  reset();
  is("sent once", (await admit(["Ann@Example.test"], T0)).send, ["Ann@Example.test"]);
  is("an hour later, the same address in lower case: held", (await admit(["ann@example.test"], T0 + HOUR)).held, ["ann@example.test"]);

  part("A record of the send that did not come back: the person is not sent, so never twice (Claude 1 on #3636)");
  reset();
  watch((commands) => (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:mgap:last:")) ? Promise.resolve(commands.map(() => null)) : null));
  is("the record refused: the person is unknown, not sent", await admit(["b@x.test"], T0), { send: [], held: [], unknown: ["b@x.test"], repeated: 0, refused: false });
  reset();
  watch((commands) => (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:mgap:last:")) ? Promise.reject(new Error("connection lost")) : null));
  is("the record lost: the person is unknown, not sent", (await admit(["b@x.test"], T0)).send, []);

  part("Named among the records about a person, gone by itself (Claude 1 on #3636)");
  const { PERSON_DATA } = await import("@/lib/person-data");
  const line = PERSON_DATA.find((d) => d.file === "lib/mail-frequency.ts");
  is("lib/person-data.ts names it, kept no longer than the longest gap", [line?.how, line && "days" in line ? line.days : null], ["expires", MAIL_GAP_KEEP_SECONDS / 86_400]);

  done();
}

void main();
