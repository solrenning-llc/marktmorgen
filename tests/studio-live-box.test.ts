/**
 * "Who is on your store right now" is drawn from the first paint with the
 * shape it keeps (inbox C4-28). It used to draw nothing until its first
 * answer and then push everything under it down by 221 to 354 pixels, the
 * product editor included, about a second and a half after the studio
 * opened: in WebKit, which has no scroll anchoring, a press on "Add something
 * to sell" landed on a product row instead (WCAG 2.4.3, 3.2.5).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RightNow } from "@/components/stats-panel";
import { readFileSync } from "node:fs";
import { LIVE_ASKS, footnoteWords, hasRested, newLiveBox, readingAnswered, readingFailed, startReading, todayFailedWords, type LiveBox } from "@/lib/live-box-rules";
import { done, is, part } from "./check";

part("Before its first answer, the box is already there, in the shape it keeps");
const html = renderToStaticMarkup(createElement(RightNow, { currency: "usd" }));
is("drawn, and said to be checking", [html.includes("Checking who has opened your store in the last 5 minutes"), html.includes('aria-busy="true"')], [true, true]);
is("with today's four numbers in their places, waiting, read as \"Loading\"", [html.includes("Today so far"), (html.match(/<dd[^>]*><span aria-hidden="true">…<\/span><span class="sr-only">Loading<\/span><\/dd>/g) ?? []).length], [true, 4]);
is("and the lines under them, so the answer fills them in rather than adding them", [html.includes("Reading today&#x27;s numbers.") || html.includes("Reading today's numbers."), html.includes("The day in UTC")], [true, true]);

part("Today left out of an answer is a reading that failed, said with when it is read again (inbox C4-34)");
{
  const source = readFileSync("components/stats-panel.tsx", "utf8");
  const route = readFileSync("app/api/store/live/route.ts", "utf8");
  is("the route leaves today out only when its reading fails", route.includes("readToday(access.store).catch(() => null)"), true);
  const failedBox = readingFailed(startReading(newLiveBox<{ n: number }>(), true)!.box, 1);
  is("the box says it failed on the last try, and when it is read again", todayFailedWords(failedBox), "Today's numbers could not be read on the last try; they are read again in half a minute.");
  is("never \"just now\" with nothing after it", source.includes("Today's numbers could not be read just now."), false);
}

part("The box as a state machine: it rests only when the last reading has come back, and says what is true");
{
  type Box = LiveBox<{ n: number }>;
  const UTC = "UTC";
  const at = Date.UTC(2026, 10, 4, 15, 41);
  const run = (box: Box, ok: boolean, n = 1): Box => {
    const started = startReading(box, true);
    if (!started) throw new Error("no reading started");
    return ok ? readingAnswered(started.box, started.seq, { n }, at) : readingFailed(started.box, started.seq);
  };

  // 20 readings, each answered before the next: it rests only after the 20th has come back.
  let box: Box = newLiveBox();
  const restedAfterStart: boolean[] = [];
  const promisesAfterStart: boolean[] = [];
  for (let i = 1; i <= LIVE_ASKS; i++) {
    const started = startReading(box, true)!;
    restedAfterStart.push(hasRested(started.box));
    promisesAfterStart.push(todayFailedWords(started.box).includes("half a minute"));
    box = readingFailed(started.box, started.seq);
  }
  is("no reading rests while it is still running, not even the 20th", restedAfterStart.some(Boolean), false);
  is("the 20th, running, promises no further one", [promisesAfterStart[LIVE_ASKS - 2], promisesAfterStart[LIVE_ASKS - 1]], [true, false]);
  is("when the 20th comes back the box rests, and says to reload", [hasRested(box), todayFailedWords(box).includes("reload the page"), startReading(box, true)], [true, true, null]);
  is("a hidden tab starts nothing and spends nothing", [startReading(newLiveBox<{ n: number }>(), false), newLiveBox<{ n: number }>().started], [null, 0]);
  is("the rest is said once it comes, never before", [footnoteWords(box).startsWith("Paused after ten minutes"), footnoteWords(run(newLiveBox(), true)).startsWith("Your store page")], [true, true]);

  // A failure after a good reading says the numbers are the last good one's, with its time.
  const stale = run(run(newLiveBox<{ n: number }>(), true, 7), false);
  const staleWords = footnoteWords(stale, UTC);
  is("the numbers are kept, from the last good reading", stale.last?.data.n, 7);
  is("and said to be from its time, with the last try failed", [staleWords.includes("last good reading, at 3:41 PM"), staleWords.includes("last try to read them again failed"), staleWords.includes("updated every half minute")], [true, true, false]);
  is("a good reading after that clears it", footnoteWords(run(stale, true, 8), UTC).startsWith("Your store page"), true);

  // Two readings overlap (a tab coming back to view and the timer): the older answer arriving last is ignored.
  const first = startReading(newLiveBox<{ n: number }>(), true)!;
  const second = startReading(first.box, true)!;
  let both = readingAnswered(second.box, second.seq, { n: 2 }, at);
  both = readingAnswered(both, first.seq, { n: 1 }, at);
  is("the newer answer stays when the older comes after it", both.last?.data.n, 2);
  const failedLate = readingFailed(readingAnswered(second.box, second.seq, { n: 2 }, at), first.seq);
  is("and an older failure does not mark the newer numbers failed", failedLate.failed, false);
  is("both still count as come back", failedLate.finished, 2);
  const source = readFileSync("components/stats-panel.tsx", "utf8");
  is("the component draws everything from the machine", [source.includes("footnoteWords(box)"), source.includes("todayFailedWords(box)"), source.includes("waitingWords(box)")], [true, true, true]);
}

done();
