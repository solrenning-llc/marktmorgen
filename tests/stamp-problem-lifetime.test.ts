/**
 * A file's problem note (nl:stamp:problem:) is priced for as long as it can live (Claude 5 ygH4 on #5360). A first
 * preview failure writes a once-note for 60 days; a second failure before it runs out writes "unreadable" for 60 days
 * more, so one path's note can live up to twice the note's own time. The stamp's own problem note is kept the same 60
 * days. The data registry's part and the key's closing rule must both cover that longest life, tied to the constants,
 * never a number typed beside them. Pure reading of the registries; no network, no Redis.
 */
import * as rules from "@/lib/stamp-cost-rules";
import { closingOf } from "@/lib/data-families";
import { FAMILIES } from "./store-data-registry";
import { done, is, part } from "./check";

const DAY = 86_400;
const r = rules as { PROBLEM_NOTE_SECONDS?: number; PROBLEM_NOTE_LONGEST_DAYS?: number };

part("The longest life of a path's problem note is named, from the note's own time");
is("the note's time is named once (PROBLEM_NOTE_SECONDS, 60 days)", r.PROBLEM_NOTE_SECONDS, 60 * DAY);
is("its longest life is a once-note then an unreadable note, each that time", r.PROBLEM_NOTE_LONGEST_DAYS, (2 * (r.PROBLEM_NOTE_SECONDS ?? 0)) / DAY);

part("The data registry and the closing rule cover that longest life");
const family = FAMILIES["nl:stamp:problem:@lib/pdf-stamp.ts"];
const days = family?.parts.map((p) => ("days" in p ? Number((p as { days: number }).days) : 0)) ?? [];
is("the registry prices the note per file for at least its longest life", days.length > 0 && days.every((d) => d >= (r.PROBLEM_NOTE_LONGEST_DAYS ?? Infinity)), true);
const closing = closingOf("nl:stamp:problem:stores/abc/file.pdf");
is("the key's closing rule says it expires within at least its longest life",
  closing?.how === "expires" && (closing as { days: number }).days >= (r.PROBLEM_NOTE_LONGEST_DAYS ?? Infinity), true);

done();
