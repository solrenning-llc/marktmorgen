/**
 * When a studio editor may save by itself (487 [IT4], pattern 6, unit 1,
 * lib/autosave-rules.ts; added 1 November 2026). Checked:
 *
 *   - only where saving changes nothing anyone else sees and loses nothing,
 *     on a store that pays, for a draft inside a studio request's price;
 *   - only after the typing stops, at most once a minute and 60 times while
 *     one editor is open, run on a virtual clock for an hour of typing;
 *   - never past its own share of the window, counted on the server, and
 *     never while that count cannot be read;
 *   - every input that is not a plain figure stops it;
 *   - a draft its route refused is not tried again until it changes;
 *   - the words beside Save never say saved while something is not.
 */
import { readFileSync } from "node:fs";
import { AUTOSAVE_GAP_MS, AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_BYTES, AUTOSAVE_PER_OPEN, AUTOSAVE_SHARE, autosaveDecision, autosaveWords, type AutosaveInput } from "@/lib/autosave-rules";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 1, 15, 4);
const base: AutosaveInput = { dirty: true, saving: false, valid: true, private: true, paying: true, bytes: 3_000, refused: false, now: NOW, changedAt: NOW - 5_000, autosavedAt: 0, autosaves: 0, window: { figure: 2_000, autosaved: 0 } };
const at = (over: Partial<AutosaveInput>) => autosaveDecision({ ...base, ...over });

part("Only where saving loses nothing and costs what is priced");
is("a hidden draft on a paying store: save", at({}), { act: "save" });
is("a save that puts it live, moves versions, deletes a file or restarts a test: never", at({ private: false }), { act: "off", why: "private" });
is("a store that does not pay (trial, no plan, ended): never", at({ paying: false }), { act: "off", why: "paying" });
is(`a draft over ${AUTOSAVE_MAX_BYTES} bytes, past a studio request's priced shape: never`, [at({ bytes: AUTOSAVE_MAX_BYTES }).act, at({ bytes: AUTOSAVE_MAX_BYTES + 1 }), at({ bytes: Number.NaN })], ["save", { act: "off", why: "big" }, { act: "off", why: "big" }]);
const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
is("the priced shape it stays inside: twenty commands and fifty kilobytes a studio request", registry.includes('studio: request("studio", 20 + TAKE_COMMANDS, 50_000)') && AUTOSAVE_MAX_BYTES * 2 <= 50_000, true);

part("An hour of typing, on a virtual clock");
{
  let clock = NOW;
  let autosavedAt = 0;
  let autosaves = 0;
  let changedAt = NOW;
  const starts: number[] = [];
  const quiet: number[] = [];
  // A key every 1.5 seconds and a 5-second pause every 30 seconds, for an hour.
  for (let t = 0; t <= 3_600_000; t += 500) {
    clock = NOW + t;
    if (t % 30_000 < 25_000 && t % 1_500 === 0) changedAt = clock;
    const decision = autosaveDecision({ ...base, now: clock, changedAt, autosavedAt, autosaves, window: { figure: 2_000, autosaved: autosaves } });
    if (decision.act === "save") {
      starts.push(clock);
      quiet.push(clock - changedAt);
      autosavedAt = clock;
      autosaves += 1;
    }
  }
  const gaps = starts.slice(1).map((s, i) => s - starts[i]);
  is("at most 60, and never two within a minute", [starts.length <= AUTOSAVE_PER_OPEN, gaps.every((g) => g >= AUTOSAVE_GAP_MS), starts.length > 0], [true, true, true]);
  is("each one after the typing had stopped for 4 seconds", quiet.every((q) => q >= AUTOSAVE_IDLE_MS), true);
}
is("still typing: wait until it stops", at({ changedAt: NOW - 1_000 }), { act: "wait", until: NOW - 1_000 + AUTOSAVE_IDLE_MS });
is("a try 20 seconds ago: wait for the minute", at({ autosavedAt: NOW - 20_000 }), { act: "wait", until: NOW - 20_000 + AUTOSAVE_GAP_MS });
is("the 61st while one editor is open: never", at({ autosaves: AUTOSAVE_PER_OPEN }), { act: "off", why: "many" });

part("Its own share of the window, counted on the server");
for (const tier of ["creator", "pro", "scale"] as const) {
  const figure = STORE_ALLOWANCES[tier].studio;
  const share = Math.floor(figure * AUTOSAVE_SHARE);
  is(`${tier}: up to ${share} of ${figure}, then never`, [at({ window: { figure, autosaved: share - 1 } }).act, at({ window: { figure, autosaved: share } })], ["save", { act: "off", why: "share" }]);
}
is("the count could not be read (it is not kept yet): never", at({ window: null }), { act: "off", why: "unknown" });

part("Unknown is never room");
for (const [what, over] of [
  ["now not a number", { now: Number.NaN }],
  ["a change in the future", { changedAt: NOW + 60_000 }],
  ["a try in the future", { autosavedAt: NOW + 1 }],
  ["a try time not a number", { autosavedAt: Number.NaN }],
  ["a negative count of tries", { autosaves: -1 }],
  ["a count of tries not a number", { autosaves: Number.NaN }],
  ["more used than the figure", { window: { figure: 2_000, autosaved: 2_001 } }],
  ["no figure", { window: { figure: 0, autosaved: 0 } }],
] as const) {
  is(`${what}: never`, at(over as Partial<AutosaveInput>), { act: "off", why: "unknown" });
}

part("Never when it should not");
is("nothing unsaved", at({ dirty: false }), { act: "idle" });
is("another save on its way", at({ saving: true }), { act: "idle" });
is("a draft its route refused, until it changes", at({ refused: true }), { act: "off", why: "refused" });
is("a draft that cannot be saved: said last, so it never promises a save something else stops", [at({ valid: false }), at({ valid: false, window: null })], [{ act: "off", why: "invalid" }, { act: "off", why: "unknown" }]);
const code = readFileSync("lib/autosave-rules.ts", "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
is("it imports nothing, writes nothing and asks nothing", [/^import /m.test(code), /fetch\(|redis|localStorage|sendBeacon|XMLHttpRequest/.test(code)], [false, false]);

part("The words beside Save");
is("saving", autosaveWords({ saving: true, savedAt: null, off: null, dirty: true }), "Saving…");
is("saved, with the time", autosaveWords({ saving: false, savedAt: NOW, off: null, dirty: false }).startsWith("Saved at "), true);
is("waiting to save by itself", autosaveWords({ saving: false, savedAt: NOW, off: { act: "wait", until: NOW + 1 }, dirty: true }), "Not saved yet.");
is("not saving by itself here: press Save", autosaveWords({ saving: false, savedAt: null, off: { act: "off", why: "share" }, dirty: true }), "Not saved yet: press Save.");
is("refused: see what to change", autosaveWords({ saving: false, savedAt: null, off: { act: "off", why: "refused" }, dirty: true }), "Not saved: see what to change, then press Save.");
is("nothing unsaved: nothing to warn about", autosaveWords({ saving: false, savedAt: null, off: { act: "off", why: "unknown" }, dirty: false }), "");
is("never saved while something is not", ["share", "many", "unknown", "private", "paying", "big", "invalid", "refused"].every((why) => autosaveWords({ saving: false, savedAt: NOW, off: { act: "off", why: why as never }, dirty: true }).startsWith("Not saved")), true);
done();
