/**
 * Nobody gets too many emails from one store (374 [SU7], unit 1;
 * lib/mail-frequency-rules.ts). Checked:
 *
 *   - the creator's gap: one email a day by default, a choice among a few
 *     longer gaps, never a shorter one; an unreadable setting is the
 *     strictest gap, never the default;
 *   - a remembered send is read only from its own exact mark; anything else
 *     is unknown, never "never sent";
 *   - the decision: service mail is never held; a send inside the gap is
 *     held until the gap ends; a mark from the future beyond the clock
 *     allowance is unknown; time is absolute, so a time zone or a clock
 *     change never opens a second send;
 *   - a change of setting never forgets a send (the mark lives as long as the
 *     longest gap);
 *   - a whole send: each person once, missing reads unknown, nobody added;
 *   - the words the creator reads in the preview.
 */
import {
  DAY_MS,
  MAIL_GAP_CHOICES,
  MAIL_GAP_DEFAULT,
  MAIL_GAP_KEEP_MS,
  MARK_CLOCK_ALLOWANCE_MS,
  decideSend,
  gapMs,
  gapWords,
  markValue,
  planSend,
  readLastSent,
  readMailGap,
  sparedWords,
  type LastSent,
} from "@/lib/mail-frequency-rules";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);
const HOUR = 3_600_000;
const at = (ms: number): LastSent => ({ kind: "at", at: ms });
const NONE: LastSent = { kind: "none" };
const UNKNOWN: LastSent = { kind: "unknown" };

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function main(): void {
  part("The creator's gap");
  is("one email a day is the default", MAIL_GAP_DEFAULT, 1);
  is("the choices are one, two, three and seven days, none shorter than a day", MAIL_GAP_CHOICES, [1, 2, 3, 7]);
  is("nothing saved yet reads as the default", readMailGap(undefined), 1);
  is("null saved reads as the default", readMailGap(null), 1);
  for (const n of [1, 2, 3, 7]) is(`${n} saved reads as ${n}`, readMailGap(n), n);
  is("a saved string of a choice reads as it (Redis keeps strings)", readMailGap("3"), 3);
  for (const bad of [0, 0.5, 4, 14, -1, Number.NaN, Infinity, "1.0", " 1", "01", "", "seven", {}, [], true]) {
    is(`an unreadable setting ${JSON.stringify(bad) ?? String(bad)} is unknown, never the default`, readMailGap(bad), "unknown");
  }
  is("an unknown setting is held to the longest gap", gapMs("unknown"), 7 * DAY_MS);
  is("one day is 24 hours exactly", gapMs(1), 24 * HOUR);
  is("a mark is kept as long as the longest gap", MAIL_GAP_KEEP_MS, 7 * DAY_MS);
  is("no gap is longer than the mark is kept", MAIL_GAP_CHOICES.every((g) => gapMs(g) <= MAIL_GAP_KEEP_MS), true);

  part("Reading a remembered send");
  is("no mark is a confirmed 'never sent'", readLastSent(null), NONE);
  is("a mark of digits is the time it was sent", readLastSent(String(NOW)), at(NOW));
  for (const bad of [undefined, "", "0", "-5", "12.5", "1e12", " 123", "123 ", "0123", "9".repeat(17), "NaN", 123, {}, [], true, "OK"]) {
    is(`reply ${JSON.stringify(bad) ?? "undefined"} is unknown, never 'never sent'`, readLastSent(bad), UNKNOWN);
  }
  is("markValue writes what readLastSent reads", readLastSent(markValue(NOW)), at(NOW));
  is("markValue refuses a time that is not a positive whole number", [0, -1, 1.5, Number.NaN, Infinity].map((v) => throws(() => markValue(v))), [true, true, true, true, true]);

  part("One person, one send");
  is("never sent: sent", decideSend("marketing", NONE, NOW, 1), { kind: "send" });
  is("an automation counts the same as a one-off email", decideSend("automation", NONE, NOW, 1), { kind: "send" });
  is("sent 23 hours ago with one a day: held until 24 hours after", decideSend("marketing", at(NOW - 23 * HOUR), NOW, 1), { kind: "held", until: NOW + HOUR });
  is("sent exactly 24 hours ago: sent", decideSend("marketing", at(NOW - 24 * HOUR), NOW, 1), { kind: "send" });
  is("sent 24 hours less one millisecond ago: held", decideSend("marketing", at(NOW - 24 * HOUR + 1), NOW, 1).kind, "held");
  is("sent two days ago with a weekly gap: held five more days", decideSend("automation", at(NOW - 2 * DAY_MS), NOW, 7), { kind: "held", until: NOW + 5 * DAY_MS });
  is("an unreadable send is unknown: never sent as if it never happened", decideSend("marketing", UNKNOWN, NOW, 1), { kind: "unknown" });
  is("an unknown setting holds to the longest gap", decideSend("marketing", at(NOW - 3 * DAY_MS), NOW, "unknown"), { kind: "held", until: NOW + 4 * DAY_MS });
  is("a mark a little ahead (another server's clock) is held from its own time", decideSend("marketing", at(NOW + 60_000), NOW, 1), { kind: "held", until: NOW + 60_000 + DAY_MS });
  is("a mark ahead by exactly the allowance is still held", decideSend("marketing", at(NOW + MARK_CLOCK_ALLOWANCE_MS), NOW, 1).kind, "held");
  is("a mark further ahead than the allowance is unknown", decideSend("marketing", at(NOW + MARK_CLOCK_ALLOWANCE_MS + 1), NOW, 1), { kind: "unknown" });
  is("a clock that cannot be read is unknown", [Number.NaN, -1, 1.5, Infinity].map((n) => decideSend("marketing", NONE, n, 1).kind), ["unknown", "unknown", "unknown", "unknown"]);
  is("service mail (a receipt, a sign-in link) is never held", decideSend("service", at(NOW - HOUR), NOW, 7), { kind: "send" });
  is("service mail is never held even when the read failed", decideSend("service", UNKNOWN, NOW, "unknown"), { kind: "send" });

  part("Time zones and clock changes do not open a second send");
  // 2026-11-01 06:00 UTC is 01:00 in New York, the hour the clocks went back. A send at 00:30 local (04:30 UTC)
  // and a try at 01:30 local after the change (06:30 UTC) are two hours apart, not one: still held.
  const beforeChange = Date.UTC(2026, 10, 1, 4, 30);
  const afterChange = Date.UTC(2026, 10, 1, 6, 30);
  is("across the night the clocks went back, the gap is measured in real hours", decideSend("marketing", at(beforeChange), afterChange, 1), { kind: "held", until: beforeChange + DAY_MS });
  is("a send late one local evening holds the next local morning", decideSend("marketing", at(Date.UTC(2026, 10, 10, 23, 50)), Date.UTC(2026, 10, 11, 8, 0), 1).kind, "held");

  part("A change of setting never forgets a send");
  const sent = NOW - 2 * DAY_MS;
  is("weekly: held", decideSend("marketing", at(sent), NOW, 7).kind, "held");
  is("changed to daily: the send two days ago is still read, and its gap has passed", decideSend("marketing", at(sent), NOW, 1).kind, "send");
  is("changed back to weekly the next hour: the same send still holds", decideSend("marketing", at(sent), NOW + HOUR, 7).kind, "held");

  part("A whole send");
  const lasts = new Map<string, LastSent>([
    ["a", NONE],
    ["b", at(NOW - HOUR)],
    ["c", UNKNOWN],
    ["d", at(NOW - 2 * DAY_MS)],
  ]);
  const plan = planSend("marketing", ["a", "b", "c", "d", "a", "e"], lasts, NOW, 1);
  is("never-sent and past-gap people are sent", plan.send, ["a", "d"]);
  is("a person sent within the gap is held", plan.held, ["b"]);
  is("an unreadable person and a person with no read at all are unknown", plan.unknown, ["c", "e"]);
  is("the same person twice is counted once", plan.repeated, 1);
  is("nobody is added: every person sent was asked for", plan.send.every((p) => ["a", "b", "c", "d", "e"].includes(p)), true);
  const service = planSend("service", ["b", "c", "e"], lasts, NOW, "unknown");
  is("a service send holds nobody", [service.send, service.held, service.unknown], [["b", "c", "e"], [], []]);
  const marketingUnknown = planSend("marketing", ["a", "d"], lasts, NOW, "unknown");
  is("with the setting unreadable, a send two days ago is held", [marketingUnknown.send, marketingUnknown.held], [["a"], ["d"]]);
  is("an empty send plans nothing", planSend("automation", [], lasts, NOW, 1), { send: [], held: [], unknown: [], repeated: 0 });
  is("a send at an unreadable time sends nobody", planSend("marketing", ["a", "d"], lasts, Number.NaN, 1).unknown, ["a", "d"]);

  part("What the creator reads");
  is("gap words, one a day", gapWords(1), "At most one email a day to each person");
  is("gap words, a week", gapWords(7), "At most one email a week to each person");
  is("gap words, two days", gapWords(2), "At most one email every 2 days to each person");
  is("gap words, unknown", gapWords("unknown"), "We could not read your setting, so this send uses the longest gap: one email a week");
  is("nothing held: no line", sparedWords({ held: 0, unknown: 0 }, 1), []);
  is(
    "held, one",
    sparedWords({ held: 1, unknown: 0 }, 1),
    ["1 person will not get this email because they got one from you in the last day."],
  );
  is(
    "held, many, weekly",
    sparedWords({ held: 1250, unknown: 0 }, 7),
    ["1,250 people will not get this email because they got one from you in the last week."],
  );
  is(
    "unknown is said on its own line, never as 'already emailed'",
    sparedWords({ held: 0, unknown: 3 }, 2),
    ["3 people will not get this email because we could not check when they last got one. They are not counted against your emails."],
  );
  is(
    "both",
    sparedWords({ held: 2, unknown: 1 }, 3),
    [
      "2 people will not get this email because they got one from you in the last 3 days.",
      "1 person will not get this email because we could not check when they last got one. They are not counted against your emails.",
    ],
  );
  is("no word of urgency or blame", sparedWords({ held: 5, unknown: 5 }, 1).some((l) => /hurry|now!|spam|too many|warning/i.test(l)), false);

  done();
}

main();
