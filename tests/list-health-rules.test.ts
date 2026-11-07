/**
 * How far a store's list email is from its pause, and the terms explained in
 * place (570 [DR1], unit 1; lib/list-health-rules.ts; added 4 November 2026).
 * Pure: nothing is read here. Checked:
 *
 *   - room before the pause: adding exactly that many reaches overTheLine,
 *     for the right reason, one fewer does not; at the level (no pause set),
 *     the next notice of either kind pauses, as pauseIfOver does after every
 *     count: 1 for both; checked in every state of a grid of counts; null
 *     where nothing was sent or the counts cannot be read;
 *   - roomLine's three outputs: a distance, at the line, nothing to say;
 *   - the terms, the honest sentence, and that none claims an inbox or spam
 *     folder outcome.
 */
import { overTheLine } from "@/lib/mail-health";
import { TERMS, roomBeforePause, roomLine } from "@/lib/list-health-rules";
import { done, is, part } from "./check";

const h = (sent: number, bounced = 0, complained = 0) => ({ sent, bounced, complained });
const SENTS = [1, 10, 30, 100, 625, 1000, 1250, 5000, 6250, 7500, 40000];

function main(): void {
  part("Room before the pause");
  let offByOne = true;
  let reasonRight = true;
  for (const sent of SENTS) {
    for (const start of [0, 1, 5, 12, 24]) {
      const b = Math.min(start, sent);
      const room = roomBeforePause(h(sent, b));
      if (room.bounces !== null && !room.atLevel) {
        const hit = overTheLine(h(sent, b + room.bounces));
        if (!hit || hit.reason !== "bounces") reasonRight = false;
        if (room.bounces > 0 && overTheLine(h(sent, b + room.bounces - 1))) offByOne = false;
      }
      const roomC = roomBeforePause(h(sent, 0, b));
      if (roomC.complaints !== null && !roomC.atLevel) {
        const hit = overTheLine(h(sent, 0, b + roomC.complaints));
        if (!hit || hit.reason !== "complaints") reasonRight = false;
        if (roomC.complaints > 0 && overTheLine(h(sent, 0, b + roomC.complaints - 1))) offByOne = false;
      }
    }
  }
  is("adding exactly the room reaches the pause, for the right reason", reasonRight, true);
  is("one fewer does not", offByOne, true);
  is("1,000 sent, 10 bounced, 2 reports: 15 bounces and 3 reports to go", roomBeforePause(h(1000, 10, 2)), { bounces: 15, complaints: 3, atLevel: false });
  is("2,000 sent: 40 bounces (2% beats the floor of 25); 7,500 sent: 6 reports", [roomBeforePause(h(2000)).bounces, roomBeforePause(h(7500)).complaints], [40, 6]);
  const next = { bounces: 1, complaints: 1, atLevel: true };
  is("already at a line, no pause set: the next of either kind pauses", roomBeforePause(h(1000, 30, 6)), next);
  is("at the bounce line only: the next spam report pauses too, as overTheLine then answers bounces", [roomBeforePause(h(1000, 25, 1)), overTheLine(h(1000, 25, 2))?.reason], [next, "bounces"]);
  is("at the spam line only: the next bounce pauses too", [roomBeforePause(h(5000, 0, 5)), overTheLine(h(5000, 1, 5))?.reason], [next, "complaints"]);
  is("never 0 or negative", roomBeforePause(h(1000, 900, 900)), next);
  is("a floor above what was sent is still reachable: late bounces count (20 sent, 3 bounced: 22 more)", roomBeforePause(h(20, 3, 1)), { bounces: 22, complaints: 4, atLevel: false });
  // A spam report or a bounce can arrive days after its email, and counting starts again after a pause: counts over what was sent are real.
  const late = roomBeforePause(h(3, 0, 4));
  is("more reports than emails sent: the room is still said", late.complaints !== null && late.bounces !== null, true);
  is("and that many more reports pauses, one fewer does not", [overTheLine(h(3, 0, 4 + (late.complaints ?? 0)))?.reason ?? null, (late.complaints ?? 0) > 0 ? overTheLine(h(3, 0, 3 + (late.complaints ?? 0))) : null], ["complaints", null]);
  const both = roomBeforePause(h(20, 24, 4));
  is("bounces over what was sent: both measures said, none dropped", [both.bounces, both.complaints].every((n) => n !== null), true);
  const none = { bounces: null, complaints: null, atLevel: false };
  is(
    "nothing sent or unreadable counts: null both",
    [roomBeforePause(h(0)), roomBeforePause(null), roomBeforePause(undefined), roomBeforePause(h(-5)), roomBeforePause(h(10, Number.NaN)), roomBeforePause(h(1.5))],
    [none, none, none, none, none, none],
  );

  part("Room in every state, against the pause");
  // pauseIfOver runs after every counted notice and pauses when overTheLine answers: the room must be exactly the notices that make it answer.
  let everyState = true;
  let checked = 0;
  for (const sent of [1, 3, 20, 100, 250, 1000, 1249, 1250, 6249, 6250, 40000]) {
    for (const bounced of [0, 1, 4, 12, 13, 19, 20, 24, 25, 26, 799, 800, 1000]) {
      for (const complained of [0, 1, 2, 3, 4, 5, 6, 31, 32, 40]) {
        checked += 1;
        const now = h(sent, bounced, complained);
        const room = roomBeforePause(now);
        const over = overTheLine(now) !== null;
        if (room.atLevel !== over || room.bounces === null || room.complaints === null) { everyState = false; continue; }
        if (over) {
          if (room.bounces !== 1 || room.complaints !== 1) everyState = false;
          continue;
        }
        if (!overTheLine(h(sent, bounced + room.bounces, complained)) || !overTheLine(h(sent, bounced, complained + room.complaints))) everyState = false;
        if (room.bounces > 1 && overTheLine(h(sent, bounced + room.bounces - 1, complained))) everyState = false;
        if (room.complaints > 1 && overTheLine(h(sent, bounced, complained + room.complaints - 1))) everyState = false;
        if (room.bounces < 1 || room.complaints < 1) everyState = false;
      }
    }
  }
  is(`${checked} states: at the level exactly when overTheLine says so; otherwise that many more of one kind pauses, one fewer does not`, everyState, true);

  part("Room line");
  is("a distance, both measures", roomLine(roomBeforePause(h(1000, 4))), "At this many emails, 21 more bounces or 5 more spam reports would pause it.");
  is("a distance, singular", roomLine({ bounces: 1, complaints: 1, atLevel: false }), "At this many emails, 1 more bounce or 1 more spam report would pause it.");
  is("a distance, a measure far from its line still said", roomLine(roomBeforePause(h(20, 3, 1))), "At this many emails, 22 more bounces or 4 more spam reports would pause it.");
  is("thousands written as thousands", roomLine({ bounces: 1200, complaints: null, atLevel: false }), "At this many emails, 1,200 more bounces would pause it.");
  is("at the line with no pause set: the next of either kind pauses, as KB20's advice says", roomLine(roomBeforePause(h(1000, 30))), "Email to your list is at the level that pauses it: the next bounce or spam report from a new address pauses it, unless more email goes out first.");
  is("nothing to say when nothing was sent", roomLine(roomBeforePause(h(0))), "");

  part("Terms");
  is("bounce (hard and soft), spam complaint, delivered and the honest sentence", Object.keys(TERMS), ["bounce", "spamComplaint", "delivered", "spamUnknown"]);
  is("hard and soft both explained", /hard bounce/.test(TERMS.bounce) && /soft bounce/.test(TERMS.bounce), true);
  is("delivered is the server accepting it, not the inbox", /server accepted/.test(TERMS.delivered) && /does not tell us whether/.test(TERMS.delivered), true);
  is("the honest sentence says no one can know, and names the signals", TERMS.spamUnknown, "No email service can know for sure whether an email went to spam, because Gmail, Outlook and other providers do not tell the sender; the signals on this page are spam complaints, bounces for good and the visits and sales that links in your emails bring.");
  is("no clicks named: the page counts visits its links bring, not clicks", /click/i.test(TERMS.spamUnknown), false);
  const words = [...Object.values(TERMS), roomLine({ bounces: 3, complaints: 2, atLevel: false }), roomLine({ bounces: 1, complaints: 1, atLevel: true })];
  is("inbox or went to spam only ever in a negative sentence", words.every((text) => !/inbox|went to spam|spam folder/i.test(text) || /\b(no|not|cannot)\b/i.test(text)), true);
  is("one sentence each", Object.values(TERMS).every((text) => text.split(/\.\s/).length === 1 && text.endsWith(".")), true);
  is("no open count anywhere", words.every((text) => !/\bopen(ed|s)?\b/i.test(text)), true);

  done();
}

main();
