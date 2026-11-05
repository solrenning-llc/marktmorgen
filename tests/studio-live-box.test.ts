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
import { LIVE_ASKS, LIVE_TIMEOUT_MS, footnoteWords, hasRested, newLiveBox, readingAnswered, readingFailed, startReading, todayFailedWords, type LiveBox } from "@/lib/live-box-rules";
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
  is("and said to be from its time, with the last try failed", [staleWords.includes("last good reading, at 3:41 PM your time"), staleWords.includes("last try to read them again failed"), staleWords.includes("updated every half minute")], [true, true, false]);
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

  // A reading that never comes back (reading 1 stays out, 2 to 20 are answered): the box still rests.
  {
    let b: Box = newLiveBox();
    const one = startReading(b, true)!;
    b = one.box;
    for (let i = 2; i <= LIVE_ASKS; i++) {
      const st = startReading(b, true)!;
      b = readingAnswered(st.box, st.seq, { n: i }, at);
    }
    is("with reading 1 never back, after the 20th it rests and has no next reading", [b.started, b.finished, hasRested(b), startReading(b, true)], [LIVE_ASKS, LIVE_ASKS - 1, true, null]);
    is("and never says it updates every half minute", footnoteWords(b, UTC).includes("every half minute"), false);
  }
  is("a reading is given up after ten seconds at most", LIVE_TIMEOUT_MS <= 10_000, true);

  type Live = LiveBox<{ visitors: number; sources: { source: string; visitors: number }[]; today: null }>;
  const reading = (visitors: number) => ({ visitors, sources: [], today: null });
  const good = (visitors: number): Live => {
    const st = startReading(newLiveBox<ReturnType<typeof reading>>(), true)!;
    return readingAnswered(st.box, st.seq, reading(visitors), at);
  };
  const drawn = (b: Live, now = at) => renderToStaticMarkup(createElement(RightNow, { currency: "usd", initialBox: b, timeZone: UTC, now }));
  const rested = (b: Live): Live => ({ ...b, started: LIVE_ASKS, finished: LIVE_ASKS });
  part("The box as drawn, in the states the machine reaches");
  {
    const pending = drawn(startReading(newLiveBox<ReturnType<typeof reading>>(), true)!.box);
    is("a reading out and nothing yet: checking, busy", [pending.includes("Checking who has opened"), pending.includes('aria-busy="true"')], [true, true]);
    const fresh = drawn(good(3));
    is("a fresh good reading: the count, no time, no as-of", [fresh.includes("3 people have opened your store in the last 5 minutes; today&#x27;s numbers could not be read<") || fresh.includes("3 people have opened your store in the last 5 minutes; today's numbers could not be read<"), fresh.includes("as of")], [true, false]);
    const failedAfter = drawn(readingFailed(startReading(good(3), true)!.box, 2));
    is("a failure after a good one: the count with its time, your time", [failedAfter.includes("last 5 minutes, as of 3:41 PM your time"), failedAfter.includes("last try to read them again failed")], [true, true]);
    const old = drawn(rested(good(3)));
    is("resting after a good reading: the count is said with its time", [old.includes("last 5 minutes, as of 3:41 PM your time"), old.includes("Paused after ten minutes")], [true, true]);
    is("the status sentence says why, once: failed, then paused", [failedAfter.includes("as of 3:41 PM your time; the last try failed, and it is tried again in half a minute"), old.includes("as of 3:41 PM your time; paused, reload the page to read again")], [true, true]);
    const back = drawn(good(3), at + 45_000);
    is("numbers older than one interval are said with their time, even before the new reading comes", [back.includes("last 5 minutes, as of 3:41 PM your time"), drawn(good(3), at + 10_000).includes("as of")], [true, false]);
    is("only the status sentence is a live region", (old.match(/aria-live/g) ?? []).length, 1);
    is("and the time in it is not read twice by it", (old.match(/<p[^>]*aria-live[^>]*>.*?<\/p>/)?.[0].match(/3:41 PM/g) ?? []).length, 1);
  }
  // Out of order, the other way: a failure of reading 20 comes first, then the good answer of 19.
  {
    let b: Box = newLiveBox();
    const seqs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const st = startReading(b, true)!;
      b = st.box;
      seqs.push(st.seq);
    }
    b = readingFailed(b, 20);
    b = readingAnswered(b, 19, { n: 19 }, at + 60_000);
    is("an older good answer after a newer failure is shown, with the failure said", [b.last?.data.n, b.failed], [19, true]);
    b = readingAnswered(b, 18, { n: 18 }, at + 90_000);
    is("but not when an even newer good answer is already there", b.last?.data.n, 19);
    b = readingAnswered(b, 20, { n: 20 }, at + 120_000);
    is("and a newer good one after clears the failure", [b.last?.data.n, b.failed], [20, false]);
  }
  const source = readFileSync("components/stats-panel.tsx", "utf8");
  is("the component draws everything from the machine", [source.includes("footnoteWords(box"), source.includes("todayFailedWords(box)"), source.includes("headlineWords(box")], [true, true, true]);
}

done();
