/**
 * The rules of the sweep of pictures attached to nothing (507 [SG3], unit 3;
 * security finding MM-SA-08): a notice first, the sweep only after it, and
 * nothing at all when any reading is unknown (rule 24). Pure, off, synthetic.
 */
import { MAX_SWEEP_PER_RUN, NOTICE_DAYS, PICTURE_SWEEP_ON, UNATTACHED_DAYS, sweepPlan } from "@/lib/picture-sweep-rules";
import { done, is, part } from "./check";

const DAY = 86_400;
const now = 1_800_000_000;
const old = now - (UNATTACHED_DAYS + 1) * DAY;
const pic = (name: string, addedAt = old) => ({ path: `images/abc123/${name}.webp`, addedAt });

part("Off");
is("the sweep is off until the owner confirms it", PICTURE_SWEEP_ON, false);
is("a notice waits at least two weeks before a sweep", NOTICE_DAYS >= 14, true);
is("a picture is attached to nothing at least a month before a notice", UNATTACHED_DAYS >= 30, true);

part("Unknown is never a sweep (rule 24)");
for (const [what, args] of [
  ["the pictures", ["unknown", new Set<string>(), new Map<string, number>()]],
  ["what is in use", [[pic("a")], "unknown", new Map<string, number>()]],
  ["the notices", [[pic("a")], new Set<string>(), "unknown"]],
] as const) {
  is(`${what} unknown: no notice, no sweep`, sweepPlan(args[0] as never, args[1] as never, args[2] as never, now), "unknown");
}

part("In use is kept");
const used = new Set([pic("a").path]);
const kept = sweepPlan([pic("a")], used, new Map([[pic("a").path, now - 30 * DAY]]), now);
is("a picture in use is never noticed nor swept, even with an old notice", kept !== "unknown" && [kept.notice.length, kept.sweep.length], [0, 0]);
is("its old notice is dropped, so a later notice starts the wait again", kept !== "unknown" && kept.clearNotice, [pic("a").path]);

part("Attached to nothing");
const young = sweepPlan([pic("b", now - (UNATTACHED_DAYS - 1) * DAY)], new Set(), new Map(), now);
is("younger than the wait: kept, no notice", young !== "unknown" && [young.notice, young.sweep], [[], []]);
const due = sweepPlan([pic("c")], new Set(), new Map(), now);
is("past the wait with no notice: a notice, no sweep", due !== "unknown" && [due.notice, due.sweep], [[pic("c").path], []]);
const waiting = sweepPlan([pic("d")], new Set(), new Map([[pic("d").path, now - (NOTICE_DAYS - 1) * DAY]]), now);
is("noticed, inside the notice's wait: kept", waiting !== "unknown" && [waiting.notice, waiting.sweep], [[], []]);
const swept = sweepPlan([pic("e")], new Set(), new Map([[pic("e").path, now - NOTICE_DAYS * DAY]]), now);
is("noticed, the notice's wait over: swept", swept !== "unknown" && swept.sweep, [pic("e").path]);

part("An age or a notice that cannot be read keeps the picture");
for (const [what, addedAt] of [["no number", Number.NaN], ["in the future", now + DAY], ["negative", -1]] as const) {
  const plan = sweepPlan([pic("f", addedAt)], new Set(), new Map(), now);
  is(`its added time is ${what}: kept, no notice`, plan !== "unknown" && [plan.notice, plan.sweep], [[], []]);
}
const badNotice = sweepPlan([pic("g")], new Set(), new Map([[pic("g").path, now + DAY]]), now);
is("a notice dated in the future: kept, never swept", badNotice !== "unknown" && badNotice.sweep, []);

part("Only a picture's own place");
for (const path of ["stores/abc123/file.pdf", "images/abc123/../x.webp", "images/abc123/sub/x.webp", "images//x.webp", "vault/abc123/x.webp", "images/abc123/"]) {
  const plan = sweepPlan([{ path, addedAt: old }], new Set(), new Map([[path, now - 30 * DAY]]), now);
  is(`${path}: never noticed nor swept`, plan !== "unknown" && [plan.notice, plan.sweep], [[], []]);
}

part("A bounded run");
const many = Array.from({ length: MAX_SWEEP_PER_RUN + 5 }, (_, i) => pic(`m${i}`));
const notices = new Map(many.map((p) => [p.path, now - 30 * DAY] as const));
const big = sweepPlan(many, new Set(), notices, now);
is("at most MAX_SWEEP_PER_RUN swept in one run; the rest wait for the next", big !== "unknown" && big.sweep.length, MAX_SWEEP_PER_RUN);
const bigNotice = sweepPlan(many, new Set(), new Map(), now);
is("at most MAX_SWEEP_PER_RUN noticed in one run", bigNotice !== "unknown" && bigNotice.notice.length, MAX_SWEEP_PER_RUN);
const twice = sweepPlan([pic("t"), pic("t")], new Set(), new Map([[pic("t").path, now - 30 * DAY]]), now);
is("a picture listed twice is swept once", twice !== "unknown" && twice.sweep, [pic("t").path]);

part("Readings that disagree keep the picture (independent review)");
const dup = sweepPlan([pic("u"), pic("u", now - DAY)], new Set(), new Map([[pic("u").path, now - 30 * DAY]]), now);
is("a picture listed twice with different added times is kept, never swept by the older one", dup !== "unknown" && [dup.notice, dup.sweep], [[], []]);
const zero = sweepPlan([pic("z")], new Set(), new Map([[pic("z").path, 0]]), now);
is("a notice at time 0 (a missing notice read as 0) is not a notice: never swept", zero !== "unknown" && zero.sweep, []);

done();
