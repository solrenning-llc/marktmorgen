/**
 * How far a store's list email is from its pause, and the terms explained in
 * place (570 [DR1], unit 1; lib/list-health-rules.ts; added 4 November 2026).
 * Pure: nothing is read here. Checked:
 *
 *   - room before the pause: adding exactly that many reaches overTheLine,
 *     for the right reason, one fewer does not; null where the floor cannot
 *     be reached, nothing was sent or the counts cannot be read;
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
      if (room.bounces !== null) {
        const hit = overTheLine(h(sent, b + room.bounces));
        if (!hit || hit.reason !== "bounces") reasonRight = false;
        if (room.bounces > 0 && overTheLine(h(sent, b + room.bounces - 1))) offByOne = false;
      }
      const roomC = roomBeforePause(h(sent, 0, b));
      if (roomC.complaints !== null) {
        const hit = overTheLine(h(sent, 0, b + roomC.complaints));
        if (!hit || hit.reason !== "complaints") reasonRight = false;
        if (roomC.complaints > 0 && overTheLine(h(sent, 0, b + roomC.complaints - 1))) offByOne = false;
      }
    }
  }
  is("adding exactly the room reaches the pause, for the right reason", reasonRight, true);
  is("one fewer does not", offByOne, true);
  is("1,000 sent, 10 bounced, 2 reports: 15 bounces and 3 reports to go", roomBeforePause(h(1000, 10, 2)), { bounces: 15, complaints: 3 });
  is("2,000 sent: 40 bounces (2% beats the floor of 25); 7,500 sent: 6 reports", [roomBeforePause(h(2000)).bounces, roomBeforePause(h(7500)).complaints], [40, 6]);
  is("already at a line: 0", roomBeforePause(h(1000, 30, 6)), { bounces: 0, complaints: 0 });
  is("never negative", roomBeforePause(h(1000, 900, 900)), { bounces: 0, complaints: 0 });
  is("floor out of reach at this many sent: null (20 sent cannot hold 25 bounces)", roomBeforePause(h(20, 3, 1)), { bounces: null, complaints: 4 });
  const none = { bounces: null, complaints: null };
  is(
    "nothing sent or unreadable counts: null both",
    [roomBeforePause(h(0)), roomBeforePause(null), roomBeforePause(undefined), roomBeforePause(h(-5)), roomBeforePause(h(10, Number.NaN)), roomBeforePause(h(1.5))],
    [none, none, none, none, none, none],
  );

  part("Room line");
  is("a distance, both measures", roomLine(roomBeforePause(h(1000, 4))), "At this many emails, 21 more bounces or 5 more spam reports would pause it.");
  is("a distance, singular", roomLine({ bounces: 1, complaints: 1 }), "At this many emails, 1 more bounce or 1 more spam report would pause it.");
  is("a distance, only the measure that can be reached", roomLine(roomBeforePause(h(20, 3, 1))), "At this many emails, 4 more spam reports would pause it.");
  is("thousands written as thousands", roomLine({ bounces: 1200, complaints: null }), "At this many emails, 1,200 more bounces would pause it.");
  is("at the line: the next one pauses", roomLine(roomBeforePause(h(1000, 30))), "It is at the level that pauses: the next bounce or spam report we hear about pauses email to your list.");
  is("nothing to say when neither line can be reached", [roomLine(roomBeforePause(h(0))), roomLine(roomBeforePause(h(3, 1, 1)))], ["", ""]);

  part("Terms");
  is("bounce (hard and soft), spam complaint, delivered and the honest sentence", Object.keys(TERMS), ["bounce", "spamComplaint", "delivered", "spamUnknown"]);
  is("hard and soft both explained", /hard bounce/.test(TERMS.bounce) && /soft bounce/.test(TERMS.bounce), true);
  is("delivered is the server accepting it, not the inbox", /server accepted/.test(TERMS.delivered) && /does not tell us whether/.test(TERMS.delivered), true);
  is("the honest sentence says no one can know, and names the signals", TERMS.spamUnknown, "No email service can know for sure whether an email went to spam, because Gmail, Outlook and other providers do not tell the sender; the signals shown here are spam complaints, bounces and clicks.");
  const words = [...Object.values(TERMS), roomLine({ bounces: 3, complaints: 2 }), roomLine({ bounces: 0, complaints: 2 })];
  is("inbox or went to spam only ever in a negative sentence", words.every((text) => !/inbox|went to spam|spam folder/i.test(text) || /\b(no|not|cannot)\b/i.test(text)), true);
  is("one sentence each", Object.values(TERMS).every((text) => text.split(/\.\s/).length === 1 && text.endsWith(".")), true);
  is("no open count anywhere", words.every((text) => !/\bopen(ed|s)?\b/i.test(text)), true);

  done();
}

main();
