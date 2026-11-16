/**
 * The offer past what is left (460 [EL4], unit 2, lib/send-count.ts
 * activeOffer; added 16 November 2026). Checked:
 *
 *   - only for an email past what is left this month, never inside it;
 *   - the widest "Bought in the last" window first, so the fewest people are
 *     left out, then one narrower window at a time while it is still past;
 *   - never a window that the "Has not bought in the last" choice would leave
 *     empty, never one narrower than the narrowest, never a made-up window;
 *   - the composer draws it next to the count line, sets only the existing
 *     choice, opens the choices and moves the focus there on the creator's
 *     own press, and sends nothing by itself.
 */
import { readFileSync } from "node:fs";
import { ACTIVE_DAYS } from "@/lib/segments-rules";
import { activeOffer } from "@/lib/send-count";
import { done, is, part } from "./check";

function main(): void {
  part("Only past what is left");
  is("inside the month there is nothing to offer", activeOffer(false, 0, 0, ACTIVE_DAYS), null);
  is("inside the month, even with a window chosen", activeOffer(false, 90, 0, ACTIVE_DAYS), null);

  part("One window at a time, the widest first");
  is("no window yet: the widest, so the fewest are left out", activeOffer(true, 0, 0, ACTIVE_DAYS), 180);
  is("180 still past: 90", activeOffer(true, 180, 0, ACTIVE_DAYS), 90);
  is("90 still past: 60", activeOffer(true, 90, 0, ACTIVE_DAYS), 60);
  is("60 still past: 30", activeOffer(true, 60, 0, ACTIVE_DAYS), 30);
  is("30 is the narrowest: nothing more to offer", activeOffer(true, 30, 0, ACTIVE_DAYS), null);
  is("a window that is not one of the choices is never stepped from", activeOffer(true, 45, 0, ACTIVE_DAYS), null);
  is("the windows are read in order, whatever order they come in", activeOffer(true, 0, 0, [90, 30, 180, 60]), 180);

  part("Never a window that leaves nobody");
  is("has not bought in the last 90 days: only 180 can still hold anyone", activeOffer(true, 0, 90, ACTIVE_DAYS), 180);
  is("and past that, nothing narrower is offered", activeOffer(true, 180, 90, ACTIVE_DAYS), null);
  is("has not bought in the last 180 days: no window can hold anyone", activeOffer(true, 0, 180, ACTIVE_DAYS), null);
  is("numbers that are not days offer nothing", [activeOffer(true, Number.NaN, 0, ACTIVE_DAYS), activeOffer(true, 0, -1, ACTIVE_DAYS), activeOffer(true, 1.5, 0, ACTIVE_DAYS)], [null, null, null]);

  part("In the composer");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the offer is read from the count line, the chosen window and the quiet days", studio.includes("const offerDays = monthCount?.over ? activeOffer(true, activeDays, quietDays, ACTIVE_DAYS) : null;"), true);
  is("the button names the window it sets", studio.includes("{`Write only to buyers who bought in the last ${offerDays} days`}"), true);
  is("it says who is left out and that the new count comes first", studio.includes("People who never bought from you are left out. You see the new count before anything is sent."), true);
  is("pressing it sets only the existing choice, opens the choices and moves the focus there", studio.includes("onClick={() => { setActiveDays(offerDays); setMore(true); focusActive.current = true; }}"), true);
  is("the focus moves only after the creator pressed it", studio.includes("if (!focusActive.current) return;") && studio.includes('id="mail-active"'), true);
  is("it waits while the composer is busy", /disabled=\{locked\}[^>]*data-active-offer/.test(studio), true);
  is("the button is described by its hint", studio.includes('aria-describedby="mail-active-offer-hint"') && studio.includes('id="mail-active-offer-hint"'), true);
  const lib = readFileSync("lib/send-count.ts", "utf8");
  is("it still asks for nothing and sends nothing", /\bfetch\(|import /.test(lib.replace(/^\s*\*.*$/gm, "")), false);
  done();
}

main();
