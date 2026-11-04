/**
 * The focus moved to a field that is about to be drawn (lib/focus-when-drawn.ts;
 * queue item 375 [TB1]). Seen once in a browser: after adding a heading to a
 * row, the focus stayed on the Add button, because the new field was not yet
 * there when the focus was asked for, and the request was dropped; a typed
 * space then added a second heading. Driven here with frames of its own.
 *
 * Not checked here (needs a browser): the real frames and the real fields.
 */
import { done, is, part } from "./check";
import { FOCUS_FRAMES, type Frames, focusWhenDrawn } from "@/lib/focus-when-drawn";

/** Frames run by hand: `step()` runs the one waiting, as the browser does at its next frame. */
function handFrames() {
  let waiting: { handle: number; step: () => void } | null = null;
  let next = 1;
  let asked = 0;
  const frames: Frames = {
    request: (step) => {
      asked += 1;
      waiting = { handle: next++, step };
      return waiting.handle;
    },
    cancel: (handle) => {
      if (waiting?.handle === handle) waiting = null;
    },
  };
  return {
    frames,
    step: () => {
      const now = waiting;
      waiting = null;
      now?.step();
    },
    waiting: () => waiting !== null,
    asked: () => asked,
  };
}

function field() {
  const target = { focused: 0, focus: () => (target.focused += 1) };
  return target;
}

part("Already drawn: focused at once, no frame asked for");
{
  const hand = handFrames();
  const target = field();
  focusWhenDrawn(() => target, hand.frames);
  is("focused once", target.focused, 1);
  is("no frame waited for", [hand.asked(), hand.waiting()], [0, false]);
}

part("Drawn a few frames later: focused then, and only then");
{
  const hand = handFrames();
  const target = field();
  let drawn = false;
  focusWhenDrawn(() => (drawn ? target : null), hand.frames);
  is("not focused while it is not there", target.focused, 0);
  hand.step();
  hand.step();
  is("still waiting, two frames on", [target.focused, hand.waiting()], [0, true]);
  drawn = true;
  hand.step();
  is("focused at the frame it is drawn", target.focused, 1);
  is("and nothing waits after that", hand.waiting(), false);
}

part("Never drawn: it gives up, so it can never take the focus long after");
{
  const hand = handFrames();
  focusWhenDrawn(() => null, hand.frames);
  let frames = 0;
  while (hand.waiting() && frames < 1000) {
    hand.step();
    frames += 1;
  }
  is("it stops after its frames", frames, FOCUS_FRAMES);
  is("about half a second at 60 frames a second", FOCUS_FRAMES, 30);
}

part("Stopped (a newer change, or the editor closed): nothing is focused later");
{
  const hand = handFrames();
  const target = field();
  let drawn = false;
  const stop = focusWhenDrawn(() => (drawn ? target : null), hand.frames);
  stop();
  drawn = true;
  hand.step();
  is("the waiting frame was canceled", [hand.waiting(), target.focused], [false, 0]);
  stop();
  is("stopping twice does nothing", target.focused, 0);
}

done();
