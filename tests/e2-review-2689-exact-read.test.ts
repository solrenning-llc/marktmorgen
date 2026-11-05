import { parseNotes } from "@/lib/stats-notes";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { done, is, part } from "./check";

const stored = JSON.stringify({ day: "2026-11-04", text: "Published the course" });

function refused(raw: unknown): boolean {
  try {
    parseNotes(raw);
    return false;
  } catch {
    return true;
  }
}

part("Malformed stored JSON never becomes a confirmed chart-note record");
is(
  "a valid stored note remains readable",
  parseNotes(["00000001", stored]),
  [{ id: "00000001", day: "2026-11-04", text: "Published the course" }],
);
is(
  "conflicting duplicate day members are refused before JSON normalization",
  refused(["00000001", '{"day":"2026-11-04","day":"2020-01-01","text":"Published the course"}']),
  true,
);
is(
  "conflicting duplicate text members are refused before JSON normalization",
  refused(["00000001", '{"day":"2026-11-04","text":"Changed","text":"Published the course"}']),
  true,
);

part("An executable Redis array is unknown without running its traps");
let traps = 0;
const executable = new Proxy(["00000001", stored], {
  get(target, property, receiver) {
    traps++;
    return Reflect.get(target, property, receiver);
  },
  getOwnPropertyDescriptor(target, property) {
    traps++;
    return Reflect.getOwnPropertyDescriptor(target, property);
  },
});
is("a proxied reply is refused", refused(executable), true);
is("no proxy trap executes", traps, 0);

part("An unknown chart-note history remains unknown in the studio");
const studio = readFileSync(resolve(process.cwd(), "app/studio/page.tsx"), "utf8");
is(
  "a failed chart-note read is not presented as a confirmed empty list",
  studio.includes("readNotes(current.statsId).catch(() => [])"),
  false,
);

done();
