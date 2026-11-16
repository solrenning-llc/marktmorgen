/**
 * Independent review of PR #2554 at 6c8f7c55: singular and plural in the
 * closing notice's new sentences (lib/plan-closing.ts, closingLetter). Each
 * check fails on that head and states what should hold instead.
 */
import { closingLetter } from "@/lib/plan-closing";
import { done, is, part } from "./check";

const DAY = 24 * 60 * 60 * 1000;

function main(): void {
  const now = Date.now();
  const endedAt = now - 2 * DAY;
  const day = endedAt + 30 * DAY;
  const letterOf = (news: Parameters<typeof closingLetter>[5]) => closingLetter("ended", "Rita Shop", endedAt, day, now, news).text;

  part("One member past the day is not 'each of them'");
  {
    const text = letterOf({ buyersBy: null, untold: 0, members: 1, unused: "$15", notHeld: 0, overLimit: 0 });
    is("with 1 member, the refund sentence is in the singular", [text.includes("1 member has paid for time after"), text.includes("each of them")], [true, false]);
  }

  part("One membership not paused is not 'these members'");
  {
    const text = letterOf({ buyersBy: null, untold: 0, members: 0, unused: "", notHeld: 1, overLimit: 0 });
    is("with 1 membership not paused, the refund sentence is in the singular", [text.includes("1 membership's payments are not paused"), text.includes("these members"), text.includes("each of them")], [true, false, false]);
  }

  done();
}

main();
